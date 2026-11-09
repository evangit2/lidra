import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEnv,
  buildWslEnv,
  cliArgs,
  codeFileFor,
  findPackageDir,
  isServiceInstall,
  spawnEnv,
  spawnSpec,
} from "../src/audio/fairplay/service";

const ROOT = path.resolve(__dirname, "..");

function livePython(): string | null {
  for (const cand of ["/usr/bin/python3", "python3"]) {
    try {
      execFileSync(cand, ["--version"], { stdio: "ignore" });
      return cand;
    } catch {
      /* not usable */
    }
  }
  return null;
}

describe("fairplay backend", () => {
  it("finds the vendored package in the source tree", () => {
    const dir = findPackageDir("/nonexistent-resources", ROOT);
    expect(dir).toBe(path.join(ROOT, "vendor", "fairplay"));
  });

  it("returns null when no payload exists", () => {
    expect(findPackageDir("/nonexistent-resources", "/nonexistent-app")).toBeNull();
  });

  it("builds an isolated env under the state dir", () => {
    const env = buildEnv(
      { packageDir: path.join(ROOT, "vendor", "fairplay"), stateDir: path.join("tmp", "lidra-test") },
      "/usr/bin/python3",
    );
    expect(env.dataDir).toContain("fpdata");
    expect(env.configDir).toContain("fpconfig");
    const se = spawnEnv(env);
    expect(se.XDG_DATA_HOME).toBe(env.dataDir);
    expect(se.XDG_CONFIG_HOME).toBe(env.configDir);
    expect(se.FPDECRYPT_PORT_ACCOUNT).toBe("30120");
  });

  it("routes CLI through -m fairplay_decrypter", () => {
    const env = buildEnv({ packageDir: "/pkg", stateDir: "/state" }, "/usr/bin/python3");
    const { cmd, args } = cliArgs(env, ["status", "--json"]);
    expect(cmd).toBe("/usr/bin/python3");
    expect(args).toEqual(["-m", "fairplay_decrypter", "status", "--json"]);
  });

  it("routes WSL spawns through wsl.exe with nosudo", () => {
    const env = buildWslEnv({ distro: "LidraWrapper", python: "/opt/python/python3" });
    expect(env.wsl?.distro).toBe("LidraWrapper");
    expect(env.noSudo).toBe(true);
    const spec = spawnSpec(env, ["status", "--json"]);
    expect(spec.cmd).toBe("wsl.exe");
    expect(spec.args).toEqual([
      "-d",
      "LidraWrapper",
      "-u",
      "root",
      "--",
      "/opt/python/python3",
      "-m",
      "fairplay_decrypter",
      "status",
      "--json",
    ]);
    expect(spec.cwd).toBeUndefined();
    expect(spawnEnv(env).FPDECRYPT_NO_SUDO).toBe("1");
  });

  it("points the 2FA code file at the service files dir", () => {
    expect(codeFileFor("/svc")).toBe(
      path.join(
        "/svc",
        "rootfs",
        "data",
        "data",
        "com.apple.android.music",
        "files",
        "2fa.txt",
      ),
    );
  });

  it("rejects an incomplete service dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-"));
    expect(isServiceInstall(dir)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("vendored CLI answers status --json in an isolated XDG home", () => {
    const python = livePython();
    if (!python) return; // no interpreter here; CI linux has one
    const pkg = findPackageDir("/nonexistent-resources", ROOT);
    expect(pkg).not.toBeNull();
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "fp-state-"));
    const out = execFileSync(
      python,
      ["-m", "fairplay_decrypter", "status", "--json"],
      {
        cwd: pkg!,
        env: {
          ...process.env,
          XDG_DATA_HOME: path.join(state, "fpdata"),
          XDG_CONFIG_HOME: path.join(state, "fpconfig"),
        },
        encoding: "utf-8",
      },
    );
    const parsed = JSON.parse(out) as { session: string };
    expect(parsed.session).toBe("not signed in");
    fs.rmSync(state, { recursive: true, force: true });
  });
});
