#!/usr/bin/env node
/**
 * Fail the build when a package is missing the bundled high-quality runtime.
 *
 * The payload is an `extraResources` entry, so a packaging change or a broken
 * checkout silently produces a release that cannot play lossless at all. The
 * build log says so here instead of leaving it for a user to discover.
 *
 * macOS ships no runtime (the Linux service cannot run there), so on darwin
 * this check passes trivially.
 */
const fs = require("node:fs");
const path = require("node:path");

if (process.platform === "darwin") {
  console.log("✓ macOS ships no FairPlay runtime (web player only)");
  process.exit(0);
}

// electron-builder writes to `release/`; older configs used `dist/`.
const ROOTS = [path.join(__dirname, "..", "release"), path.join(__dirname, "..", "dist")];

function find(directory, depth = 0) {
  if (depth > 10) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...find(full, depth + 1));
    // Windows ships the environment as an archive the importer consumes;
    // Linux ships the staged tree plus the backend package.
    else if (entry.name === "fairplay-rootfs.tar.gz" && fs.statSync(full).size > 1_000_000) found.push(full);
    else if (path.basename(full) === "wrapper" && full.includes("fairplay-payload")) found.push(full);
    else if (path.basename(full) === "__main__.py" && full.includes(path.join("fairplay_decrypter"))) found.push(full);
  }
  return found;
}

const runtimes = ROOTS.flatMap((root) => find(root)).filter((file) => {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
});

if (runtimes.length === 0) {
  console.error(
    "✗ no high-quality runtime in release/ (looked for fairplay-payload/launcher, the fairplay package, and fairplay-rootfs.tar.gz)",
  );
  process.exit(1);
}

for (const file of runtimes) {
  console.log(`✓ ${path.relative(path.join(__dirname, ".."), file)} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
}
