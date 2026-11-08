// Validate packaging settings before installer creation. Local and CI gates use
// the same checks, so configuration faults fail before installers reach users.
const fs = require("fs");
const path = require("path");

function main() {
  const projectDir = process.cwd();

  // package.json holds the complete build configuration. No schema check runs
  // because electron-builder exposes no public validator. Internal paths under
  // app-builder-lib/out/ can break on dependency updates with module-not-found
  // errors instead of configuration errors.
  const pkg = JSON.parse(
    fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
  );
  const config = pkg.build ?? {};
  console.log(
    '  \\u2713 electron-builder config: read from package.json "build" (no schema check; electron-builder exposes no public validator)',
  );

  // Reject obsolete options that electron-builder can otherwise ignore.
  // Each error names the supported replacement.
  if (config.npmSkipBuildFromSource === false) {
    throw new Error(
      "npmSkipBuildFromSource is deprecated; use buildDependenciesFromSource",
    );
  }
  if (config.appImage != null && config.appImage.systemIntegration != null) {
    throw new Error(
      "appImage.systemIntegration is deprecated; use AppImageLauncher for desktop integration",
    );
  }
  if (config.extraMetadata != null) {
    if (config.extraMetadata.build != null) {
      throw new Error(
        "extraMetadata.build is deprecated; specify as -c instead",
      );
    }
    if (config.extraMetadata.directories != null) {
      throw new Error(
        "extraMetadata.directories is deprecated; specify as -c.directories instead",
      );
    }
  }
  console.log("  \\u2713 no deprecated options detected");

  // (a) devDependencies.electron must be a stock semver range, not a git/castlabs URL.
  const electronDep = pkg.devDependencies?.electron;
  if (typeof electronDep !== "string" || electronDep.trim() === "") {
    throw new Error("devDependencies.electron must be a non-empty string");
  }
  if (
    electronDep.includes("castlabs") ||
    electronDep.includes("github:") ||
    electronDep.includes("git+") ||
    electronDep.includes("://")
  ) {
    throw new Error(
      `devDependencies.electron must be a stock semver range, not a git/castlabs URL: ${electronDep}`,
    );
  }
  // Accept common semver ranges: ^45.2.3, ~45.2.3, 45.2.3, >=45.0.0, etc.
  if (!/^[\^~<>= ]*\d+\.\d+\.\d+/.test(electronDep.trim())) {
    throw new Error(
      `devDependencies.electron must be a stock semver range: ${electronDep}`,
    );
  }
  console.log(`  \\u2713 stock Electron: ${electronDep}`);

  // (b) build.publish must be {provider: github, owner: evangit2, repo: lidra}
  const publish = config.publish;
  if (
    publish?.provider !== "github" ||
    publish?.owner !== "evangit2" ||
    publish?.repo !== "lidra"
  ) {
    throw new Error(
      'build.publish must be {provider: \"github\", owner: \"evangit2\", repo: \"lidra\"}',
    );
  }
  console.log("  \\u2713 publish: github evangit2/lidra");

  // (c) build.appId must be io.github.evangit2.lidra
  if (config.appId !== "io.github.evangit2.lidra") {
    throw new Error('build.appId must be \"io.github.evangit2.lidra\"');
  }
  console.log("  \\u2713 appId: io.github.evangit2.lidra");

  // (d) All release targets must remain present.
  const linuxTargets = (config.linux?.target ?? []).map((t) =>
    String(t).toLowerCase(),
  );
  for (const required of ["appimage", "deb", "rpm", "flatpak", "snap"]) {
    if (!linuxTargets.includes(required)) {
      throw new Error(`build.linux.target must include \"${required}\"`);
    }
  }
  const macTargets = (config.mac?.target ?? []).map((t) =>
    String(t).toLowerCase(),
  );
  if (!macTargets.includes("dmg")) {
    throw new Error('build.mac.target must include \"dmg\"');
  }
  const winTargets = (config.win?.target ?? []).map((t) =>
    String(t).toLowerCase(),
  );
  if (!winTargets.includes("nsis")) {
    throw new Error('build.win.target must include \"nsis\"');
  }
  console.log("  \\u2713 release targets: linux (AppImage, deb, rpm, flatpak, snap), mac (dmg), win (nsis)");

  // (e) No EVS/VMP references may remain in build/, scripts/, justfile, package.json.
  const scanTargets = [];
  for (const file of fs.readdirSync(path.join(projectDir, "build"))) {
    if (!file.endsWith(".cjs") && !file.endsWith(".js")) continue;
    scanTargets.push(path.join(projectDir, "build", file));
  }
  for (const file of fs.readdirSync(path.join(projectDir, "scripts"))) {
    if (!file.endsWith(".cjs") && !file.endsWith(".js")) continue;
    const full = path.join(projectDir, "scripts", file);
    // Exclude this validator itself — it contains the forbidden strings as check logic.
    if (path.basename(full) === "validate-build-config.cjs") continue;
    scanTargets.push(full);
  }
  scanTargets.push(path.join(projectDir, "justfile"));
  scanTargets.push(path.join(projectDir, "package.json"));
  const forbidden = /EVS|VMP/;
  for (const filePath of scanTargets) {
    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (forbidden.test(content)) {
      throw new Error(
        `${path.relative(projectDir, filePath)} must not contain EVS/VMP references`,
      );
    }
    // Also reject castlabs URLs that would indicate a forked Electron.
    if (/castlabs/i.test(content)) {
      throw new Error(
        `${path.relative(projectDir, filePath)} must not contain castlabs references`,
      );
    }
  }
  console.log("  \\u2713 no EVS/VMP/castlabs references in build/, scripts/, justfile, package.json");

  const zypakStrategy = config.flatpak?.finishArgs?.filter((arg) =>
    arg.startsWith("--env=ZYPAK_ZYGOTE_STRATEGY_SPAWN="),
  ) ?? [];
  if (
    zypakStrategy.length !== 1 ||
    zypakStrategy[0] !== "--env=ZYPAK_ZYGOTE_STRATEGY_SPAWN=0"
  ) {
    throw new Error(
      "build.flatpak.finishArgs must set --env=ZYPAK_ZYGOTE_STRATEGY_SPAWN=0 exactly once",
    );
  }
  console.log("  \\u2713 Flatpak: Zypak spawn strategy disabled, sandbox retained");

  const nsis = config.nsis;
  if (nsis?.oneClick !== false) {
    throw new Error(
      "build.nsis.oneClick must be false to use the assisted installer",
    );
  }
  if (nsis.allowToChangeInstallationDirectory !== true) {
    throw new Error(
      "build.nsis.allowToChangeInstallationDirectory must be true",
    );
  }
  if (Object.hasOwn(nsis, "perMachine")) {
    throw new Error(
      "build.nsis.perMachine must remain unset so the installer offers per-user and all-users choices",
    );
  }
  if (Object.hasOwn(nsis, "selectPerMachineByDefault")) {
    throw new Error(
      "build.nsis.selectPerMachineByDefault must remain unset so per-user remains the default choice",
    );
  }
  if (nsis.deleteAppDataOnUninstall !== false) {
    throw new Error("build.nsis.deleteAppDataOnUninstall must remain false");
  }
  console.log(
    "  \\u2713 NSIS installer: assisted, per-user by default, install scope and directory selectable",
  );

  // FPM requires the author's email for the deb/rpm maintainer field.
  const author = pkg.author;
  const emailRegex = /<[^>]+@[^>]+>/;
  if (typeof author === "string") {
    if (!emailRegex.test(author)) {
      throw new Error(
        "package.json 'author' must include an email (e.g. \"Name <email>\").\n" +
          "Required for Linux .deb/.rpm maintainer field.",
      );
    }
  } else if (typeof author === "object" && author !== null) {
    if (!author.email) {
      throw new Error(
        "package.json 'author.email' must be set.\n" +
          "Required for Linux .deb/.rpm maintainer field.",
      );
    }
  } else {
    throw new Error("package.json 'author' field is missing.");
  }
  console.log("  \\u2713 package.json author email: present");

  // Pin the D-Bus commands for launcher controls, not their labels.
  // Match the MPRIS integration's lowercased app.getName(), which prefers
  // productName over name, so a product rename requires matching commands.
  const desktop = config.linux?.desktop;
  const busName = `org.mpris.MediaPlayer2.${String(pkg.productName ?? pkg.name).toLowerCase()}`;
  const actionMethods = ["PlayPause", "Next", "Previous", "Stop"];
  if (desktop?.entry?.Actions !== "PlayPause;Next;Previous;Stop;") {
    throw new Error(
      "Linux desktop entry Actions must be PlayPause;Next;Previous;Stop;",
    );
  }
  for (const method of actionMethods) {
    const action = desktop.desktopActions?.[method];
    if (action == null || typeof action !== "object") {
      throw new Error(`Linux desktop action ${method} is missing`);
    }
    if (typeof action.Name !== "string" || action.Name.trim() === "") {
      throw new Error(
        `Linux desktop action ${method}.Name must be a non-empty string`,
      );
    }
    // Match tokens so whitespace and option order can vary without accepting
    // a wrong command, destination, object path or member. The member must be
    // last because dbus-send treats later tokens as message arguments.
    const exec = typeof action.Exec === "string" ? action.Exec : "";
    const tokens = exec.split(/\s+/).filter((token) => token !== "");
    const command = tokens.shift() ?? "";
    if (command !== "dbus-send" && !command.endsWith("/dbus-send")) {
      throw new Error(`Linux desktop action ${method}.Exec must run dbus-send`);
    }
    if (!tokens.includes(`--dest=${busName}`)) {
      throw new Error(
        `Linux desktop action ${method}.Exec must target --dest=${busName}`,
      );
    }
    const operands = tokens.filter((token) => !token.startsWith("-"));
    if (operands[0] !== "/org/mpris/MediaPlayer2") {
      throw new Error(
        `Linux desktop action ${method}.Exec must use the object path /org/mpris/MediaPlayer2`,
      );
    }
    if (operands[1] !== `org.mpris.MediaPlayer2.Player.${method}`) {
      throw new Error(
        `Linux desktop action ${method}.Exec must call org.mpris.MediaPlayer2.Player.${method}`,
      );
    }
    if (
      tokens[tokens.length - 1] !== `org.mpris.MediaPlayer2.Player.${method}`
    ) {
      throw new Error(
        `Linux desktop action ${method}.Exec must end with org.mpris.MediaPlayer2.Player.${method}.\n` +
          "dbus-send stops parsing options at the member, so any later token is read as a\n" +
          "type:value message argument; a trailing flag or argument makes it exit 1 and the\n" +
          "call is never sent.",
      );
    }
  }
  console.log(`  \\u2713 Linux desktop actions: wired to ${busName}`);

  // electron-builder installs every PNG from the Linux icon directory under
  // hicolor/<size>x<size>/apps. Unregistered sizes are not discoverable. The
  // directory form can provide each registered size instead of one source size.
  const registeredHicolorSizes = new Set([
    16, 22, 24, 32, 36, 48, 64, 72, 96, 128, 192, 256, 512,
  ]);
  const iconSetting = config.linux?.icon;
  if (typeof iconSetting !== "string" || iconSetting === "") {
    throw new Error("build.linux.icon must name the Linux icon set directory");
  }
  const iconDir = path.join(projectDir, iconSetting);
  if (!fs.existsSync(iconDir) || !fs.statSync(iconDir).isDirectory()) {
    throw new Error(
      `build.linux.icon must be a directory of sized PNGs, not a single file: ${iconSetting}\n` +
        "electron-builder emits one icon from a single PNG and installs it under\n" +
        "hicolor/<size>x<size>/apps, so only that one size reaches the desktop.",
    );
  }
  const iconSizes = fs
    .readdirSync(iconDir)
    .map((name) => /^(\d+)x\1\.png$/.exec(name))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]));
  if (iconSizes.length === 0) {
    throw new Error(
      `build.linux.icon directory holds no <size>x<size>.png files: ${iconSetting}`,
    );
  }
  const unregistered = iconSizes
    .filter((size) => !registeredHicolorSizes.has(size))
    .sort((a, b) => a - b);
  if (unregistered.length > 0) {
    throw new Error(
      `build.linux.icon holds sizes the hicolor theme does not register: ${unregistered.join(", ")}.\n` +
        "Icons installed there are never found. Run just generate-assets.",
    );
  }
  if (!iconSizes.includes(512)) {
    throw new Error(
      "build.linux.icon must include 512x512.png, the largest registered hicolor size",
    );
  }
  console.log(
    `  \\u2713 Linux icon set: ${iconSizes.sort((a, b) => a - b).join(", ")} in registered hicolor sizes`,
  );

  // afterPack must remain the Flatpak AppStream hook; afterSign must be absent.
  if (config.afterPack !== "build/afterPack.cjs") {
    throw new Error('build.afterPack must be \"build/afterPack.cjs\"');
  }
  if (config.afterSign != null) {
    throw new Error("build.afterSign must not be set (VMP pipeline removed)");
  }
  console.log("  \\u2713 hooks: afterPack is Flatpak AppStream only, afterSign removed");

  console.log("\nAll configuration checks passed.");
}

try {
  main();
} catch (e) {
  console.error("\n  \\u2717 " + e.message);
  process.exit(1);
}
