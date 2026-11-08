import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostPathForWrapper, readWrapperSession, wrapperBaseDir } from "../src/audio/wrapper/session";

function launcherDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lidra-wrapper-"));
}

describe("readWrapperSession", () => {
  it("reads the token the wrapper writes inside its Android data directory", () => {
    const base = launcherDir();
    const files = path.join(base, "rootfs", "data", "data", "com.apple.android.music", "files");
    fs.mkdirSync(files, { recursive: true });
    fs.writeFileSync(path.join(files, "MUSIC_TOKEN"), "token-from-data-dir\n");
    fs.writeFileSync(path.join(files, "STOREFRONT_ID"), "us\n");

    expect(readWrapperSession(base)).toEqual({
      mediaUserToken: "token-from-data-dir",
      storefront: "us",
    });
  });

  it("still accepts a token next to the launcher", () => {
    const base = launcherDir();
    fs.writeFileSync(path.join(base, "MUSIC_TOKEN"), "legacy-token\n");

    expect(readWrapperSession(base)?.mediaUserToken).toBe("legacy-token");
  });

  it("returns null when nothing was written yet", () => {
    expect(readWrapperSession(launcherDir())).toBeNull();
    expect(readWrapperSession(null)).toBeNull();
  });
});

describe("wrapperBaseDir", () => {
  it("finds the directory from a WSL launch line", () => {
    const command = `wsl.exe -d LidraWrapper -u root -- /bin/sh -c "cd '/opt/lidra' && exec ./wrapper -H 127.0.0.1 -D 10020"`;
    expect(wrapperBaseDir(command)).toBe("/opt/lidra");
  });

  it("finds the directory from a plain launch line", () => {
    expect(wrapperBaseDir("cd '/home/evan/.lidra-wrapper/extracted' && ./wrapper -D 10020")).toBe(
      "/home/evan/.lidra-wrapper/extracted",
    );
  });
});

describe("hostPathForWrapper", () => {
  it("maps into the wsl share on Windows", () => {
    expect(hostPathForWrapper("/opt/lidra", "win32")).toBe(
      ["", "", "wsl$", "LidraWrapper", "opt", "lidra"].join(String.fromCharCode(92)),
    );
  });
});
