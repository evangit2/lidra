#!/usr/bin/env node
/**
 * Fail a packaging run that would ship the wrong ffmpeg binary.
 *
 * `ffmpeg-static` installs the binary for the *host* platform, so building for
 * another platform (or another CPU architecture) silently produces a package
 * whose ffmpeg cannot execute. Lidra falls back to PATH at runtime, which hides
 * the problem as "lossless sometimes doesn't work". This check makes it a build
 * failure instead.
 *
 * Usage: node scripts/verify-packaged-ffmpeg.cjs [--platform=<win32|darwin|linux>] [dir...]
 * With no directory it searches release/ for unpacked app trees.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.dirname(__dirname);
const args = process.argv.slice(2);
const platformArg = args.find((arg) => arg.startsWith("--platform="));
const platform = platformArg ? platformArg.split("=")[1] : process.platform;
const explicitDirs = args.filter((arg) => !arg.startsWith("--"));

/** Magic bytes that identify the executable format each platform needs. */
const FORMATS = {
  linux: { name: "ELF", test: (buf) => buf[0] === 0x7f && buf.toString("latin1", 1, 4) === "ELF" },
  win32: { name: "PE", test: (buf) => buf[0] === 0x4d && buf[1] === 0x5a },
  darwin: {
    name: "Mach-O",
    test: (buf) => {
      const magic = buf.readUInt32BE(0);
      const LE = buf.readUInt32LE(0);
      // 32/64-bit thin and fat binaries, both byte orders.
      return (
        magic === 0xcffaedfe ||
        magic === 0xcefaedfe ||
        magic === 0xcafebabe ||
        LE === 0xcffaedfe ||
        LE === 0xcefaedfe ||
        LE === 0xcafebabe
      );
    },
  },
};

const expected = FORMATS[platform];
if (!expected) {
  console.error(`verify-packaged-ffmpeg: unsupported platform ${platform}`);
  process.exit(2);
}

/** Find unpacked app trees under release/. */
function candidateDirs() {
  if (explicitDirs.length > 0) return explicitDirs;
  const release = path.join(root, "release");
  if (!fs.existsSync(release)) return [];
  const found = [];
  for (const entry of fs.readdirSync(release)) {
    const full = path.join(release, entry);
    if (!fs.statSync(full).isDirectory()) continue;
    // linux-unpacked, win-unpacked, mac/Lidra.app/Contents/Resources
    const resources = [
      path.join(full, "resources"),
      path.join(full, "Lidra.app", "Contents", "Resources"),
      path.join(full, "Contents", "Resources"),
    ];
    for (const candidate of resources) {
      if (fs.existsSync(path.join(candidate, "app.asar"))) found.push(candidate);
    }
  }
  return found;
}

/** Locate the bundled ffmpeg inside a Resources directory. */
function bundledBinary(resources) {
  const dir = path.join(resources, "app.asar.unpacked", "node_modules", "ffmpeg-static");
  if (!fs.existsSync(dir)) return { dir, binary: null };
  const files = fs.readdirSync(dir).filter((name) => name.startsWith("ffmpeg") && !name.includes("."));
  const withExe = fs.readdirSync(dir).find((name) => name === "ffmpeg.exe");
  return { dir, binary: withExe ? path.join(dir, withExe) : files.length ? path.join(dir, files[0]) : null };
}

const resourcesDirs = candidateDirs();
if (resourcesDirs.length === 0) {
  console.error(
    "verify-packaged-ffmpeg: no packaged app found (looked for release/*/resources/app.asar). Build first, or pass a Resources directory.",
  );
  process.exit(2);
}

let failures = 0;
for (const resources of resourcesDirs) {
  const { binary } = bundledBinary(resources);
  const label = path.relative(root, resources);
  if (!binary) {
    console.error(`✗ ${label}: no bundled ffmpeg`);
    failures += 1;
    continue;
  }
  const handle = fs.openSync(binary, "r");
  const header = Buffer.alloc(8);
  fs.readSync(handle, header, 0, 8, 0);
  fs.closeSync(handle);

  const wantedName = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const nameOk = path.basename(binary) === wantedName;
  const formatOk = expected.test(header);

  if (!nameOk || !formatOk) {
    console.error(
      `✗ ${label}: bundled ffmpeg is ${path.basename(binary)} (${formatOk ? expected.name : "unknown format"}), expected ${wantedName} (${expected.name})`,
    );
    failures += 1;
    continue;
  }
  console.log(`✓ ${label}: ${wantedName} is a ${expected.name} binary`);
}

if (failures > 0) {
  console.error(
    "\nThe packaged app would ship an ffmpeg that cannot run on its own platform.\n" +
      "Reinstall dependencies on the target platform (npm ci) before packaging.",
  );
  process.exit(1);
}
