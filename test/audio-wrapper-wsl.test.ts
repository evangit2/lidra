import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostPathForWrapper } from "../src/audio/wrapper/session";
import {
  buildWslCommand,
  ensureWslRuntime,
  importArguments,
  parseWslList,
  runtimeArchiveCandidates,
  startWslWrapper,
  toWslPath,
  WSL_DISTRO,
} from "../src/audio/wrapper/wsl";

/** `wsl.exe --list --verbose` writes UTF-16LE; keep the NULs to prove decoding. */
function utf16(text: string): string {
  return text.split("").join("\u0000");
}

const LISTING = utf16(
  [
    "  NAME            STATE           VERSION",
    "* Ubuntu-22.04    Running         2",
    "  LidraWrapper    Stopped         1",
    "  Debian          Stopped         1",
    "",
  ].join("\r\n"),
);

describe("parseWslList", () => {
  it("reads names, versions and the default marker from UTF-16 output", () => {
    expect(parseWslList(LISTING)).toEqual([
      { name: "Ubuntu-22.04", version: 2, isDefault: true },
      { name: "LidraWrapper", version: 1, isDefault: false },
      { name: "Debian", version: 1, isDefault: false },
    ]);
  });

  it("keeps spaces inside a distro name", () => {
    const rows = parseWslList("  My Distro       Stopped         1\n");
    expect(rows).toEqual([{ name: "My Distro", version: 1, isDefault: false }]);
  });

  it("ignores the header, blank lines and unrelated output", () => {
    expect(parseWslList("NAME STATE VERSION\n\nsomething else\n")).toEqual([]);
  });
});

describe("toWslPath", () => {
  it("maps a drive path into /mnt", () => {
    expect(toWslPath("C:\\Users\\evan\\AppData")).toBe("/mnt/c/Users/evan/AppData");
    expect(toWslPath("D:/Games")).toBe("/mnt/d/Games");
  });

  it("leaves a POSIX path alone", () => {
    expect(toWslPath("/opt/lidra")).toBe("/opt/lidra");
  });
});

describe("buildWslCommand", () => {
  it("runs the wrapper as root through a version 1 environment", () => {
    const command = buildWslCommand({ decryptPort: 10020, manifestPort: 20020 });
    expect(command).toContain(`wsl.exe -d ${WSL_DISTRO} -u root`);
    expect(command).toContain("/bin/sh -c");
    expect(command).toContain("-D 10020");
    expect(command).toContain("-M 20020");
    expect(command).toContain("cd '/opt/lidra'");
  });

  it("keeps extra arguments inside the shell script", () => {
    const command = buildWslCommand({
      decryptPort: 10030,
      manifestPort: 20030,
      extra: ["-L", "user:pass", "-F"],
    });
    expect(command).toContain("-L 'user:pass' -F");
    // The login lives inside the single script argument cmd hands to wsl.exe.
    expect(command.endsWith('"')).toBe(true);
    expect(command.split('"').length).toBe(3);
  });

  it("escapes single quotes in the directory", () => {
    const command = buildWslCommand({
      directory: "/mnt/c/O'Brien/lidra",
      decryptPort: 10020,
      manifestPort: 20020,
    });
    expect(command).toContain(`'/mnt/c/O'\\''Brien/lidra'`);
  });
});

describe("importArguments", () => {
  it("imports the payload as a version 1 environment", () => {
    expect(importArguments("LidraWrapper", "C:\\wsl", "C:\\p\\rootfs.tar.gz")).toEqual([
      "--import",
      "LidraWrapper",
      "C:\\wsl",
      "C:\\p\\rootfs.tar.gz",
      "--version",
      "1",
    ]);
  });
});

describe("ensureWslRuntime", () => {
  const archiveFile = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lidra-wsl-"));
    const file = path.join(dir, "wrapper-rootfs.tar.gz");
    fs.writeFileSync(file, "payload");
    return file;
  };

  it("does nothing off Windows", async () => {
    const result = await ensureWslRuntime({ archivePaths: [], platform: "linux" });
    expect(result.code).toBe("not-windows");
  });

  it("reports a missing WSL feature with the command that fixes it", async () => {
    const result = await ensureWslRuntime({
      archivePaths: [],
      platform: "win32",
      runImpl: async () => ({
        code: 1,
        stdout: "",
        stderr: "Windows Subsystem for Linux has no installed distributions.",
      }),
    });
    expect(result.code).toBe("no-wsl");
    expect(result.hint).toContain("wsl --install");
  });

  it("accepts an existing version 1 environment without importing", async () => {
    const runImpl = vi.fn(async () => ({ code: 0, stdout: LISTING, stderr: "" }));
    const result = await ensureWslRuntime({ archivePaths: [], platform: "win32", runImpl });
    expect(result).toMatchObject({ ok: true, code: "ready", distro: "LidraWrapper" });
    expect(runImpl).toHaveBeenCalledTimes(1);
  });

  it("imports the shipped files when no environment exists", async () => {
    const calls: string[][] = [];
    const runImpl = async (_command: string, args: string[]) => {
      calls.push(args);
      return args[0] === "--list"
        ? { code: 0, stdout: "  NAME STATE VERSION\n", stderr: "" }
        : { code: 0, stdout: "Import in progress", stderr: "" };
    };
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "lidra-wsl-home-"));
    const result = await ensureWslRuntime({
      archivePaths: [archiveFile()],
      installDir,
      platform: "win32",
      runImpl,
    });
    expect(result).toMatchObject({ ok: true, imported: true });
    expect(calls.some((args) => args[0] === "--import")).toBe(true);
    expect(calls.find((args) => args[0] === "--import")).toContain("--version");
  });

  it("replaces a version 2 environment instead of converting it", async () => {
    const calls: string[][] = [];
    const runImpl = async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "--list") {
        return { code: 0, stdout: "  NAME STATE VERSION\n  LidraWrapper  Stopped  2\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await ensureWslRuntime({
      archivePaths: [archiveFile()],
      installDir: fs.mkdtempSync(path.join(os.tmpdir(), "lidra-wsl-home-")),
      platform: "win32",
      runImpl,
    });
    expect(result.ok).toBe(true);
    expect(calls.map((args) => args[0])).toEqual(["--list", "--unregister", "--import"]);
  });

  it("clears a stale environment when the import reports the name is taken", async () => {
    const calls: string[][] = [];
    let imports = 0;
    const runImpl = async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "--list") return { code: 0, stdout: "  NAME STATE VERSION\n", stderr: "" };
      if (args[0] === "--import") {
        imports += 1;
        return imports === 1
          ? { code: 1, stdout: "", stderr: "Distro 'LidraWrapper' already exists." }
          : { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await ensureWslRuntime({
      archivePaths: [archiveFile()],
      installDir: fs.mkdtempSync(path.join(os.tmpdir(), "lidra-wsl-home-")),
      platform: "win32",
      runImpl,
    });
    expect(result.ok).toBe(true);
    expect(calls.map((args) => args[0])).toEqual(["--list", "--import", "--unregister", "--import"]);
  });

  it("fails clearly when the shipped files are absent", async () => {
    const result = await ensureWslRuntime({
      archivePaths: ["/definitely/not/here.tar.gz"],
      platform: "win32",
      runImpl: async () => ({ code: 0, stdout: "  NAME STATE VERSION\n", stderr: "" }),
    });
    expect(result.code).toBe("no-runtime");
  });

  it("surfaces the importer error", async () => {
    const result = await ensureWslRuntime({
      archivePaths: [archiveFile()],
      installDir: fs.mkdtempSync(path.join(os.tmpdir(), "lidra-wsl-home-")),
      platform: "win32",
      runImpl: async (_command: string, args: string[]) =>
        args[0] === "--list"
          ? { code: 0, stdout: "  NAME STATE VERSION\n", stderr: "" }
          : { code: 1, stdout: "", stderr: "WSL 1 is not supported on this machine" },
    });
    expect(result.code).toBe("import-failed");
    expect(result.detail).toContain("WSL 1 is not supported");
  });

  it("finds the wrapper files next to the packaged resources", () => {
    const paths = runtimeArchiveCandidates("C:\\Program Files\\Lidra\\resources", "C:\\repo");
    expect(paths[0]).toBe(
      path.join("C:\\Program Files\\Lidra\\resources", "wrapper", "wrapper-rootfs.tar.gz"),
    );
  });
});

describe("startWslWrapper", () => {
  it("reports the port once the wrapper listens", async () => {
    const child = { stdout: null, stderr: null, exitCode: null } as never;
    const result = await startWslWrapper({
      command: "wsl.exe -d LidraWrapper",
      decryptor: "127.0.0.1:10020",
      manifest: "127.0.0.1:20020",
      platform: "win32",
      spawnImpl: (() => child) as never,
      isListening: async () => true,
    });
    expect(result.ok).toBe(true);
  });

  it("reports wrapper output when it exits early", async () => {
    const listeners: ((chunk: Buffer) => void)[] = [];
    const child = {
      stdout: { on: (_event: string, cb: (chunk: Buffer) => void) => listeners.push(cb) },
      stderr: { on: () => undefined },
      exitCode: null,
      pid: 1,
    };
    const promise = startWslWrapper({
      command: "wsl.exe -d LidraWrapper",
      decryptor: "127.0.0.1:10020",
      manifest: "127.0.0.1:20020",
      platform: "win32",
      spawnImpl: (() => child) as never,
      isListening: async () => false,
      timeoutMs: 900,
    });
    listeners[0]?.(Buffer.from("linker64: cannot execute"));
    (child as { exitCode: number | null }).exitCode = 127;
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("linker64");
  });
});

describe("hostPathForWrapper", () => {
  it("reaches a distro path through the wsl UNC share on Windows", () => {
    expect(hostPathForWrapper("/opt/lidra", "win32")).toBe("\\\\wsl$\\LidraWrapper\\opt\\lidra");
    expect(hostPathForWrapper("/opt/lidra/rootfs/data", "win32", "Other")).toBe(
      "\\\\wsl$\\Other\\opt\\lidra\\rootfs\\data",
    );
  });

  it("leaves a native path untouched", () => {
    expect(hostPathForWrapper("/opt/lidra", "linux")).toBe("/opt/lidra");
    expect(hostPathForWrapper("C:\\wrapper", "win32")).toBe("C:\\wrapper");
  });
});
