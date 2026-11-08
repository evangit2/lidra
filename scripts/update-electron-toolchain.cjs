#!/usr/bin/env node
"use strict";

// Keep package.json on stable Electron, electron-builder and
// electron-updater releases without installing or building dependencies.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const packageJsonPath = "package.json";
const electronBuilderRepo =
  "https://github.com/electron-userland/electron-builder.git";

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function compareTriplets(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }

  return 0;
}

function parseTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (match === null) {
    return null;
  }

  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function latestElectronTag() {
  const refs = run("git", [
    "ls-remote",
    "--tags",
    "https://github.com/electron/electron.git",
    "refs/tags/v*",
  ]);

  // Drop the ^{} commit refs that git ls-remote emits alongside annotated tags.
  const latest = refs
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/)[1])
    .filter((ref) => ref !== undefined && !ref.endsWith("^{}"))
    .map((ref) => ref.replace("refs/tags/", ""))
    .map((tag) => ({ tag, parts: parseTag(tag) }))
    .filter((entry) => entry.parts !== null)
    .sort((left, right) => compareTriplets(left.parts, right.parts))
    .at(-1);

  if (latest === undefined) {
    throw new Error("No stable Electron tags found");
  }

  return latest.tag.replace(/^v/, "");
}

// Both packages share a repository. Match the <package>@ prefix to keep their
// release versions separate.
function latestElectronBuilderTag(packageName) {
  const tagPattern = new RegExp(`^${packageName}@(\\d+)\\.(\\d+)\\.(\\d+)$`);
  const refs = run("git", [
    "ls-remote",
    "--tags",
    electronBuilderRepo,
    `refs/tags/${packageName}@*`,
  ]);

  const latest = refs
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/)[1])
    .filter((ref) => ref !== undefined && !ref.endsWith("^{}"))
    .map((ref) => ref.replace("refs/tags/", ""))
    .map((tag) => {
      const match = tagPattern.exec(tag);
      return {
        tag,
        parts: match?.slice(1).map((part) => Number.parseInt(part, 10)) ?? null,
      };
    })
    .filter((entry) => entry.parts !== null)
    .sort((left, right) => compareTriplets(left.parts, right.parts))
    .at(-1);

  if (latest === undefined) {
    throw new Error(`No stable ${packageName} tags found`);
  }

  return latest.tag.replace(`${packageName}@`, "");
}

// Reject missing keys so a moved or renamed dependency cannot gain a duplicate
// entry in the expected section.
function setDependency(packageJson, section, name, value) {
  if (packageJson[section]?.[name] === undefined) {
    throw new Error(`${section}.${name} is missing from package.json`);
  }

  if (packageJson[section][name] === value) {
    return false;
  }

  packageJson[section][name] = value;
  console.log(`${name}: ${value}`);
  return true;
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const targets = {
  electron: `^${latestElectronTag()}`,
  "electron-builder": `^${latestElectronBuilderTag("electron-builder")}`,
  "electron-updater": `^${latestElectronBuilderTag("electron-updater")}`,
};

const changed = [
  setDependency(packageJson, "devDependencies", "electron", targets.electron),
  setDependency(
    packageJson,
    "devDependencies",
    "electron-builder",
    targets["electron-builder"],
  ),
  setDependency(
    packageJson,
    "dependencies",
    "electron-updater",
    targets["electron-updater"],
  ),
].some(Boolean);

if (changed) {
  fs.writeFileSync(
    packageJsonPath,
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
} else {
  console.log("Electron toolchain is current");
}
