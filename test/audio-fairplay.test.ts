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
  codeFilePosix,
  cooldownRemainingMs,
  findPackageDir,
  IDENTITY_FILES,
  isServiceInstall,
  PROVISION_COOLDOWN_MS,
  PROVISION_REFUSED_RE,
  spawnEnv,
  spawnSpec,
  stageIdentityAtBase,
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
    const env = buildWslEnv({ distro: "LidraFairplay", python: "/opt/python/python3" });
    expect(env.wsl?.distro).toBe("LidraFairplay");
    expect(env.noSudo).toBe(true);
    const spec = spawnSpec(env, ["status", "--json"]);
    expect(spec.cmd).toBe("wsl.exe");
    expect(spec.args).toEqual([
      "-d",
      "LidraFairplay",
      "-u",
      "root",
      "--",
      "env",
      "PYTHONPATH=/opt/lidra/fairplay",
      "FPDECRYPT_SERVICE=/opt/lidra",
      "XDG_DATA_HOME=/root/.lidra-fp/fpdata",
      "XDG_CONFIG_HOME=/root/.lidra-fp/fpconfig",
      "FPDECRYPT_PORT_DECRYPT=10120",
      "FPDECRYPT_PORT_MANIFEST=20120",
      "FPDECRYPT_PORT_ACCOUNT=30120",
      "FPDECRYPT_PORT_KEY=40120",
      "FPDECRYPT_NO_SUDO=1",
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

describe("provisioning refusal guard", () => {
  it("matches Apple's enrollment refusal line", () => {
    expect(
      PROVISION_REFUSED_RE.test("MachineDataProvisioningRequest: ADIProvisioningEnd failed with code: -45054"),
    ).toBe(true);
    expect(PROVISION_REFUSED_RE.test("finished request: https://xp.apple.com/register, status = 200")).toBe(false);
  });

  it("ships device identity only, never session state", () => {
    expect([...IDENTITY_FILES]).toEqual(["adi.pb", "fsi.pdat", "persistent_key.txt"]);
  });

  it("code file path stays POSIX inside the distro", () => {
    expect(codeFilePosix("/opt/lidra")).toBe(
      "/opt/lidra/rootfs/data/data/com.apple.android.music/files/2fa.txt",
    );
  });

  it("cooldown is free without a stamp and expires after a day", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-cool-"));
    const stamp = path.join(dir, "provision-cooldown");
    const now = Date.now();
    expect(cooldownRemainingMs(stamp, now)).toBe(0);
    fs.writeFileSync(stamp, "not-a-number");
    expect(cooldownRemainingMs(stamp, now)).toBe(0);
    fs.writeFileSync(stamp, String(now));
    const remaining = cooldownRemainingMs(stamp, now);
    expect(remaining).toBeGreaterThan(PROVISION_COOLDOWN_MS - 60_000);
    expect(remaining).toBeLessThanOrEqual(PROVISION_COOLDOWN_MS);
    expect(cooldownRemainingMs(stamp, now + PROVISION_COOLDOWN_MS + 1000)).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mirrors identity to the service root without clobbering", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ident-"));
    const files = path.join(dir, "rootfs", "data", "data", "com.apple.android.music", "files");
    fs.mkdirSync(files, { recursive: true });
    for (const name of IDENTITY_FILES) fs.writeFileSync(path.join(files, name), `id-${name}`);
    expect(stageIdentityAtBase(dir)).toBe(3);
    for (const name of IDENTITY_FILES) {
      expect(fs.readFileSync(path.join(dir, name), "utf8")).toBe(`id-${name}`);
    }
    // A backend refresh must survive re-staging.
    fs.writeFileSync(path.join(dir, "adi.pb"), "refreshed");
    expect(stageIdentityAtBase(dir)).toBe(0);
    expect(fs.readFileSync(path.join(dir, "adi.pb"), "utf8")).toBe("refreshed");
    // Missing image identity is not an error.
    fs.rmSync(files, { recursive: true, force: true });
    fs.rmSync(path.join(dir, "fsi.pdat"));
    expect(stageIdentityAtBase(dir)).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
