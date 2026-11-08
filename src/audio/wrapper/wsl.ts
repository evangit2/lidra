/**
 * Windows lossless runtime.
 *
 * Apple's FairPlay client only exists as an Android/Linux binary (the wrapper
 * chroots into an Android rootfs and runs `/system/bin/main`), so Windows can
 * only run it through a Linux syscall translation layer. WSL1 is exactly that:
 * ELF binaries execute on the NT kernel with no VM and no Hyper-V. This module
 * owns everything platform-specific — reading the distro list, importing the
 * payload that ships with the installer, and building the launch line — so the
 * rest of the app treats Windows like any other wrapper host.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Name of the Linux environment Lidra imports for itself. */
export const WSL_DISTRO = "LidraWrapper";

/** Directory inside the imported distro that holds the wrapper. */
export const WSL_WRAPPER_DIR = "/opt/lidra";

export interface WslDistro {
  name: string;
  /** 1 = syscall translation (no VM), 2 = virtual machine. */
  version: number;
  isDefault: boolean;
}

/**
 * Parse `wsl.exe --list --verbose`.
 *
 * The real output is UTF-16LE and column aligned:
 *
 *      NAME            STATE           VERSION
 *    * Ubuntu-22.04    Running         2
 *      LidraWrapper    Stopped         1
 *
 * Names may contain single spaces, so the columns are split on runs of two or
 * more spaces rather than on whitespace.
 */
export function parseWslList(raw: string): WslDistro[] {
  const text = raw.replace(/\u0000/g, "");
  const rows: WslDistro[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^NAME\b/i.test(trimmed)) continue;
    const isDefault = trimmed.startsWith("*");
    const body = isDefault ? trimmed.slice(1).trim() : trimmed;
    const columns = body.split(/\s{2,}/).map((column) => column.trim());
    if (columns.length < 3) continue;
    const version = Number.parseInt(columns[columns.length - 1], 10);
    if (version !== 1 && version !== 2) continue;
    // The state column is localised, so it is skipped rather than matched.
    rows.push({ name: columns.slice(0, columns.length - 2).join(" "), version, isDefault });
  }
  return rows;
}

/**
 * Whether a configured wrapper command can actually run on Windows.
 *
 * The package ships a Unix default (`~/.lidra-wrapper/wrapper …`), so a Windows
 * user who never edited the field must not be treated as having configured a
 * working command — that path cannot execute, and pretending otherwise skipped
 * the whole runtime setup.
 */
export function isWindowsWrapperCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (/^wsl(\.exe)?\b/i.test(trimmed)) return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  if (/\\\\wsl\$[\\/]/i.test(trimmed)) return true;
  return /\.exe\b/i.test(trimmed);
}

/** Windows path to the path the imported distro sees (`C:\x` -> `/mnt/c/x`). */
export function toWslPath(windowsPath: string): string {
  const normalized = windowsPath.replace(/\\/g, "/");
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!drive) return normalized;
  return `/mnt/${drive[1].toLowerCase()}/${drive[2]}`;
}

/** Quote for /bin/sh inside a single-quoted `-c` argument (also safe for cmd.exe). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The launch line handed to the wrapper service.
 *
 * The service spawns through a shell, so the line is parsed by `cmd.exe` first.
 * cmd groups on double quotes only and leaves single quotes alone, so the script
 * is wrapped in one pair of double quotes and every inner quote is a single
 * quote that `/bin/sh` strips. `-u root` matters: the wrapper needs to chroot.
 */
export function buildWslCommand(options: {
  distro?: string;
  directory?: string;
  decryptPort: number;
  manifestPort: number;
  host?: string;
  /** Extra wrapper arguments, e.g. the `-L user:pass -F` login run. */
  extra?: string[];
}): string {
  const distro = options.distro ?? WSL_DISTRO;
  const directory = options.directory ?? WSL_WRAPPER_DIR;
  const host = options.host ?? "127.0.0.1";
  // Flags stay bare so the line reads like the Linux one; values are quoted only
  // when a character could be read by the shell as syntax.
  const extra = (options.extra ?? [])
    // A colon means a credential pair, which is always quoted.
    .map((argument) => (/^[A-Za-z0-9_.\/@%+=,-]+$/.test(argument) ? argument : shellQuote(argument)))
    .join(" ");
  // `--base-dir rootfs` is what a hand install passes: without it the wrapper
  // looks for its Android image somewhere else and exits immediately.
  const script =
    `cd ${shellQuote(directory)} && exec ./wrapper -H ${host} -D ${options.decryptPort} -M ${options.manifestPort}` +
    ` --base-dir rootfs` +
    (extra ? ` ${extra}` : "");
  // No double quote can survive cmd's parsing of the script, and Windows paths
  // cannot contain one, so this is the safe frame.
  return `wsl.exe -d ${distro} -u root -- /bin/sh -c "${script}"`;
}

/** `wsl.exe --import <distro> <install dir> <tarball> --version 1` */
export function importArguments(distro: string, installDir: string, tarball: string): string[] {
  return ["--import", distro, installDir, tarball, "--version", "1"];
}

export interface WslSetupResult {
  ok: boolean;
  /** Stable code for tests and logs. */
  code:
    | "ready"
    | "no-wsl"
    | "no-v1-distro"
    | "no-runtime"
    | "import-failed"
    | "not-windows";
  detail: string;
  /** What the user (or we) can do about it. */
  hint?: string;
  distro?: string;
  /** True when Lidra had to import its own environment on this run. */
  imported?: boolean;
}

type RunResult = { code: number; stdout: string; stderr: string };

async function run(command: string, args: string[], timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, windowsHide: true, encoding: "buffer" as never },
      (error, stdout, stderr) => {
        const decode = (value: Buffer | string | undefined): string =>
          typeof value === "string"
            ? value
            : Buffer.from(value ?? []).toString("utf16le");
        resolve({
          code: error ? ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
          stdout: decode(stdout as Buffer),
          stderr: decode(stderr as Buffer),
        });
      },
    );
  });
}

/** Where the installer puts the wrapper files. */
export function runtimeArchiveCandidates(resourcesPath: string, repoRoot?: string): string[] {
  const candidates = [path.join(resourcesPath, "wrapper", "wrapper-rootfs.tar.gz")];
  if (repoRoot) candidates.push(path.join(repoRoot, "build", "wrapper", "wrapper-rootfs.tar.gz"));
  return candidates;
}

/**
 * Make sure a version 1 distro holding the wrapper exists, importing it from the
 * payload shipped with the app when it does not.
 */
export async function ensureWslRuntime(options: {
  archivePaths: string[];
  installDir?: string;
  platform?: NodeJS.Platform;
  runImpl?: typeof run;
  distro?: string;
  onProgress?: (message: string) => void;
}): Promise<WslSetupResult> {
  const platform = options.platform ?? process.platform;
  const distro = options.distro ?? WSL_DISTRO;
  const runCommand = options.runImpl ?? run;
  const progress = options.onProgress ?? ((): void => undefined);

  if (platform !== "win32") {
    return { ok: false, code: "not-windows", detail: "the WSL runtime is only used on Windows" };
  }

  const listing = await runCommand("wsl.exe", ["--list", "--verbose"], 30_000);
  const distros = parseWslList(listing.stdout + listing.stderr);
  if (listing.code !== 0 && distros.length === 0) {
    return {
      ok: false,
      code: "no-wsl",
      detail: (listing.stderr || listing.stdout).trim() || "wsl.exe did not report any Linux environment",
      hint: "Enable the Windows Subsystem for Linux feature (admin PowerShell: wsl --install --no-distribution), then sign out and back in.",
    };
  }

  const existing = distros.find((entry) => entry.name === distro);
  if (existing && existing.version === 1) {
    return { ok: true, code: "ready", detail: `${distro} is ready`, distro };
  }

  const archive = options.archivePaths.find((candidate) => fs.existsSync(candidate));
  if (!archive) {
    return {
      ok: false,
      code: "no-runtime",
      detail: "the wrapper files that ship with Lidra are missing",
      hint: "Reinstall Lidra, or point Settings → Audio at a wrapper folder you already have.",
    };
  }

  const installDir = options.installDir ?? path.join(os.homedir(), "AppData", "Local", "Lidra", "wsl");
  fs.mkdirSync(installDir, { recursive: true });

  // An existing distro with the wrong version is replaced rather than converted:
  // converting rewrites the user's own environment and can lose data.
  if (existing && existing.version !== 1) {
    progress(`replacing ${distro} with a version 1 environment`);
    await runCommand("wsl.exe", ["--unregister", distro], 120_000);
  }

  progress(`importing the wrapper environment (${path.basename(archive)})`);
  let imported = await runCommand("wsl.exe", importArguments(distro, installDir, archive), 600_000);
  // The listing above can miss a distro (older WSL builds, localised output), in
  // which case the import reports that the name is taken. Clear and retry once.
  if (imported.code !== 0 && /already exists|bereits vorhanden|existe d[eé]j[aà]/i.test(imported.stderr)) {
    progress(`removing the stale ${distro} environment`);
    await runCommand("wsl.exe", ["--unregister", distro], 120_000);
    imported = await runCommand("wsl.exe", importArguments(distro, installDir, archive), 600_000);
  }
  if (imported.code !== 0) {
    return {
      ok: false,
      code: "import-failed",
      detail: (imported.stderr || imported.stdout).trim().slice(0, 400) || "wsl --import failed",
      hint: "The WSL feature may be present but version 1 support is disabled. Run 'wsl --set-default-version 1' as admin and retry.",
    };
  }

  // The wrapper chroots into its own Android image, so that image needs the
  // device nodes a Linux root has. A git checkout cannot carry them and WSL
  // does not create them inside an imported distro, so add them here — without
  // them the wrapper dies on its first read of /dev/urandom.
  progress(`preparing ${distro}`);
  await runCommand(
    "wsl.exe",
    [
      "-d",
      distro,
      "-u",
      "root",
      "--",
      "/bin/sh",
      "-c",
      `cd ${WSL_WRAPPER_DIR} && mkdir -p rootfs/dev && ` +
        "for device in null zero random urandom; do " +
        "[ -e rootfs/dev/$device ] && continue; " +
        "cp -a /dev/$device rootfs/dev/$device 2>/dev/null || " +
        "case $device in null) mknod -m 666 rootfs/dev/$device c 1 3;; " +
        "zero) mknod -m 666 rootfs/dev/$device c 1 5;; " +
        "random) mknod -m 666 rootfs/dev/$device c 1 8;; " +
        "urandom) mknod -m 666 rootfs/dev/$device c 1 9;; esac; done",
    ],
    60_000,
  );

  return {
    ok: true,
    code: "ready",
    detail: `imported ${distro}`,
    distro,
    imported: true,
  };
}

/**
 * Start the distro's wrapper and wait for its sockets. `isListening` is injected
 * so tests can drive both outcomes without a real wrapper.
 */
export async function startWslWrapper(options: {
  command: string;
  isListening: (address: string, timeoutMs?: number) => Promise<boolean>;
  decryptor: string;
  manifest: string;
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}): Promise<{ ok: boolean; detail: string }> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { ok: false, detail: "not windows" };
  const spawnProcess = options.spawnImpl ?? spawn;

  const child = spawnProcess(options.command, {
    shell: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  } as never);
  let output = "";
  const collect = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-4_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const deadline = Date.now() + (options.timeoutMs ?? 45_000);
  while (Date.now() < deadline) {
    if (await options.isListening(options.decryptor, 700)) {
      return { ok: true, detail: "wrapper listening" };
    }
    if (child.exitCode !== null && child.exitCode !== 0) {
      return { ok: false, detail: output.trim().slice(0, 300) || `wrapper exited with ${child.exitCode}` };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ok: false, detail: output.trim().slice(0, 300) || "the wrapper never opened its port" };
}
