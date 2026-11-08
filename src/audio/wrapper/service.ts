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
  /** TCP probe, injectable for tests. */
  probe?: (address: string) => Promise<boolean>;
  /** Called whenever the state changes. */
  onChange?: (status: WrapperStatus) => void;
  /** How long to wait for the decrypt socket before giving up. */
  startTimeoutMs?: number;
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

export class WrapperService {
  private child: ChildProcess | null = null;
  private state: WrapperState = "stopped";
  private detail = "";
  /** Command used for the one-shot login run, when one is in flight. */
  private loginOverride: string | null = null;
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
      decryptor: this.options.decryptor,
      manifest: this.options.manifest,
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
    const command = (this.loginOverride ?? this.options.command).trim();
    if (!command) {
      this.setState("error", "no wrapper command configured");
      return this.status();
    }
    if (this.child && this.state === "running") return this.status();

    this.setState("starting", "launching");
    const spawnImpl = this.options.spawnImpl ?? spawn;
    let child: ChildProcess;
    try {
      child = spawnImpl(command, {
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
        if (/listening|ready/i.test(trimmed)) wrapperLog.info(`wrapper: ${trimmed}`);
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
  async startWithLogin(email: string, password: string): Promise<WrapperStatus> {
    const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
    const loginCommand = `${this.options.command} -L ${quote(`${email}:${password}`)} -F`;
    this.loginOverride = loginCommand;
    // Signing in reaches Apple before any socket opens, so allow for it.
    this.loginTimeoutMs = 120_000;
    try {
      return await this.start();
    } finally {
      this.loginOverride = null;
      this.loginTimeoutMs = null;
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
