import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const childProcess =
  require("child_process") as typeof import("node:child_process");

interface ReleaseCredentials {
  isOfficialBuild(env?: NodeJS.ProcessEnv): boolean;
  validateCredentialPair(
    env: NodeJS.ProcessEnv,
    firstName: string,
    secondName: string,
    required?: boolean,
  ): boolean;
}

const { isOfficialBuild, validateCredentialPair } =
  require("../scripts/release-credentials.cjs") as ReleaseCredentials;

interface HookContext {
  electronPlatformName: string;
  targets?: { name: string }[];
  packager?: { projectDir: string };
}

type BuildHook = (context: HookContext) => Promise<void>;

const afterPack = require("../build/afterPack.cjs").default as BuildHook;
const builderWorkflow = readFileSync(".github/workflows/builder.yml", "utf8");
const manualSnapWorkflow = readFileSync(
  ".github/workflows/publish-snap-manual.yml",
  "utf8",
);
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  name: string;
  productName: string;
  devDependencies: { electron: string };
  build: {
    appId: string;
    publish: { provider: string; owner: string; repo: string };
    afterPack?: string;
    afterSign?: string;
    linux?: { target?: string[] };
    mac?: { target?: string[] };
    win?: { target?: string[] };
  };
};
const justfileContent = readFileSync("justfile", "utf8");
const afterPackSource = readFileSync("build/afterPack.cjs", "utf8");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("release credential gates", () => {
  it("recognises GitHub tag builds as official", () => {
    expect(isOfficialBuild({ GITHUB_REF_TYPE: "tag" })).toBe(true);
    expect(isOfficialBuild({ GITHUB_REF_TYPE: "branch" })).toBe(false);
    expect(isOfficialBuild({})).toBe(false);
    // A fork without Last.fm secrets opts out explicitly instead of failing.
    expect(
      isOfficialBuild({ GITHUB_REF_TYPE: "tag", LIDRA_ALLOW_MISSING_CREDENTIALS: "1" }),
    ).toBe(false);
  });

  it("allows an unconfigured local build", () => {
    expect(validateCredentialPair({}, "KEY", "SECRET")).toBe(false);
  });

  it("rejects a partial credential pair", () => {
    expect(() =>
      validateCredentialPair({ KEY: "key" }, "KEY", "SECRET"),
    ).toThrow("KEY and SECRET must be set together");
    expect(() =>
      validateCredentialPair({ SECRET: "secret" }, "KEY", "SECRET"),
    ).toThrow("KEY and SECRET must be set together");
  });

  it("requires a complete pair for an official build", () => {
    expect(() => validateCredentialPair({}, "KEY", "SECRET", true)).toThrow(
      "KEY and SECRET are required for tag builds",
    );
    expect(
      validateCredentialPair(
        { KEY: "key", SECRET: "secret" },
        "KEY",
        "SECRET",
        true,
      ),
    ).toBe(true);
  });
});

describe("stock Electron build gates", () => {
  it("pins Electron to a stock semver range (not a castlabs/git URL)", () => {
    const electronDep = packageJson.devDependencies.electron;
    expect(electronDep).toMatch(/^[\^~]?\d+\.\d+\.\d+/);
    expect(electronDep).not.toMatch(/castlabs/i);
    expect(electronDep).not.toMatch(/github:/);
    expect(electronDep).not.toMatch(/git\+/);
    expect(electronDep).not.toMatch(/:\/\//);
  });

  it("publishes to github evangit2/lidra", () => {
    expect(packageJson.build.publish).toEqual({
      provider: "github",
      owner: "evangit2",
      repo: "lidra",
    });
  });

  it("uses the Lidra appId", () => {
    expect(packageJson.build.appId).toBe("io.github.evangit2.lidra");
  });

  it("keeps all release targets present", () => {
    const linux = (packageJson.build.linux?.target ?? []).map((t) =>
      t.toLowerCase(),
    );
    for (const target of ["appimage", "deb", "rpm", "flatpak", "snap"]) {
      expect(linux).toContain(target);
    }
    expect((packageJson.build.mac?.target ?? []).map((t) => t.toLowerCase())).toContain("dmg");
    expect((packageJson.build.win?.target ?? []).map((t) => t.toLowerCase())).toContain("nsis");
  });

  it("registers only the Flatpak AppStream hook", () => {
    expect(packageJson.build.afterPack).toBe("build/afterPack.cjs");
    expect(packageJson.build.afterSign).toBeUndefined();
  });

  it("afterPack requires appstream and ignores non-flatpak platforms", async () => {
    expect(afterPackSource).toContain('require("./appstream.cjs")');
    expect(afterPackSource).not.toMatch(/EVS|VMP|signVmp|castlabs/i);
    expect(existsSync("build/evs.cjs")).toBe(false);
    expect(existsSync("build/signVmp.cjs")).toBe(false);
    expect(existsSync("build/afterSign.cjs")).toBe(false);

    // Non-linux platforms do nothing.
    await expect(
      afterPack({ electronPlatformName: "darwin", targets: [{ name: "dmg" }] }),
    ).resolves.toBeUndefined();
    await expect(
      afterPack({ electronPlatformName: "win32", targets: [{ name: "nsis" }] }),
    ).resolves.toBeUndefined();
    // Linux without flatpak does nothing and does not touch flatpak deps.
    await expect(
      afterPack({ electronPlatformName: "linux", targets: [{ name: "deb" }] }),
    ).resolves.toBeUndefined();
  });

  it("retains no EVS/VMP/castlabs references in build, scripts, justfile, package.json", () => {
    const scanFiles: string[] = [];
    for (const file of readdirSync("build")) {
      if (!file.endsWith(".cjs") && !file.endsWith(".js")) continue;
      scanFiles.push(path.join("build", file));
    }
    for (const file of readdirSync("scripts")) {
      if (!file.endsWith(".cjs") && !file.endsWith(".js")) continue;
      if (file === "validate-build-config.cjs") continue;
      scanFiles.push(path.join("scripts", file));
    }
    scanFiles.push("justfile", "package.json");

    for (const file of scanFiles) {
      const content = readFileSync(file, "utf8");
      expect(content).not.toMatch(/EVS/);
      expect(content).not.toMatch(/VMP/);
      expect(content).not.toMatch(/castlabs/i);
    }
    expect(justfileContent).not.toMatch(/_sign-evs/);
    expect(justfileContent).not.toMatch(/EVS|VMP|castlabs/i);
  });

  it("justfile keeps _fix-frameworks and drops _sign-evs", () => {
    expect(justfileContent).toContain("_fix-frameworks");
    expect(justfileContent).not.toContain("_sign-evs");
    expect(justfileContent).toContain("build: _fix-frameworks");
    expect(justfileContent).not.toContain("build: _fix-frameworks _sign-evs");
  });

  it("builder workflow has no EVS plumbing but keeps Last.fm and artefacts", () => {
    expect(builderWorkflow).not.toMatch(/EVS_ACCOUNT_NAME/);
    expect(builderWorkflow).not.toMatch(/EVS_PASSWD/);
    expect(builderWorkflow).not.toMatch(/release-evs/);
    expect(builderWorkflow).not.toMatch(/VMP|castlabs/i);
    expect(builderWorkflow).toContain("LIDRA_LASTFM_API_KEY");
    expect(builderWorkflow).toContain("LIDRA_LASTFM_API_SECRET");
    expect(builderWorkflow).toContain("RELEASE_ARTEFACTS");
    // Keep platform matrix.
    expect(builderWorkflow).toContain("--linux AppImage deb rpm flatpak");
    expect(builderWorkflow).toContain("--mac dmg");
    expect(builderWorkflow).toContain("--win nsis");
  });

  it("validate-build-config passes for the stock-Electron layout", () => {
    const result = childProcess.spawnSync(
      process.execPath,
      ["scripts/validate-build-config.cjs"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1" },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("All configuration checks passed");
  });
});

describe("release build scripts", () => {
  it("fails Last.fm injection before writing an unconfigured tag build", () => {
    const result = childProcess.spawnSync(
      process.execPath,
      ["scripts/inject-lastfm-credentials.cjs"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_REF_TYPE: "tag",
          LIDRA_LASTFM_API_KEY: "",
          LIDRA_LASTFM_API_SECRET: "",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "LIDRA_LASTFM_API_KEY and LIDRA_LASTFM_API_SECRET are required for tag builds",
    );
  });
});

it("restricts Last.fm credentials to tag builds", () => {
  expect(builderWorkflow).toContain(
    "LIDRA_LASTFM_API_KEY: ${{ startsWith(github.ref, 'refs/tags/') && secrets.LIDRA_LASTFM_API_KEY || '' }}",
  );
  expect(builderWorkflow).toContain(
    "LIDRA_LASTFM_API_SECRET: ${{ startsWith(github.ref, 'refs/tags/') && secrets.LIDRA_LASTFM_API_SECRET || '' }}",
  );
});

it("does not expose EVS credentials to the Linux Snap build", () => {
  expect(manualSnapWorkflow).not.toContain("EVS_ACCOUNT_NAME");
  expect(manualSnapWorkflow).not.toContain("EVS_PASSWD");
});
