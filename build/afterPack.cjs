"use strict";

/**
 * Generate Flatpak AppStream metadata after packaging.
 * package.json registers this hook through build.afterPack.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName === "linux" && context.targets.some((target) => target.name === "flatpak")) {
    const { generateAppStream } = require("./appstream.cjs");
    generateAppStream(context.packager.projectDir);
  }
};
