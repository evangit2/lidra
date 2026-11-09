#!/usr/bin/env node
/**
 * Fail the build when a package is missing the bundled lossless runtime.
 *
 * The payload is an `extraResources` entry, so a packaging change or a broken
 * checkout silently produces a release that cannot play lossless at all. The
 * build log says so here instead of leaving it for a user to discover.
 */
const fs = require("node:fs");
const path = require("node:path");

const WRAPPER = path.join("opt", "lidra", "wrapper");
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
    // Windows ships the environment as an archive the importer consumes; every
    // other platform ships the tree.
    else if (entry.name === "wrapper-rootfs.tar.gz" && fs.statSync(full).size > 1_000_000) found.push(full);
    else if (path.basename(full) === "wrapper" && full.endsWith(WRAPPER)) found.push(full);
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
    `✗ no lossless runtime in release/ (looked for resources/wrapper/${WRAPPER} and wrapper-rootfs.tar.gz)`,
  );
  process.exit(1);
}

for (const file of runtimes) {
  console.log(`✓ ${path.relative(path.join(__dirname, ".."), file)} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
}
