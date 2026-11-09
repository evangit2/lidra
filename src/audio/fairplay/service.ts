/**
 * Supervisor for the vendored fairplay-decrypter backend.
 *
 * Lidra ships the fairplay-decrypter Python package plus the Apple runtime
 * shared libraries under `vendor/fairplay` (packaged as `resources/fairplay`).
 * This module drives its CLI machine-to-machine:
 *
 * - `status --json` — detect a missing install or a missing sign-in ("no key")
 * - `setup --from <payload>` — stage the bundled runtime into writable state
 * - `login --user --password` — FairPlay sign-in; the 2FA code goes to 2fa.txt
 * - `ladder --json <adam>` — quality tiers for a song
 * - `stream <adam> [--tier]` — decrypted bytes on stdout for the audio engine
 * - account port (loopback JSON) — dev/music/storefront tokens for the web UI
 *
 * All state is isolated per app via XDG_DATA_HOME/XDG_CONFIG_HOME under the
 * caller-supplied state dir, so the app never touches a developer's own
 * ~/.local/share/fairplay-decrypter checkout.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import log from "electron-log/main";
import type {
  FairplayAccount,
  FairplayEnv,
  FairplayPaths,
  FairplayStatus,
  FairplayTier,
} from "./types";

export const LIB_NAMES = [
  "libandroidappmusic.so",
  "libCoreFP.so",
  "libCoreLSKD.so",
  "libCoreADI.so",
  "libmediaplatform.so",
  "libstoreservicescore.so",
] as const;

const DEFAULT_PORTS = { decrypt: 10120, manifest: 20120, account: 30120, key: 40120 };

/** Session files dir inside a staged service, mirroring fairplay config.FILES_DIR. */
const FILES_REL = path.join("rootfs", "data", "data", "com.apple.android.music", "files");

/** Find the vendored package dir: packaged resources first, source tree second. */
export function findPackageDir(resourcesPath: string, appPath: string): string | null {
  const cands = [
    path.join(resourcesPath, "fairplay"),
    path.join(appPath, "vendor", "fairplay"),
  ];
  for (const dir of cands) {
    try {
      if (fs.statSync(path.join(dir, "fairplay_decrypter", "__main__.py")).isFile()) return dir;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Locate a python3 interpreter. Returns null when none is on PATH. */
export function findPython(): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    for (const name of process.platform === "win32"
      ? ["python.exe", "python3.exe"]
      : ["python3", "python"]) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/** A directory is a usable service install when it has the launcher, the
 * Android binaries, and all six Apple runtime libs. Mirrors libs.REQUIRED. */
export function isServiceInstall(root: string): boolean {
  const required = [
    "wrapper",
    path.join("rootfs", "system", "bin", "main"),
    path.join("rootfs", "system", "bin", "linker64"),
    ...LIB_NAMES.map((n) => path.join("rootfs", "system", "lib64", n)),
  ];
  return required.every((rel) => {
    try {
      return fs.statSync(path.join(root, rel)).isFile();
    } catch {
      return false;
    }
  });
}

/** Build the isolated environment for every CLI invocation. */
export function buildEnv(paths: FairplayPaths, python: string): FairplayEnv {
  const dataDir = path.join(paths.stateDir, "fpdata");
  const configDir = path.join(paths.stateDir, "fpconfig");
  const serviceDir = path.join(dataDir, "fairplay-decrypter", "service");
  return {
    PYTHON: python,
    packageDir: paths.packageDir,
    dataDir,
    configDir,
    serviceDir: isServiceInstall(serviceDir) ? serviceDir : null,
    ports: { ...DEFAULT_PORTS },
  };
}

/** Spawn-spec environment: isolation dirs + service pointer + fixed ports. */
export function spawnEnv(env: FairplayEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_DATA_HOME: env.dataDir,
    XDG_CONFIG_HOME: env.configDir,
    FPDECRYPT_PORT_DECRYPT: String(env.ports.decrypt),
    FPDECRYPT_PORT_MANIFEST: String(env.ports.manifest),
    FPDECRYPT_PORT_ACCOUNT: String(env.ports.account),
    FPDECRYPT_PORT_KEY: String(env.ports.key),
  };
  if (env.serviceDir) out.FPDECRYPT_SERVICE = env.serviceDir;
  return out;
}

export function cliArgs(env: FairplayEnv, args: string[]): { cmd: string; args: string[] } {
  // Run as `-m` with the package dir as cwd: executing __main__.py by path
  // breaks its relative imports.
  return { cmd: env.PYTHON, args: ["-m", "fairplay_decrypter", ...args] };
}

function runJson<T>(env: FairplayEnv, args: string[], timeoutMs = 60_000): Promise<T> {
  const { cmd, args: full } = cliArgs(env, args);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, full, { env: spawnEnv(env), cwd: env.packageDir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`fairplay ${args[0]} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`fairplay ${args[0]} exited ${code}: ${err.slice(0, 300)}`));
        return;
      }
      try {
        resolve(JSON.parse(out) as T);
      } catch (e) {
        reject(new Error(`fairplay ${args[0]} returned non-JSON: ${out.slice(0, 200)}`));
      }
    });
  });
}

/** Machine-readable service + session state. Throws when python is missing. */
export function status(env: FairplayEnv): Promise<FairplayStatus> {
  return runJson<FairplayStatus>(env, ["status", "--json"]);
}

/** Machine-readable quality tiers for a song. Needs the service running. */
export function ladder(env: FairplayEnv, adam: string): Promise<FairplayTier[]> {
  return runJson<FairplayTier[]>(env, ["ladder", "--json", adam], 120_000);
}

/**
 * Stage the bundled runtime payload into writable per-app state.
 * `payloadDir` is the read-only shipped tree (launcher + rootfs/);
 * account state is never copied — login creates a fresh session.
 */
export function stageRuntime(payloadDir: string, env: FairplayEnv): string {
  if (!isServiceInstall(payloadDir)) throw new Error(`not a service payload: ${payloadDir}`);
  const dest = path.join(env.dataDir, "fairplay-decrypter", "service");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(payloadDir, dest, { recursive: true });
  for (const rel of ["wrapper", path.join("rootfs", "system", "bin", "main"), path.join("rootfs", "system", "bin", "linker64")]) {
    const p = path.join(dest, rel);
    try {
      fs.chmodSync(p, fs.statSync(p).mode | 0o111);
    } catch (e) {
      log.warn("fairplay: chmod failed", rel, String(e));
    }
  }
  fs.mkdirSync(path.join(dest, FILES_REL), { recursive: true });
  log.info("fairplay: runtime staged at", dest);
  return dest;
}

/** Where the login flow expects the 2FA code file for the staged service. */
export function codeFileFor(serviceDir: string): string {
  return path.join(serviceDir, FILES_REL, "2fa.txt");
}

const NEEDS_CODE = /2fa|two-factor|verification code|approve/i;

export interface LoginHooks {
  /** Called when the backend asks for the Apple 2FA code; resolve with the code. */
  onNeedCode: () => Promise<string>;
}

/**
 * FairPlay sign-in through the vendored backend. Fast-paths when already
 * signed in. Feeds user/password on argv (same as the old wrapper's -L flag),
 * watches output for the 2FA prompt, and delivers the code via 2fa.txt.
 */
export async function login(
  env: FairplayEnv,
  user: string,
  password: string,
  hooks: LoginHooks,
  timeoutMs = 240_000,
): Promise<boolean> {
  const st = await status(env).catch(() => null);
  if (st?.session === "signed in") {
    log.info("fairplay: already signed in");
    return true;
  }
  const { cmd, args } = cliArgs(env, ["login", "--user", user, "--password", password]);
  log.info("fairplay: starting sign-in");
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: spawnEnv(env), cwd: env.packageDir, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let codeRequested = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    const onOutput = (d: Buffer) => {
      const text = d.toString();
      log.info("fairplay login:", text.slice(0, 200));
      if (!codeRequested && NEEDS_CODE.test(text) && env.serviceDir) {
        codeRequested = true;
        hooks
          .onNeedCode()
          .then((code) => {
            fs.mkdirSync(path.dirname(codeFileFor(env.serviceDir!)), { recursive: true });
            fs.writeFileSync(codeFileFor(env.serviceDir!), code.trim());
          })
          .catch(() => done(false));
      }
      // Backend prints "signed in" once MUSIC_TOKEN lands.
      if (/signed in/.test(text)) {
        // Give the process a moment to flush state, then confirm via status.
        setTimeout(() => {
          status(env)
            .then((s) => done(s.session === "signed in"))
            .catch(() => done(false));
        }, 2000);
      }
    };
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.on("error", () => done(false));
    child.on("close", () => {
      status(env)
        .then((s) => done(s.session === "signed in"))
        .catch(() => done(false));
    });
  });
}

/** Read dev/music/storefront tokens from the service account port (loopback). */
export function account(env: FairplayEnv, timeoutMs = 10_000): Promise<FairplayAccount> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port: env.ports.account, path: "/", timeout: timeoutMs },
      (res) => {
        let body = "";
        res.on("data", (d: Buffer) => {
          body += d.toString();
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`account port HTTP ${res.statusCode}`));
            return;
          }
          try {
            const parsed = JSON.parse(body) as FairplayAccount;
            if (!parsed.dev_token || !parsed.music_token) throw new Error("not signed in");
            resolve(parsed);
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("account port timed out"));
    });
    req.on("error", reject);
  });
}

/**
 * Spawn `stream` for a track. Stdout carries decrypted bytes (init + segments);
 * logs go to stderr. The caller owns the child (kill on stop/skip).
 */
export function stream(
  env: FairplayEnv,
  adam: string,
  tier?: string,
): ChildProcess {
  const args = ["stream", adam];
  if (tier) args.push("--tier", tier);
  const { cmd, args: full } = cliArgs(env, args);
  return spawn(cmd, full, { env: spawnEnv(env), cwd: env.packageDir, stdio: ["ignore", "pipe", "pipe"] });
}
