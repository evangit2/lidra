/**
 * Bundled FairPlay runtime (Linux, and Windows through WSL1).
 *
 * The wrapper Apple's FairPlay path needs is an Android/Linux program. Rather
 * than asking the user to install and configure it, Lidra ships the whole tree
 * inside its own package: a static busybox, the glibc loader and libc it was
 * linked against, the wrapper binary, and the Android system image it chroots
 * into.
 *
 * The tree lives in the repository at `vendor/wrapper` and is packaged as
 * `resources/wrapper`, so there is no archive to unpack: the runtime copies the
 * tree into the app's data directory once (the packaged copy may be read-only)
 * and runs it from there. Windows needs a tar to import a WSL distro, so the
 * same tree is packed on demand.
 *
 * macOS cannot execute an ELF at all: the payload travels with the app for
 * completeness, but it is reported as unavailable there.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Directory that holds the wrapper inside `resources/`. */
export const PAYLOAD_DIR = "wrapper";

/** Absolute path of the wrapper program inside a payload tree. */
const WRAPPER_BINARY = path.join("opt", "lidra", "wrapper");

/** Files a complete payload must contain. */
const REQUIRED = [
  "bin/busybox",
  "etc/passwd",
  "lib64/ld-linux-x86-64.so.2",
  "opt/lidra/wrapper",
  "opt/lidra/rootfs/system",
];

/**
 * Where the payload might live: `resourcesPath` in a packaged app, and the
 * repository's `vendor` directory when running from source.
 */
export function bundledPayloadPaths(resourcesPath: string, appPath: string): string[] {
  return [
    // A packed archive wins when the installer ships one: it was built on the
    // build machine, so nothing has to be packed correctly on the user's.
    path.join(resourcesPath, PAYLOAD_DIR, "wrapper-rootfs.tar.gz"),
    path.join(resourcesPath, PAYLOAD_DIR),
    path.join(appPath, "vendor", PAYLOAD_DIR),
    path.join(appPath, "..", "vendor", PAYLOAD_DIR),
    path.join(appPath, "build", PAYLOAD_DIR, "root"),
  ];
}

export interface LocatedPayload {
  kind: "directory" | "archive";
  path: string;
}

/** Find a complete payload tree (or a packed one) in the given places. */
export function findBundledPayload(paths: string[]): LocatedPayload | null {
  for (const candidate of paths) {
    try {
      if (!fs.existsSync(candidate)) continue;
      if (fs.statSync(candidate).isDirectory()) {
        if (REQUIRED.every((relative) => fs.existsSync(path.join(candidate, relative)))) {
          return { kind: "directory", path: candidate };
        }
        continue;
      }
      if (candidate.endsWith(".tar.gz") && fs.statSync(candidate).size > 0) {
        return { kind: "archive", path: candidate };
      }
    } catch {
      // Unreadable candidate: keep looking.
    }
  }
  return null;
}

export interface BundledSetupResult {
  ok: boolean;
  /** Human-readable outcome, safe to log and to show in the quality panel. */
  detail: string;
  hint?: string;
  /** Directory the wrapper runs from (the one containing `rootfs/`). */
  wrapperDir?: string;
}

function run(
  command: string,
  args: string[],
  timeoutMs = 300_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

function stampOf(payload: LocatedPayload): string {
  if (payload.kind === "archive") {
    const stats = fs.statSync(payload.path);
    return `${stats.size}:${Math.round(stats.mtimeMs)}`;
  }
  // A directory payload is versioned by the wrapper binary it carries.
  const stats = fs.statSync(path.join(payload.path, WRAPPER_BINARY));
  return `dir:${stats.size}:${Math.round(stats.mtimeMs)}`;
}

/**
 * Materialise the payload in a writable place, once per payload revision, and
 * make the pieces executable. The layout is the same one a hand install has, so
 * the wrapper's own paths, the 2FA file and the session files all resolve.
 */
export async function ensureBundledRuntime(options: {
  payloadPaths: string[];
  installDir: string;
  platform?: NodeJS.Platform;
  runImpl?: typeof run;
  onProgress?: (message: string) => void;
}): Promise<BundledSetupResult> {
  const platform = options.platform ?? process.platform;
  const progress = options.onProgress ?? ((): void => undefined);
  const runCommand = options.runImpl ?? run;

  const payload = findBundledPayload(options.payloadPaths);
  if (!payload) {
    return {
      ok: false,
      detail: "this build does not carry the lossless runtime",
      hint: "Reinstall Lidra from a release that includes the wrapper payload.",
    };
  }
  if (platform !== "linux" && platform !== "freebsd" && platform !== "openbsd") {
    return {
      ok: false,
      detail: "the lossless runtime is a Linux program",
      hint: "Windows runs it through WSL1; macOS cannot execute it.",
    };
  }

  const root = options.installDir;
  const wrapperDir = path.join(root, "opt", "lidra");
  const marker = path.join(root, ".lidra-payload");
  const expected = stampOf(payload);

  let current = "";
  try {
    current = fs.readFileSync(marker, "utf-8").trim();
  } catch {
    current = "";
  }

  if (current !== expected || !fs.existsSync(path.join(wrapperDir, "wrapper"))) {
    progress(`installing the lossless runtime into ${root}`);
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    if (payload.kind === "archive") {
      const extracted = await runCommand("tar", ["xzf", payload.path, "-C", root]);
      if (extracted.code !== 0) {
        return {
          ok: false,
          detail: (extracted.stderr || extracted.stdout).trim() || "could not unpack the lossless runtime",
        };
      }
    } else {
      fs.cpSync(payload.path, root, { recursive: true, dereference: false });
    }
    for (const relative of ["bin/busybox", "bin/sh", "lib64/ld-linux-x86-64.so.2", "opt/lidra/wrapper"]) {
      try {
        fs.chmodSync(path.join(root, relative), 0o755);
      } catch {
        // A missing optional file is reported by the checks below.
      }
    }
    fs.writeFileSync(marker, expected, { mode: 0o644 });
  }

  // The wrapper reads /dev/urandom from inside its own rootfs. Device nodes
  // cannot live in a git checkout, so give it the ones every Linux image has.
  const devDir = path.join(wrapperDir, "rootfs", "dev");
  const wanted = ["null", "zero", "random", "urandom"];
  const absent = wanted.filter((device) => {
    try {
      fs.statSync(path.join(devDir, device));
      return false;
    } catch {
      return true;
    }
  });
  if (absent.length > 0) {
    progress("creating the runtime's device nodes");
    await runCommand("sudo", [
      "-n",
      "sh",
      "-c",
      `cd ${shellQuote(wrapperDir)} && mkdir -p rootfs/dev && for device in ${absent.join(" ")}; ` +
        `do [ -e rootfs/dev/$device ] || cp -a /dev/$device rootfs/dev/$device; done`,
    ]);
  }

  const missing = REQUIRED.filter((relative) => !fs.existsSync(path.join(root, relative)));
  if (missing.length > 0) {
    return { ok: false, detail: `the lossless runtime is incomplete (missing ${missing.join(", ")})` };
  }

  return { ok: true, detail: `bundled runtime at ${wrapperDir}`, wrapperDir };
}

/**
 * Pack a directory payload for `wsl --import`, which only takes a tar. Returns
 * the archive path, or null when nothing could be produced.
 */
export async function packPayloadForImport(options: {
  payload: LocatedPayload;
  targetPath: string;
  runImpl?: typeof run;
}): Promise<string | null> {
  if (options.payload.kind === "archive") return options.payload.path;
  const runCommand = options.runImpl ?? run;
  // Cache the packed archive against what it was made from. A plain "file
  // exists" check kept serving the archive built by an older release, so an
  // import silently reused a payload that was missing files.
  const stampPath = `${options.targetPath}.stamp`;
  const stamp = stampOf(options.payload);
  try {
    const current = fs.readFileSync(stampPath, "utf-8").trim();
    if (current === stamp && fs.statSync(options.targetPath).size > 0) {
      return options.targetPath;
    }
  } catch {
    // No usable archive yet.
  }
  fs.mkdirSync(path.dirname(options.targetPath), { recursive: true });
  const entries = fs
    .readdirSync(options.payload.path)
    .filter((entry) => fs.statSync(path.join(options.payload.path, entry)).isDirectory());
  const packed = await runCommand("tar", ["czf", options.targetPath, "-C", options.payload.path, ...entries]);
  if (packed.code !== 0) return null;
  // Prove the archive holds what the environment needs before anything imports
  // it: an archive that quietly lost bin/ costs a whole troubleshooting cycle.
  const listing = await runCommand("tar", ["tzf", options.targetPath]);
  const names = listing.stdout;
  if (
    listing.code !== 0 ||
    !/\b(bin\/sh|bin\/busybox)\b/.test(names) ||
    !names.includes("etc/passwd") ||
    !names.includes("opt/lidra/wrapper")
  ) {
    return null;
  }
  try {
    fs.writeFileSync(stampPath, stamp, "utf-8");
  } catch {
    // Re-packing next launch is cheap compared with importing a stale payload.
  }
  return options.targetPath;
}

/**
 * The line the app runs. It mirrors a hand install: run from the directory that
 * holds `rootfs/`, so the wrapper's own paths, the 2FA file and the session
 * files all resolve the same way they do for an installed wrapper.
 */
export function buildBundledCommand(options: {
  wrapperDir: string;
  decryptPort: number;
  manifestPort: number;
  host?: string;
  sudo?: boolean;
  extra?: string[];
}): string {
  const host = options.host ?? "127.0.0.1";
  const sudo = options.sudo === false ? "" : "sudo -n ";
  const extra = (options.extra ?? []).join(" ");
  const loader = "../../lib64/ld-linux-x86-64.so.2 --library-path ../../lib/x86_64-linux-gnu";
  return (
    `cd ${shellQuote(options.wrapperDir)} && ${sudo}${loader} ./wrapper -H ${host}` +
    ` -D ${options.decryptPort} -M ${options.manifestPort} --base-dir rootfs` +
    (extra ? ` ${extra}` : "")
  );
}

/** Whether this machine lets `sudo -n` run without a password. */
export async function passwordlessSudo(): Promise<boolean> {
  const result = await run("sudo", ["-n", "true"], 10_000);
  return result.code === 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
