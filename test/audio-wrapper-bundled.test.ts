import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildBundledCommand,
  bundledPayloadPaths,
  ensureBundledRuntime,
  findBundledPayload,
  packPayloadForImport,
} from "../src/audio/wrapper/bundled";

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lidra-bundled-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makePayload(directory: string): string {
  for (const relative of [
    "bin/busybox",
    "bin/sh",
    "lib64/ld-linux-x86-64.so.2",
    "lib/x86_64-linux-gnu/libc.so.6",
    "opt/lidra/wrapper",
    "opt/lidra/rootfs/system/lib64/libc.so",
  ]) {
    const file = path.join(directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative);
  }
  return directory;
}

describe("the shipped payload", () => {
  it("is looked for in resources and in the repo's vendor directory", () => {
    const paths = bundledPayloadPaths("/opt/Lidra/resources", "/home/me/lidra");
    expect(paths[0]).toBe("/opt/Lidra/resources/wrapper");
    expect(paths[1]).toBe("/home/me/lidra/vendor/wrapper");
  });

  it("only accepts a tree that is complete", () => {
    const partial = fs.mkdtempSync(path.join(root, "partial-"));
    fs.mkdirSync(path.join(partial, "bin"), { recursive: true });
    fs.writeFileSync(path.join(partial, "bin", "busybox"), "x");
    expect(findBundledPayload([partial])).toBeNull();
    expect(findBundledPayload([partial, makePayload(path.join(root, "full"))])?.kind).toBe("directory");
  });

  it("still accepts a packed payload for older layouts", () => {
    const archive = path.join(root, "wrapper-rootfs.tar.gz");
    fs.writeFileSync(archive, "payload");
    expect(findBundledPayload([archive])).toEqual({ kind: "archive", path: archive });
  });
});

describe("installing the payload", () => {
  it("refuses to run on a platform that cannot execute a Linux binary", async () => {
    const result = await ensureBundledRuntime({
      payloadPaths: [makePayload(path.join(root, "payload"))],
      installDir: path.join(root, "runtime"),
      platform: "darwin",
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Linux program");
  });

  it("says so when the build carries no payload", async () => {
    const result = await ensureBundledRuntime({
      payloadPaths: [path.join(root, "missing")],
      installDir: path.join(root, "runtime"),
      platform: "linux",
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("does not carry");
  });

  it("copies the tree once and records the revision it used", async () => {
    const payload = makePayload(path.join(root, "payload"));
    const installDir = path.join(root, "runtime");

    const noop = async () => ({ code: 0, stdout: "", stderr: "" });
    const first = await ensureBundledRuntime({
      payloadPaths: [payload],
      installDir,
      platform: "linux",
      runImpl: noop,
    });
    expect(first.ok).toBe(true);
    expect(first.wrapperDir).toBe(path.join(installDir, "opt", "lidra"));
    expect(fs.existsSync(path.join(installDir, "opt/lidra/rootfs/system/lib64/libc.so"))).toBe(true);
    expect(fs.statSync(path.join(installDir, "opt/lidra/wrapper")).mode & 0o111).not.toBe(0);

    const marker = path.join(installDir, ".lidra-payload");
    const before = fs.readFileSync(marker, "utf-8");
    const second = await ensureBundledRuntime({
      payloadPaths: [payload],
      installDir,
      platform: "linux",
      runImpl: noop,
    });
    expect(second.ok).toBe(true);
    expect(fs.readFileSync(marker, "utf-8")).toBe(before);
  });

  it("reports the parts a broken payload is missing", async () => {
    const payload = makePayload(path.join(root, "payload"));
    const installDir = path.join(root, "runtime");

    const result = await ensureBundledRuntime({
      payloadPaths: [payload],
      installDir,
      platform: "linux",
      // The copy is complete, then the scheduler step loses a file.
      runImpl: async () => {
        fs.rmSync(path.join(installDir, "lib64/ld-linux-x86-64.so.2"), { force: true });
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("incomplete");
  });
});

describe("packing for a WSL import", () => {
  it("packs a directory once and reuses the archive", async () => {
    const payloadDir = makePayload(path.join(root, "payload"));
    const target = path.join(root, "out", "wrapper-payload.tar.gz");
    const run = vi.fn(async () => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "packed");
      return { code: 0, stdout: "", stderr: "" };
    });

    const packed = await packPayloadForImport({
      payload: { kind: "directory", path: payloadDir },
      targetPath: target,
      runImpl: run,
    });
    expect(packed).toBe(target);
    expect(run).toHaveBeenCalledTimes(1);

    const again = await packPayloadForImport({
      payload: { kind: "directory", path: payloadDir },
      targetPath: target,
      runImpl: run,
    });
    expect(again).toBe(target);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("passes an existing archive straight through", async () => {
    const archive = path.join(root, "shipped.tar.gz");
    fs.writeFileSync(archive, "payload");
    const run = vi.fn();
    const packed = await packPayloadForImport({
      payload: { kind: "archive", path: archive },
      targetPath: path.join(root, "unused.tar.gz"),
      runImpl: run as never,
    });
    expect(packed).toBe(archive);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("the launch line", () => {
  it("runs from the directory that holds rootfs, through the bundled loader", () => {
    const command = buildBundledCommand({
      wrapperDir: "/home/me/.config/Lidra/wrapper-runtime/opt/lidra",
      decryptPort: 10020,
      manifestPort: 20020,
    });
    expect(command).toContain("cd '/home/me/.config/Lidra/wrapper-runtime/opt/lidra' && sudo -n ");
    expect(command).toContain("../../lib64/ld-linux-x86-64.so.2");
    expect(command).toContain("--library-path ../../lib/x86_64-linux-gnu");
    expect(command).toContain("./wrapper -H 127.0.0.1 -D 10020 -M 20020 --base-dir rootfs");
  });

  it("leaves sudo out when the host does not offer it", () => {
    const command = buildBundledCommand({
      wrapperDir: "/opt/lidra",
      decryptPort: 10021,
      manifestPort: 20021,
      sudo: false,
    });
    expect(command).not.toContain("sudo");
    expect(command).toContain("./wrapper -H 127.0.0.1 -D 10021 -M 20021");
  });

  it("appends a login run after the base arguments", () => {
    const command = buildBundledCommand({
      wrapperDir: "/opt/lidra",
      decryptPort: 10020,
      manifestPort: 20020,
      extra: ["-L", "me@example.com:secret", "-F"],
    });
    expect(command.endsWith("--base-dir rootfs -L me@example.com:secret -F")).toBe(true);
  });
});
