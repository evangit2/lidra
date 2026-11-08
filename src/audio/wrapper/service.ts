/**
 * Supervises the FairPlay wrapper as a child process.
 *
 * The wrapper is the only route to lossless and Atmos: it holds Apple's own
 * FairPlay machinery and answers two local sockets — ciphertext in / plaintext
 * out on the decrypt port, and the device's own playlist on the manifest port.
 * Lidra starts it, waits for both ports, restarts it if it dies, and stops it
 * when the app quits.
 *
 * Lidra never touches Apple credentials here: the wrapper keeps its own login in
 * its data directory, so signing in stays a one-time step outside the pipeline.
 */
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import log from "electron-log/main";

const wrapperLog = log.scope("audio.wrapper");

export type WrapperState = "stopped" | "starting" | "running" | "error";

export interface WrapperStatus {
  state: WrapperState;
  /** Decrypt socket the pipeline will use, when known. */
  decryptor: string;
  /** Manifest socket, when known. */
  manifest: string;
  pid: number | null;
  /** Last line of interest from the wrapper's output. */
  detail: string;
}

export interface WrapperServiceOptions {
  /** Command line to start, e.g. `~/.lidra-wrapper/wrapper -D 10020 -M 20020`. */
  command: string;
  /** `host:port` of the decrypt socket. */
  decryptor: string;
  /** `host:port` of the manifest socket. Empty when not used. */
  manifest: string;
  /** Spawn implementation, injectable for tests. */
  spawnImpl?: typeof spawn;
  /**
   * Build the one-shot login line. A plain command appends `-L …`, but a
   * Windows launch wraps everything in `wsl … sh -c '…'`, where appended
   * arguments would land outside the script.
   */
  composeLogin?: (base: string, credentials: string) => string;
  /** TCP probe, injectable for tests. */
  probe?: (address: string) => Promise<boolean>;
  /** Called whenever the state changes. */
  onChange?: (status: WrapperStatus) => void;
  /** Called once per start when the login blocks on a 2FA code. */
  onNeedsCode?: () => void;
  /** How long to wait for the decrypt socket before giving up. */
  startTimeoutMs?: number;
  /**
   * Look for a free port pair instead of insisting on the configured one.
   * Disabled by tests that pin the address.
   */
  portScan?: boolean;
}

/** Resolve `~` and environment variables in a user-supplied command line. */
export function expandCommand(command: string, home: string): string {
  return command.replace(/^~(?=$|\/)/, home).replace(/\$\{?HOME\}?/g, home);
}

function splitAddress(address: string): { host: string; port: number } | null {
  const trimmed = address.trim();
  if (!trimmed) return null;
  const colon = trimmed.lastIndexOf(":");
  if (colon === -1) return null;
  const port = Number.parseInt(trimmed.slice(colon + 1), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: trimmed.slice(0, colon) || "127.0.0.1", port };
}

/** True when something accepts connections on `host:port`. */
export function probeTcp(address: string, timeoutMs = 700): Promise<boolean> {
  const parsed = splitAddress(address);
  if (!parsed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: parsed.host, port: parsed.port });
    const done = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** Is something already accepting connections on this address? */
export function isListening(address: string, timeoutMs = 400): Promise<boolean> {
  const colon = address.lastIndexOf(":");
  if (colon === -1) return Promise.resolve(false);
  const host = address.slice(0, colon) || "127.0.0.1";
  const port = Number.parseInt(address.slice(colon + 1), 10);
  if (!Number.isFinite(port)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Point a wrapper command at a specific port pair.
 *
 * A wrapper started by an earlier run can still be holding the configured ports
 * (it runs as root, so the app cannot reap it), and the binary binds with
 * SO_REUSEPORT: a second instance on the same port silently takes half the
 * connections, half of which then decrypt with the wrong key context. Moving to
 * a free pair keeps every process honest.
 */
export function retargetCommand(command: string, decryptPort: number, manifestPort: number): string {
  return command
    .replace(/(\s-D\s+)\d+/g, `$1${decryptPort}`)
    .replace(/(\s-M\s+)\d+/g, `$1${manifestPort}`);
}

export class WrapperService {
  private child: ChildProcess | null = null;
  private state: WrapperState = "stopped";
  private detail = "";
  /** One prompt per run, not one per line of wrapper output. */
  private codePrompted = false;
  /** Command used for the one-shot login run, when one is in flight. */
  private loginOverride: string | null = null;
  /**
   * The login command that last worked. The wrapper's key context is pinned per
   * process, so recovering from a stale context means starting a fresh process —
   * and a fresh process only has keys if it logs in the same way.
   */
  private lastLoginCommand: string | null = null;
  /** Forces the next start to launch a new process instead of adopting one. */
  private forceFresh = false;
  /** Addresses the running process actually bound (ports can move). */
  private active: { decryptor: string; manifest: string } | null = null;
  /** Longer deadline while an interactive login runs (auth + lease). */
  private loginTimeoutMs: number | null = null;
  private readonly options: Required<Pick<WrapperServiceOptions, "command" | "decryptor" | "manifest">> &
    WrapperServiceOptions;

  constructor(options: WrapperServiceOptions) {
    this.options = { ...options };
  }

  status(): WrapperStatus {
    return {
      state: this.state,
      decryptor: this.active?.decryptor ?? this.options.decryptor,
      manifest: this.active?.manifest ?? this.options.manifest,
      pid: this.child?.pid ?? null,
      detail: this.detail,
    };
  }

  private setState(state: WrapperState, detail?: string): void {
    this.state = state;
    if (detail !== undefined) this.detail = detail;
    this.options.onChange?.(this.status());
  }

  /** Start the wrapper if it is not already serving its sockets. */
  async start(): Promise<WrapperStatus> {
    const command = (this.loginOverride ?? this.lastLoginCommand ?? this.options.command).trim();
    if (!command) {
      this.setState("error", "no wrapper command configured");
      return this.status();
    }
    if (this.child && this.state === "running") return this.status();

    // A wrapper started by an earlier Lidra run keeps serving: it runs as root,
    // so the app cannot reap it and does not need to. Adopt it instead of
    // starting a second process on the same port, which SO_REUSEPORT would let
    // silently take half the connections with a different key context.
    if (!this.forceFresh && this.options.portScan !== false && (await isListening(this.options.decryptor))) {
      this.active = {
        decryptor: this.options.decryptor,
        manifest: this.options.manifest,
      };
      this.setState("running", "adopted a running wrapper");
      wrapperLog.info(`adopted the wrapper already serving ${this.options.decryptor}`);
      return this.status();
    }

    this.codePrompted = false;
    this.setState("starting", "launching");

    // Take a free port pair: an orphaned wrapper from an earlier run may still
    // own the configured one, and sharing it silently corrupts decrypts.
    let launch = command;
    this.active = {
      decryptor: this.options.decryptor,
      manifest: this.options.manifest,
    };
    const configured = this.options.decryptor;
    const colon = configured.lastIndexOf(":");
    const host = colon === -1 ? "127.0.0.1" : configured.slice(0, colon) || "127.0.0.1";
    const basePort = colon === -1 ? 10020 : Number.parseInt(configured.slice(colon + 1), 10);
    if (Number.isFinite(basePort) && this.options.portScan !== false) {
      for (let offset = 0; offset <= 20; offset += 1) {
        const decryptPort = basePort + offset;
        const manifestPort = basePort + 10_000 + offset;
        const busy =
          (await isListening(`${host}:${decryptPort}`)) ||
          (await isListening(`${host}:${manifestPort}`));
        if (busy) continue;
        launch = retargetCommand(command, decryptPort, manifestPort);
        this.active = {
          decryptor: `${host}:${decryptPort}`,
          manifest: `${host}:${manifestPort}`,
        };
        break;
      }
    }
    wrapperLog.info(`wrapper ports ${this.active.decryptor} / ${this.active.manifest}`);

    const spawnImpl = this.options.spawnImpl ?? spawn;
    let child: ChildProcess;
    try {
      child = spawnImpl(launch, {
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? "" },
      });
    } catch (error) {
      this.setState("error", error instanceof Error ? error.message : String(error));
      return this.status();
    }
    this.child = child;

    const note = (chunk: Buffer): void => {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.detail = trimmed.slice(0, 200);
        if (/2fa|two-factor|verification code/i.test(trimmed)) {
          if (!this.codePrompted) {
            this.codePrompted = true;
            this.options.onNeedsCode?.();
          }
          // The wrapper blocks until the code is written to its rootfs; say so in
          // the log so the app can prompt instead of stalling silently.
          wrapperLog.warn(`wrapper needs a 2FA code: ${trimmed.slice(0, 120)}`);
        } else if (/listening|ready/i.test(trimmed)) {
          wrapperLog.info(`wrapper: ${trimmed}`);
        }
      }
    };
    child.stdout?.on("data", note);
    child.stderr?.on("data", note);
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.state !== "stopped") {
        this.setState(code === 0 ? "stopped" : "error", `exited ${code ?? signal ?? "?"}`);
      }
    });

    const probe = this.options.probe ?? ((address: string) => probeTcp(address));
    const deadline =
      Date.now() +
      (this.loginTimeoutMs ?? this.options.startTimeoutMs ?? 20_000);
    while (Date.now() < deadline) {
      if (!this.child) break;
      if (await probe(this.options.decryptor)) {
        this.setState("running", "decrypt socket open");
        wrapperLog.info(`wrapper ready on ${this.options.decryptor}`);
        return this.status();
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (this.child) this.setState("error", `no socket on ${this.options.decryptor}`);
    return this.status();
  }

  /**
   * Run the wrapper's one-shot Apple ID login, then serve.
   *
   * The wrapper authenticates once against Apple's store services and caches the
   * session in its own data directory; later starts do not need credentials. That
   * cached app session is what FairPlay keys are issued against — a web
   * media-user-token cannot stand in for it.
   */
  /** Replace the launch line, e.g. once the Windows runtime has been prepared. */
  setCommand(command: string): void {
    this.options.command = command;
    if (this.state !== "running") this.detail = "";
  }

  async startWithLogin(email: string, password: string): Promise<WrapperStatus> {
    const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
    const loginCommand = this.options.composeLogin
      ? this.options.composeLogin(this.options.command, `${email}:${password}`)
      : `${this.options.command} -L ${quote(`${email}:${password}`)} -F`;
    this.loginOverride = loginCommand;
    this.lastLoginCommand = loginCommand;
    // A sign-in must take effect: never hand back an already-running process
    // whose context was derived from someone else's session.
    this.forceFresh = true;
    // Signing in reaches Apple before any socket opens, so allow for it.
    this.loginTimeoutMs = 120_000;
    try {
      return await this.start();
    } finally {
      this.loginOverride = null;
      this.loginTimeoutMs = null;
      this.forceFresh = false;
    }
  }

  /**
   * Replace the running wrapper with a fresh one.
   *
   * Used when the decryptor's key context no longer matches the song: a new
   * process re-derives it from the key the playlist names.
   */
  async restart(): Promise<WrapperStatus> {
    if (!this.lastLoginCommand) {
      throw new Error("no wrapper sign-in available to restart with");
    }
    // A restart exists to get a different key context, so never hand back the
    // process we just asked to stop (it may still be holding the port).
    this.forceFresh = true;
    this.stop();
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      return await this.start();
    } finally {
      this.forceFresh = false;
    }
  }

  /** Stop the wrapper if Lidra started it. */
  stop(): void {
    const child = this.child;
    if (!child) {
      this.setState("stopped");
      return;
    }
    this.child = null;
    this.setState("stopped", "stopped by Lidra");
    try {
      child.kill("SIGTERM");
    } catch (error) {
      wrapperLog.warn(
        `could not stop the wrapper: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
