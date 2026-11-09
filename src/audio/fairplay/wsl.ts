/**
 * Windows FairPlay runtime: a private WSL1 distro that runs the whole backend.
 *
 * The FairPlay service binary is Linux-only, so on Windows everything
 * (python supervisor + service) lives inside the LidraWrapper distro. No
 * Windows/Linux path sharing: state stays under /root/.lidra-fp and the
 * service install is staged at /opt/lidra/service from the image payload.
 * WSL shares loopback with Windows, so the service ports and the
 * account-port token reader work unchanged.
 *
 * Hard lessons from earlier releases, all handled here:
 * - WSL2 needs Hyper-V/VBS and breaks on many machines -> import version 1
 *   first (pure syscall translation, no VM), fall back to 2 only if 1 fails.
 * - `wsl.exe` output is UTF-16LE or UTF-8 depending on phase of the moon.
 * - Stale/empty imports must rebuild, never limp on (revision marker).
 * - A bare failing `wsl.exe` says nothing -> write a diagnose report file.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import log from "electron-log/main";

const wslLog = log.scope("fairplay.wsl");

export const WSL_DISTRO = "LidraWrapper";
/** Bump to force every machine to re-import the environment on upgrade. */
export const WSL_PAYLOAD_REVISION = "2026-11-12-fairplay1";

export const WSL_PYTHON = "/opt/python/python3";
export const WSL_PACKAGE_DIR = "/opt/lidra/fairplay";
const WSL_SERVICE_DIR = "/opt/lidra/service";

export interface WslSetup {
  ok: boolean;
  detail: string;
  hint?: string;
}

export interface WslDiagnoseEntry {
  step: string;
  code: number;
  output: string;
}

function wslBase(): string {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "Lidra", "wsl");
}

function revisionFile(): string {
  return path.join(wslBase(), ".payload-revision");
}

/** wsl.exe speaks UTF-16LE or UTF-8 depending on phase of the moon. */
function decodeOutput(buf: Buffer): string {
  const sample = Math.min(buf.length, 64);
  let nulls = 0;
  for (let i = 0; i < sample; i++) if (buf[i] === 0) nulls++;
  if (nulls * 3 > sample) return buf.toString("utf16le");
  return buf.toString("utf8");
}

function runWsl(args: string[], timeoutMs = 120_000): { code: number; output: string } {
  try {
    const r = spawnSync("wsl.exe", args, { timeout: timeoutMs, encoding: "buffer" });
    const raw = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(String(r.stdout ?? ""));
    return { code: r.status ?? 1, output: decodeOutput(raw) };
  } catch (e) {
    return { code: 1, output: e instanceof Error ? e.message : String(e) };
  }
}

/** Parse `wsl.exe --list --verbose` into distro names (default marked). */
export function parseWslList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.replace(/^\*\s*/, "").trim().split(/\s{2,}|\t/)[0]?.trim() ?? "")
    .filter((name) => name.length > 0);
}

/** Is WSL itself installed and working? Fails before any distro check. */
export function wslAvailable(): { ok: boolean; detail: string } {
  if (process.platform !== "win32") return { ok: false, detail: "WSL is Windows-only" };
  const probe = runWsl(["--status"], 30_000);
  if (probe.code !== 0) {
    return {
      ok: false,
      detail: `wsl.exe is not working: ${probe.output.split("\n")[0]?.slice(0, 200) || "no output"}`,
    };
  }
  return { ok: true, detail: "wsl.exe answers" };
}

function distroPresent(): boolean {
  const list = runWsl(["--list", "--verbose"], 30_000);
  if (list.code !== 0) return false;
  return parseWslList(list.output).some(
    (name) => name.toLowerCase() === WSL_DISTRO.toLowerCase(),
  );
}

function revisionMatches(): boolean {
  try {
    return fs.readFileSync(revisionFile(), "utf8").trim() === WSL_PAYLOAD_REVISION;
  } catch {
    return false;
  }
}

function writeRevision(): void {
  fs.mkdirSync(path.dirname(revisionFile()), { recursive: true });
  fs.writeFileSync(revisionFile(), `${WSL_PAYLOAD_REVISION}\n`);
}

function distroTarget(): string {
  return path.join(wslBase(), WSL_DISTRO);
}

function importDistro(archivePath: string): WslSetup {
  fs.mkdirSync(wslBase(), { recursive: true });
  const unregister = runWsl(["--unregister", WSL_DISTRO], 180_000);
  wslLog.info(`wsl unregister: exit ${unregister.code}`);
  // Version 1 first: no Hyper-V, no virtual network, fewest ways to fail.
  // Only if the host refuses v1 (rare) do we try a v2 import.
  for (const version of ["1", "2"]) {
    const imported = runWsl(
      ["--import", WSL_DISTRO, distroTarget(), archivePath, "--version", version],
      600_000,
    );
    if (imported.code === 0) {
      writeRevision();
      return { ok: true, detail: `imported ${WSL_DISTRO} (wsl${version})` };
    }
    wslLog.warn(`wsl import version ${version} failed: ${imported.output.slice(0, 300)}`);
  }
  return {
    ok: false,
    detail: "wsl --import failed for versions 1 and 2",
    hint: "run 'wsl --install' in an admin terminal, reboot, and relaunch Lidra",
  };
}

function sh(script: string, timeoutMs = 120_000): { code: number; output: string } {
  return runWsl(["-d", WSL_DISTRO, "-u", "root", "--", "/bin/sh", "-c", script], timeoutMs);
}

/** Stage the service from the image payload (fresh copy, no account state). */
function stageService(): WslSetup {
  const script = [
    "set -e",
    `rm -rf ${WSL_SERVICE_DIR}`,
    `mkdir -p ${WSL_SERVICE_DIR}`,
    `cp -a /opt/lidra/wrapper ${WSL_SERVICE_DIR}/wrapper`,
    `cp -a /opt/lidra/rootfs ${WSL_SERVICE_DIR}/rootfs`,
    `chmod 755 ${WSL_SERVICE_DIR}/wrapper`,
    `chmod 755 ${WSL_SERVICE_DIR}/rootfs/system/bin/main ${WSL_SERVICE_DIR}/rootfs/system/bin/linker64 || true`,
    "mkdir -p /opt/lidra/service/rootfs/data/data/com.apple.android.music/files",
    // Device nodes cannot ride the import tar, and the wrapper stops with
    // "Permission denied" when rootfs/dev/urandom is missing. Staging runs
    // as root, so create them here on every launch (idempotent).
    `mkdir -p ${WSL_SERVICE_DIR}/rootfs/dev`,
    `for spec in "null c 1 3" "zero c 1 5" "random c 1 8" "urandom c 1 9"; do set -- $spec; [ -c ${WSL_SERVICE_DIR}/rootfs/dev/$1 ] || mknod -m 666 ${WSL_SERVICE_DIR}/rootfs/dev/$1 $2 $3 $4; done`,
    "mkdir -p /root/.lidra-fp/fpdata /root/.lidra-fp/fpconfig",
  ].join(" && ");
  const r = sh(script);
  if (r.code !== 0) {
    return { ok: false, detail: `service staging failed: ${r.output.slice(0, 300)}` };
  }
  return { ok: true, detail: "service staged" };
}

function healthProbe(): WslSetup {
  const r = sh(
    [
      "test -x /opt/python/python3",
      "test -f /opt/lidra/fairplay/fairplay_decrypter/cli.py",
      "test -x /opt/lidra/wrapper",
      "test -f /opt/lidra/rootfs/system/bin/main",
      "test -c /opt/lidra/service/rootfs/dev/urandom",
      "/opt/python/python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'",
    ].join(" && "),
  );
  if (r.code !== 0) {
    return { ok: false, detail: `runtime health probe failed: ${r.output.slice(0, 300)}` };
  }
  return { ok: true, detail: "runtime healthy" };
}

/**
 * Collect what each layer sees when the runtime will not come up. Written to
 * the report file so the next run (or a bug report) has an actual reason
 * instead of a bare wsl.exe exit code.
 */
export function diagnoseWslRuntime(): WslDiagnoseEntry[] {
  const entries: WslDiagnoseEntry[] = [];
  const status = runWsl(["--status"], 30_000);
  entries.push({ step: "wsl --status", code: status.code, output: status.output.slice(0, 1000) });
  const list = runWsl(["--list", "--verbose"], 30_000);
  entries.push({ step: "wsl --list", code: list.code, output: list.output.slice(0, 1000) });
  const probe = sh("uname -a; cat /etc/os-release 2>/dev/null | head -3; ls /opt/lidra 2>&1; ls -l /opt/lidra/service/rootfs/dev 2>&1 | head -8", 60_000);
  entries.push({ step: "distro probe", code: probe.code, output: probe.output.slice(0, 1500) });
  return entries;
}

export function writeDiagnoseReport(entries: WslDiagnoseEntry[], userData: string): string {
  const text = entries.map((e) => `## ${e.step} (exit ${e.code})\n${e.output}`).join("\n\n");
  const file = path.join(userData, "wsl-diagnose.txt");
  try {
    fs.writeFileSync(
      file,
      `Lidra payload ${WSL_PAYLOAD_REVISION}\n${new Date().toISOString()}\n\n${text}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* the log below still names the failing step */
  }
  for (const e of entries) wslLog.error(`diagnose ${e.step} (exit ${e.code}):\n${e.output}`);
  const failing = entries.find((e) => e.code !== 0) ?? entries[entries.length - 1];
  void failing;
  return file;
}

/**
 * Ensure the distro exists at the current payload revision, the backend is
 * runnable inside it, and the service copy is staged. Imports the tar on a
 * cold install or after an upgrade changed the payload; rebuilds once when
 * the health probe fails.
 */
export async function ensureWslRuntime(opts: {
  archivePath: string | null;
  onProgress?: (message: string) => void;
}): Promise<WslSetup> {
  if (process.platform !== "win32") {
    return { ok: false, detail: "WSL runtime is Windows-only" };
  }
  const say = (m: string): void => {
    wslLog.info(m);
    opts.onProgress?.(m);
  };
  const available = wslAvailable();
  if (!available.ok) return { ok: false, detail: available.detail, hint: "run 'wsl --install' in an admin terminal, reboot, and relaunch Lidra" };
  if (!distroPresent() || !revisionMatches()) {
    if (!opts.archivePath) {
      return {
        ok: false,
        detail: "no WSL environment and no payload archive to import",
        hint: "reinstall Lidra — the installer ships the runtime archive",
      };
    }
    say("importing the Linux runtime (first run only, a minute or two)…");
    const imported = importDistro(opts.archivePath);
    if (!imported.ok) return imported;
    say(imported.detail);
  }
  const probe = healthProbe();
  if (!probe.ok) {
    // A stale or half-imported environment: rebuild once from the archive.
    if (!opts.archivePath) return probe;
    say("runtime looks stale; rebuilding it once…");
    const imported = importDistro(opts.archivePath);
    if (!imported.ok) return imported;
    const retry = healthProbe();
    if (!retry.ok) return retry;
  }
  const staged = stageService();
  if (!staged.ok) return staged;
  return { ok: true, detail: "WSL runtime ready" };
}
