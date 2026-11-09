import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  Tray,
  webFrameMain,
} from "electron";
import fs from "fs";
import path from "path";
import log from "electron-log/main";
import { AUTH_FIX_TOKEN, PASSKEY_CONTAINER_SELECTORS } from "./authFrame";
import {
  getZoomFactor,
  getCloseToTrayEnabled,
  getMusicService,
} from "./config";
import {
  getLoadingText,
  getNavigationStrings,
  getTrayStrings,
  NAV_LABELS_TOKEN,
} from "./i18n";
import { getAssetPath, getDesktopId } from "./paths";
import { Player, IntegrationContext } from "./player";
import {
  buildAppleMusicURL,
  buildItmsRouteURL,
  handleStorefrontNavigation,
  handleLastPageNavigation,
  initPageLanguageTracking,
} from "./storefront";
import { extractItmsUrlFromArgv, type ItmsTarget } from "./itms";
import {
  initServiceSwitch,
  routeToMusicService,
  switchService,
} from "./serviceSwitch";
import { initThemeCSS, injectThemeCss, setThemeChangedCallback } from "./theme";
import {
  createTray,
  getMenuIcon,
  initTrayStateManager,
  rebuildTrayMenu,
  setGetMainWindowCallback,
} from "./tray";
import { initSettingsActions, notifySettingsChanged } from "./settings";
import { handleSettingsNavigation, initSettingsWindow } from "./settingsWindow";
import { initCommandBridge } from "./commandBridge";
import { initControllerIPC, goBackIfPossible } from "./controllerIPC";
import { CONTROLLER_RESET_CHANNEL } from "./controller";
import { showAboutWindow } from "./aboutWindow";
import { checkForUpdates } from "./update";
import { isAutoUpdateSupported, initAutoUpdate } from "./autoUpdate";
import {
  getService,
  allServices,
  isAllowedNavigationUrl,
} from "./musicService";
import { init as initNotifications } from "./integrations/notifications";
import { init as initDiscordPresence } from "./integrations/discord-presence";
import { init as initLastfm } from "./integrations/lastfm";
import { init as initDock } from "./integrations/macos-dock";
import { init as initWindowsTaskbar } from "./integrations/windows-taskbar";
import { cleanArtworkCache } from "./artwork";
import {
  init as initWedgeDetector,
  reset as resetWedgeDetector,
} from "./wedgeDetector";
import { contentReadyProbeScript } from "./contentReady";
import { initNotificationProbe } from "./notify";
import { AudioEngine } from "./audio/engine";
import {
  account as fairplayAccount,
  buildEnv as buildFairplayEnv,
  buildWslEnv,
  codeFileFor,
  findPackageDir,
  findPython,
  isServiceInstall,
  login as fairplayLoginCli,
  stageRuntime as stageFairplayRuntime,
  status as fairplayStatus,
  type FairplayEnv,
} from "./audio/fairplay/service";
import {
  diagnoseWslRuntime,
  ensureWslRuntime,
  writeDiagnoseReport,
  WSL_DISTRO,
  WSL_PAYLOAD_REVISION,
  WSL_PYTHON,
} from "./audio/fairplay/wsl";
import { runFairplayLogin } from "./fairplayLoginWindow";
import { initAudioBridge } from "./audio/bridge";
import { findFfmpeg } from "./audio/transcode";
import {
  getAudioEnabled,
  getAudioEmeShim,
  getAudioFfmpegPath,
  getAudioQuality,
  getAudioSpatial,
  getStorefront as getAudioStorefront,
} from "./config";
import { errorMessage, liveWebContents, runSteps } from "./utils";
import { openExternalUrl } from "./utils/openExternal";

const SPLASH_MIN_DISPLAY_MS = 500;
const CONTENT_READY_POLL_MS = 100;
const CONTENT_READY_TIMEOUT_MS = 3500;
const CSS_READY_TIMEOUT_MS = 10000;
const UPDATE_CHECK_DELAY_MS = 5000;
const SPLASH_WIDTH_PX = 300;
const SPLASH_HEIGHT_PX = 350;
const MAIN_WINDOW_WIDTH_PX = 1280;
const MAIN_WINDOW_HEIGHT_PX = 800;
const PRELOAD_ERROR_NAMES = new Set([
  "AggregateError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

// --- Logging: initialise before anything else ---
log.initialize();
log.transports.file.level = "info";
log.transports.console.level = app.isPackaged ? false : "debug";
log.transports.file.format =
  "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}";
log.transports.console.format = "{h}:{i}:{s}.{ms} [{level}]{scope} {text}";

// Override log levels via environment variable (used by `just run-debug`).
type LogLevel = "error" | "warn" | "info" | "debug" | "silly";
const VALID_LEVELS = new Set<LogLevel>([
  "error",
  "warn",
  "info",
  "debug",
  "silly",
]);
const envLevel = process.env.ELECTRON_LOG_LEVEL;
if (envLevel && VALID_LEVELS.has(envLevel as LogLevel)) {
  const level = envLevel as LogLevel;
  log.transports.file.level = level;
  log.transports.console.level = level;
}

const mainLog = log.scope("main");
const splashLog = log.scope("splash");
mainLog.info(`${app.name} ${app.getVersion()}`);

app.on("child-process-gone", (_event, details) => {
  const serviceName =
    details.serviceName === undefined
      ? ""
      : ` serviceName=${JSON.stringify(details.serviceName)}`;
  mainLog.warn(
    `event=child-process-gone processType=${details.type} reason=${details.reason} exitCode=${details.exitCode}${serviceName}`,
  );
});

// --- App identity: must be set before app.whenReady() on Windows, or neither
// desktop notifications nor the GSMTC media identity attach to Lidra ---
if (process.platform === "win32") {
  app.setAppUserModelId("com.evangit2.lidra");
}

// --- Platform switches: must run before app.whenReady() ---
if (process.platform === "linux") {
  app.commandLine.appendSwitch(
    "enable-features",
    "UseOzonePlatform,WaylandWindowDecorations",
  );
  // MediaSessionService off: Lidra registers its own MPRIS service, and
  // Chromium's would be a second, conflicting registration on the same bus.
  // AudioServiceOutOfProcess off: it moves audio back in-process, which is
  // where SetGlobalAppName can reach PulseAudio at all.
  app.commandLine.appendSwitch(
    "disable-features",
    "MediaSessionService,WaylandWpColorManagerV1,AudioServiceOutOfProcess",
  );
  // Match the installed desktop entry so GetXdgAppId() uses its ID and
  // GetPossiblyOverriddenApplicationName() can read its Name= field.
  // Pairs with the AudioServiceOutOfProcess switch above: without both, the
  // PulseAudio stream is labelled "Chromium" and no PULSE_PROP_* override helps.
  app.setDesktopName(`${getDesktopId()}.desktop`);
  mainLog.info("Linux platform switches applied");
}

// macOS GUI launches can omit TMPDIR, which prevents Discord IPC socket discovery.
if (process.platform === "darwin") process.env.TMPDIR = app.getPath("temp");

// Use a platform-accurate Chrome UA, stripping Electron identifiers that
// Apple Music detects and blocks. The platform component must be truthful
// to match Sec-CH-UA-Platform Client Hints sent on every request.
// Read the Chrome major from process.versions.chrome so CastLabs ECS updates
// also update the UA. Chrome's reduced UA fixes the other components at 0.
function chromeUA(): string {
  const version = `${process.versions.chrome.split(".")[0]}.0.0.0`;
  const webkit = "AppleWebKit/537.36 (KHTML, like Gecko)";
  const safari = "Safari/537.36";
  if (process.platform === "darwin") {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${webkit} Chrome/${version} ${safari}`;
  }
  if (process.platform === "win32") {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${webkit} Chrome/${version} ${safari}`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) ${webkit} Chrome/${version} ${safari}`;
}

// Set fallback UA before app.whenReady() so any early requests use it
const UA = chromeUA();
app.userAgentFallback = UA;

// Prevent garbage collection of tray icon
let appTray: Tray | null = null;

let isQuitting = false;
app.on("before-quit", () => {
  isQuitting = true;
});

let win: BrowserWindow | null = null;
/**
 * The wrapper command in force. Windows builds it from the imported WSL
 * environment at runtime, so the configured value is not always the real one.
 */
let activeWrapperCommand: string | null = null;
let audioEngine: AudioEngine | null = null;
let rendererDocumentGeneration = 0;

// Single-instance lock: forward subsequent launches to the running instance so
// itms:// URLs from a second invocation are routed instead of opening a new
// window. macOS uses LSOpenURLSpec (open-url event) and never spawns a second
// process, so the lock is unnecessary there.
const gotLock =
  process.platform === "darwin" || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Capture any itms:// argument from initial launch argv. macOS delivers URLs
// via the open-url event, not argv, and itms:// is not registered there
// (Music.app handles it natively).
let pendingItmsTarget: ItmsTarget | null =
  process.platform !== "darwin" ? extractItmsUrlFromArgv(process.argv) : null;

function focusMainWindow(): void {
  if (!win) return;
  const wasHidden = !win.isVisible();
  if (wasHidden) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
  if (wasHidden && appTray) rebuildTrayMenu(appTray);
}

function routeItmsTarget(target: ItmsTarget | null): void {
  if (!target) return;
  if (!win) {
    pendingItmsTarget = target;
    return;
  }
  // Resolved before the switch; buildItmsRouteURL pins the music origin itself.
  const url =
    target.kind === "url" ? target.url : buildItmsRouteURL(target.token);
  routeToMusicService(url);
  mainLog.info(`itms target routed: kind=${target.kind}`);
}

/** Local styles and scripts prepared for injection into service pages and authentication frames. */
export interface Assets {
  STYLE_FIX_CSS: string;
  authFrameScript: string;
  navBarScript: string;
  hookScript: string;
  fastQueueScript: string;
  drmShimScript: string;
  drmShimEnabled: boolean;
  qualityBadgeScript: string;
}

function createSplash(): {
  splash: BrowserWindow;
  minDisplay: Promise<void>;
  cssReady: Promise<void>;
  markCssReady: () => void;
} {
  const splashZoom = getZoomFactor();
  const splash = new BrowserWindow({
    width: Math.round(SPLASH_WIDTH_PX * splashZoom),
    height: Math.round(SPLASH_HEIGHT_PX * splashZoom),
    frame: false,
    resizable: false,
    fullscreenable: false,
    fullscreen: false,
    center: true,
    skipTaskbar: true,
    backgroundColor: "#121F1D",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const { text: loadingText, lang: loadingLang } = getLoadingText();
  splash.loadFile(getAssetPath("assets", "splash.html"), {
    query: { text: loadingText, lang: loadingLang },
  });
  splash.show();
  splashLog.info("splash shown");
  splash.webContents.on("did-finish-load", () => {
    splash.webContents.setZoomFactor(getZoomFactor());
  });
  let resolveMinDisplay!: () => void;
  const minDisplay = new Promise<void>((resolve) => {
    resolveMinDisplay = resolve;
  });
  setTimeout(resolveMinDisplay, SPLASH_MIN_DISPLAY_MS);
  let resolveCssReady!: () => void;
  // The timeout guarantees that setupSplashTransition() can finish if an event
  // handler fails before it calls markCssReady(). An unsettled cssReady would
  // otherwise keep the splash open and the main window hidden.
  const cssReady = Promise.race([
    new Promise<void>((resolve) => {
      resolveCssReady = resolve;
    }),
    new Promise<void>((resolve) => setTimeout(resolve, CSS_READY_TIMEOUT_MS)),
  ]);
  splashLog.info("splash created");
  return {
    splash,
    minDisplay,
    cssReady,
    markCssReady: () => resolveCssReady(),
  };
}

function setupApplicationMenu(): void {
  if (process.env.LIDRA_DEVTOOLS === "1") {
    const menuTemplate: Electron.MenuItemConstructorOptions[] = [
      {
        role: "viewMenu",
        submenu: [{ role: "toggleDevTools" }],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  } else if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: app.name,
          submenu: [
            {
              label: getTrayStrings().about,
              ...(getMenuIcon("about") ? { icon: getMenuIcon("about") } : {}),
              click: () => showAboutWindow(),
            },
            { type: "separator" },
            { role: "quit" },
          ],
        },
      ]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }
  mainLog.info("application menu set");
}

// The renderer→main channels split by owner: the nav: prefix is the navigation
// bar's namespace, and every other channel is a MusicKit event for the Player.
// Each table below is a total record over its half, so a channel renamed in
// src/types/hook.d.ts and a channel added there with no listener both fail tsc
// here rather than compiling on and never firing.
type NavSendChannel = Extract<SendChannel, `nav:${string}`>;
type PlayerSendChannel = Exclude<SendChannel, NavSendChannel>;
type SendListener = Parameters<typeof ipcMain.on>[1];

// Object.keys() preserves insertion order, so listeners register in the order
// the table lists them.
function onSendChannels<C extends SendChannel>(
  listeners: Record<C, SendListener>,
  accepts?: (
    event: Electron.IpcMainEvent,
    data: unknown,
    generation: unknown,
  ) => boolean,
): void {
  for (const channel of Object.keys(listeners) as C[]) {
    ipcMain.on(
      channel,
      accepts
        ? (event, data, generation) => {
            if (accepts(event, data, generation))
              listeners[channel](event, data);
          }
        : listeners[channel],
    );
  }
}

function initPlayerIPC(): Player {
  const player = new Player();
  onSendChannels<PlayerSendChannel>(
    {
      hookReady: (event, generation) => {
        if (
          generation !== rendererDocumentGeneration ||
          event.sender !== win?.webContents ||
          event.senderFrame !== win.webContents.mainFrame
        )
          return;
        player.handleHookReady(event.senderFrame.url);
      },
      playbackCapabilitiesDidChange: (_event, data) =>
        player.handlePlaybackCapabilitiesDidChange(data),
      playbackStopped: (_event, data) => player.handlePlaybackStopped(data),
      playbackStateDidChange: (_event, data) =>
        player.handlePlaybackStateDidChange(data),
      nowPlayingItemDidChange: (_event, data) =>
        player.handleNowPlayingItemDidChange(data),
      queueDidChange: (_event, data) => player.handleQueueDidChange(data),
      timedMetadataDidChange: (_event, data) =>
        player.handleTimedMetadataDidChange(data),
      playbackTimeDidChange: (_event, data) =>
        player.handlePlaybackTimeDidChange(data),
      repeatModeDidChange: (_event, data) =>
        player.handleRepeatModeDidChange(data),
      shuffleModeDidChange: (_event, data) =>
        player.handleShuffleModeDidChange(data),
      volumeDidChange: (_event, data) => player.handleVolumeDidChange(data),
    },
    (event, _data, generation) =>
      generation === rendererDocumentGeneration &&
      event.sender === win?.webContents &&
      event.senderFrame === win.webContents.mainFrame,
  );
  return player;
}

/**
 * Build and start the native audio pipeline.
 *
 * Returns the engine so the settings pane and shutdown path can reach it.
 * Failures are logged, never fatal: if the pipeline cannot start, Lidra falls
 * back to the page's own playback attempt instead of refusing to launch.
 */
/**
 * Show the measured quality in the page. Failures are cosmetic and never affect
 * playback, so they are logged at debug level only.
 */
function publishQuality(payload: {
  label: string;
  verdict: "ok" | "mismatch";
  requested?: string;
  mismatches?: string[];
  tier?: string;
  detail?: string;
  codec?: string;
  sampleRate?: number;
  bitDepth?: number | null;
  channels?: number;
  bitrateKbps?: number | null;
  transport?: string;
  verified?: boolean;
}): void {
  if (!win || win.isDestroyed()) return;
  const script = `window.__lidraQuality && window.__lidraQuality(${JSON.stringify(payload)})`;
  win.webContents.executeJavaScript(script).catch((error: unknown) => {
    mainLog.debug(`quality badge update skipped: ${String(error)}`);
  });
}

/** Vendored FairPlay backend environment. Null on macOS, where the Linux service cannot run. */
let fairplayEnv: FairplayEnv | null = null;
/** Last backend setup failure, surfaced through the status channels (no popup). */
let fairplaySetupError: string | null = null;
/** Last sign-in failure reason, surfaced through the status channels. */
let lastLoginError: string | null = null;
/** Guards the "no key" login prompt so one playback failure opens one window. */
let fairplayLoginOpen = false;
/** The no-key prompt fires once per launch; later failures only touch the pill. */
let fairplayAutoPrompted = false;

/** True when `sudo -n true` succeeds (the service needs mounts on Linux). */
async function passwordlessSudo(): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("sudo", ["-n", "true"], (error) => resolve(!error));
  });
}

/** Payload candidates: packaged resources first, source tree second. */
function fairplayPayloadCandidates(): string[] {
  const roots = [process.resourcesPath, app.getAppPath()];
  const out: string[] = [];
  for (const root of roots) {
    out.push(path.join(root, "fairplay-payload"));
    out.push(path.join(root, "vendor", "wrapper", "opt", "lidra"));
  }
  return out;
}

function findServicePayload(): string | null {
  for (const dir of fairplayPayloadCandidates()) {
    if (isServiceInstall(dir)) return dir;
  }
  return null;
}

/**
 * Linux: stage the shipped service payload into writable per-app state and
 * build the backend environment. No sudo on userns hosts.
 */
async function setupFairplayLinux(): Promise<FairplayEnv | null> {
  const packageDir = findPackageDir(process.resourcesPath, app.getAppPath());
  if (!packageDir) {
    mainLog.error("fairplay backend missing from the package");
    return null;
  }
  const python = findPython();
  if (!python) {
    mainLog.error("python3 not found: install python3 for high-quality playback");
    return null;
  }
  const env = buildFairplayEnv(
    { packageDir, stateDir: path.join(app.getPath("userData"), "fairplay") },
    python,
  );
  if (!env.serviceDir) {
    const payload = findServicePayload();
    if (!payload) {
      mainLog.error("fairplay service payload missing from the package");
      return null;
    }
    try {
      const staged = stageFairplayRuntime(payload, env);
      env.serviceDir = staged;
    } catch (error) {
      mainLog.error(`fairplay staging failed: ${errorMessage(error)}`);
      return null;
    }
  }
  if (!(await passwordlessSudo())) {
    mainLog.info("no passwordless sudo; starting the service without it");
    env.noSudo = true;
  }
  return env;
}

/** Windows: everything runs inside the private WSL distro. */
async function setupFairplayWindows(): Promise<FairplayEnv | null> {
  publishQuality({
    label: "Preparing high-quality audio",
    verdict: "ok",
    detail: "importing the Linux runtime this build ships with — first run only, a minute or two",
  });
  const candidates = [
    path.join(process.resourcesPath, "wrapper", "wrapper-rootfs.tar.gz"),
    path.join(app.getAppPath(), "build", "wrapper-tar", "wrapper-rootfs.tar.gz"),
  ];
  const archive = candidates.find((p) => {
    try {
      return fs.statSync(p).size > 1_000_000;
    } catch {
      return false;
    }
  });
  const setup = await ensureWslRuntime({
    archivePath: archive ?? null,
    onProgress: (message: string) => mainLog.info(`fairplay setup: ${message}`),
  });
  if (!setup.ok) {
    mainLog.error(`high-quality audio is unavailable: ${setup.detail}${setup.hint ? ` — ${setup.hint}` : ""}`);
    publishQuality({ label: "High-quality setup needed", detail: setup.hint ? `${setup.detail} — ${setup.hint}` : setup.detail, verdict: "mismatch" });
    return null;
  }
  mainLog.info(`fairplay setup: ${setup.detail} (payload ${WSL_PAYLOAD_REVISION}, distro ${WSL_DISTRO})`);
  return buildWslEnv({ distro: WSL_DISTRO, python: WSL_PYTHON });
}

/**
 * Adopt the backend's store-services session for the web player.
 *
 * A media-user-token is what music.apple.com uses for a signed-in session, so
 * a single Apple ID entry (the FairPlay login) is enough for both the audio
 * pipeline and the UI. Returns true when a cookie was written.
 */
async function applyFairplaySession(ses: Electron.Session): Promise<boolean> {
  if (!fairplayEnv) return false;
  let account;
  try {
    account = await fairplayAccount(fairplayEnv);
  } catch {
    return false;
  }
  // Replace a stale value, and leave an identical one alone. Keeping whatever
  // cookie was already there meant an expired session kept the player on
  // previews even after a fresh sign-in.
  const existing = await ses.cookies.get({ name: "media-user-token" });
  if (existing.some((cookie) => cookie.value === account.music_token)) {
    mainLog.info("fairplay session: player already carries it");
    return false;
  }
  mainLog.info(
    `fairplay session: adopting token ${account.music_token.slice(0, 8)}... (had ${existing.length})`,
  );
  for (const url of ["https://music.apple.com/", "https://beta.music.apple.com/"]) {
    await ses.cookies.set({
      url,
      name: "media-user-token",
      value: account.music_token,
      secure: true,
      httpOnly: false,
      sameSite: "no_restriction",
      expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 180,
    });
  }
  mainLog.info("web session adopted from the FairPlay sign-in");
  return true;
}

/** Reload every player window so it picks up the adopted session. */
function reloadPlayerWindows(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && window.webContents.getURL().includes("music.apple.com")) {
      window.webContents.reload();
    }
  }
}

/**
 * First-run and no-key sign-in. When the backend reports no signed-in
 * session, ask for the Apple ID in a native window (all platforms share the
 * UI; macOS never reaches it), adopt the session, and reload the player.
 * Resolves true when playback can proceed.
 */
async function ensureFairplaySession(parent: BrowserWindow | null): Promise<boolean> {
  if (!fairplayEnv) return false;
  const state = await fairplayStatus(fairplayEnv).catch(() => null);
  if (state?.session === "signed in") {
    const ses = session.fromPartition("persist:lidra");
    await applyFairplaySession(ses);
    return true;
  }
  if (process.platform === "darwin") return false;
  mainLog.info("no FairPlay session; opening the Apple ID sign-in");
  const outcome = await runFairplayLogin(parent, fairplayEnv);
  if (!outcome.ok) {
    if (outcome.error) lastLoginError = outcome.error;
    return false;
  }
  lastLoginError = null;
  const ses = session.fromPartition("persist:lidra");
  const applied = await applyFairplaySession(ses);
  if (applied) reloadPlayerWindows();
  return true;
}

/** Where the settings-screen sign-in drops the 2FA code for a waiting login. */
function writeCodeFile(env: FairplayEnv, code: string): void {
  if (!env.serviceDir) throw new Error("backend service is not staged");
  fs.mkdirSync(path.dirname(codeFileFor(env.serviceDir)), { recursive: true });
  fs.writeFileSync(codeFileFor(env.serviceDir), code, { mode: 0o600 });
}

/** Backend status in the shape the settings screen has always spoken. */
async function fairplayStatusJson(): Promise<{ state: string; detail: string }> {
  if (!fairplayEnv) {
    if (fairplaySetupError) return { state: "error", detail: fairplaySetupError };
    return { state: "unavailable", detail: "high-quality backend unavailable on this platform" };
  }
  try {
    const s = await fairplayStatus(fairplayEnv);
    if (s.session === "signed in") return { state: "running", detail: "signed in" };
    const suffix = lastLoginError ? ` (last sign-in failed: ${lastLoginError})` : "";
    return { state: "stopped", detail: `session: ${s.session}${suffix}` };
  } catch (error) {
    return { state: "error", detail: errorMessage(error) };
  }
}

/** A bare wsl.exe failure says nothing: collect each layer once and leave a report. */
let fairplayDiagnosed = false;
function diagnoseOnce(): void {
  if (fairplayDiagnosed) return;
  fairplayDiagnosed = true;
  try {
    const file = writeDiagnoseReport(diagnoseWslRuntime(), app.getPath("userData"));
    mainLog.error(`fairplay diagnosis written to ${file}`);
  } catch (error) {
    mainLog.error(`fairplay diagnosis failed: ${errorMessage(error)}`);
  }
}

/**
 * Stage the backend after the engine exists. Heavy on a cold Windows start
 * (WSL import), so it never throws: without a backend the app simply plays
 * through the web player.
 */
async function setupFairplayBackend(): Promise<void> {
  if (process.platform === "darwin") {
    mainLog.info("macOS: no FairPlay backend; the web player serves playback");
    return;
  }
  try {
    fairplayEnv =
      process.platform === "win32" ? await setupFairplayWindows() : await setupFairplayLinux();
  } catch (error) {
    const detail = `fairplay setup failed: ${errorMessage(error)}`;
    mainLog.error(detail);
    fairplaySetupError = detail;
    return;
  }
  if (!fairplayEnv) {
    mainLog.info(
      `fairplay backend unavailable${fairplaySetupError ? `: ${fairplaySetupError}` : ""}`,
    );
    return;
  }
  mainLog.info("fairplay backend ready");
  await applyFairplaySession(session.fromPartition("persist:lidra"));
  // Adopt or sign in shortly after launch so the first HQ play is warm.
  setTimeout(() => {
    void ensureFairplaySession(win)
      .then((ok) => {
        if (ok) reloadPlayerWindows();
      })
      .catch((error: unknown) => mainLog.warn(`fairplay sign-in failed: ${errorMessage(error)}`));
  }, 1_500);
}

function initAudioEngine(ses: Electron.Session): AudioEngine {
  const ffmpegPath = findFfmpeg(getAudioFfmpegPath() ?? undefined);
  if (ffmpegPath) {
    mainLog.info(`audio ffmpeg: ${ffmpegPath}`);
  } else {
    mainLog.error(
      "no ffmpeg available: lossless and Dolby playback will fail. Install ffmpeg or set LIDRA_FFMPEG.",
    );
  }
  const engine = new AudioEngine({
    getFairplay: () => fairplayEnv,
    cacheRoot: path.join(app.getPath("userData"), "audio-cache"),
    getStorefront: () => getAudioStorefront() ?? "us",
    getPreference: () => {
      const quality = getAudioQuality();
      return quality === "auto" ? null : quality;
    },
    ffmpegPath: ffmpegPath ?? undefined,
    getSpatial: getAudioSpatial,
    onStateChange: (snapshot) => {
      mainLog.info(
        `audio ${snapshot.state} ${snapshot.asset.name}` +
          (snapshot.variant ? ` [${snapshot.variant.audioGroup}]` : "") +
          (snapshot.check ? ` -> ${snapshot.check.label}` : "") +
          (snapshot.error ? `: ${snapshot.error}` : ""),
      );
      if (snapshot.state === "error" && snapshot.error) {
        // The pill has room for a name, not a stack of text: the message belongs
        // in the panel that opens on click.
        publishQuality({
          label: "Playback needs attention",
          detail: snapshot.error,
          verdict: "mismatch",
          requested: snapshot.variant?.tier,
        });
        // "No key": the backend has no signed-in session. Offer the native
        // sign-in once per launch; afterwards failures only touch the pill.
        if (
          !fairplayAutoPrompted &&
          fairplayEnv &&
          process.platform !== "darwin" &&
          /signed in|not signed|no key|session/i.test(snapshot.error)
        ) {
          fairplayAutoPrompted = true;
          fairplayLoginOpen = true;
          void ensureFairplaySession(win)
            .catch((e: unknown) => mainLog.warn(`sign-in prompt failed: ${errorMessage(e)}`))
            .finally(() => {
              fairplayLoginOpen = false;
            });
        }
      }
      // A cached track never re-enters "streaming"; its measured facts are just
      // as true, so publish on both transitions.
      if ((snapshot.state === "streaming" || snapshot.state === "complete") && snapshot.check) {
        const facts = snapshot.facts;
        publishQuality({
          label:
            snapshot.variant?.binaural && facts?.atmos
              ? `${snapshot.check.label} · JOC`
              : snapshot.check.label,
          verdict: snapshot.check.ok ? "ok" : "mismatch",
          requested: snapshot.variant?.tier,
          mismatches: snapshot.check.mismatches,
          tier: facts?.tier ?? snapshot.variant?.tier,
          detail: facts?.label ?? snapshot.variant?.audioGroup,
          codec: facts?.codec,
          sampleRate: facts?.sampleRate,
          bitDepth: facts?.bitDepth ?? null,
          channels: facts?.channels,
          bitrateKbps:
            facts?.bitrateKbps ??
            (snapshot.variant?.bandwidth ? Math.round(snapshot.variant.bandwidth / 1000) : null),
          transport: "Apple FairPlay · decrypter",
          verified: snapshot.check.ok,
        });
      }
    },
  });

  if (!getAudioEnabled()) {
    mainLog.info("native audio pipeline disabled by settings");
    return engine;
  }
  engine
    .start()
    .then(() => initAudioBridge({ session: ses, engine }))
    .catch((error: unknown) => {
      mainLog.error(
        `audio engine failed to start: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  ipcMain.handle("lidra:audio-status", () => engine.status());

  // FairPlay backend: staged into per-app state on Linux, inside the private
  // WSL2 distro on Windows. Setup is heavy on a cold start, so it runs after
  // the engine exists and never throws — without it the app plays through
  // the web player.
  void setupFairplayBackend();
  ipcMain.handle("lidra:fairplay-status", () => fairplayStatusJson());
  // The settings screen still talks about the "wrapper": same channels, new backend.
  ipcMain.handle("lidra:wrapper-status", () => fairplayStatusJson());
  ipcMain.handle("lidra:wrapper-signin", async (_event, payload: unknown) => {
    const { email, password, code } = (payload ?? {}) as Record<string, string | undefined>;
    if (!fairplayEnv) {
      return { state: "error", detail: "high-quality backend unavailable on this platform" };
    }
    // A code on its own is the retry path: a login is already waiting on that
    // file, so nothing else needs to be typed again.
    if (code?.trim() && (!email || !password)) {
      try {
        writeCodeFile(fairplayEnv, code.trim());
        mainLog.info("wrote the 2FA code for the running FairPlay login");
        return { state: "starting", detail: "2FA code written" };
      } catch (error) {
        return { state: "error", detail: `could not write the 2FA code: ${errorMessage(error)}` };
      }
    }
    if (!email || !password) {
      return { state: "error", detail: "Apple ID and password are required" };
    }
    // The backend login is a one-shot CLI run against Apple's store services.
    // Lidra passes the credentials straight through and keeps no copy.
    if (code?.trim()) {
      try {
        writeCodeFile(fairplayEnv, code.trim());
      } catch {
        /* the login run reports the real failure */
      }
    }
    try {
      const outcome = await fairplayLoginCli(fairplayEnv, email, password, {
        onNeedCode: () =>
          Promise.reject(
            new Error(
              "Apple asked for a 2FA code — enter it in the code field and sign in again",
            ),
          ),
      });
      if (!outcome.ok) {
        if (process.platform === "win32") diagnoseOnce();
        if (outcome.detail) lastLoginError = outcome.detail;
        return {
          state: "error",
          detail: outcome.detail ?? "sign-in failed",
        };
      }
      lastLoginError = null;
    } catch (error) {
      return { state: "error", detail: errorMessage(error) };
    }
    await applyFairplaySession(session.fromPartition("persist:lidra"));
    reloadPlayerWindows();
    return { state: "running", detail: "signed in" };
  });
  ipcMain.handle("lidra:signout", async () => {
    await ses.clearStorageData({
      storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"],
    });
    await ses.clearCache();
    const first = BrowserWindow.getAllWindows()[0];
    if (first) await first.webContents.session.clearAuthCache().catch(() => undefined);
    mainLog.info("signed out of the web session");
  });
  // The backend runs on demand per command; these stay for settings compat.
  ipcMain.handle("lidra:wrapper-start", () => fairplayStatusJson());
  ipcMain.handle("lidra:wrapper-stop", () => fairplayStatusJson());
  return engine;
}

async function initSession(): Promise<Electron.Session> {
  // Clear stale service worker and cache data before navigation starts. Lidra
  // ships no DRM component: playback is served by the local audio pipeline.
  const ses = session.fromPartition("persist:lidra");
  await ses.clearData({
    dataTypes: ["serviceWorkers", "cache"],
    origins: allServices().map((svc) => svc.origin),
  });

  // Set UA on the default session (updates navigator.userAgentData Client Hints)
  session.defaultSession.setUserAgent(UA);

  return ses;
}

function loadAssets(): Assets {
  const styleFixCssPath = getAssetPath("assets", "styleFix.css");
  const STYLE_FIX_CSS = fs.readFileSync(styleFixCssPath, "utf-8");
  const authStyleFixCssPath = getAssetPath("assets", "authStyleFix.css");
  const authCss = fs.readFileSync(authStyleFixCssPath, "utf-8");
  const authFramePath = getAssetPath("assets", "authFrameFix.js");
  const authFrameScript = fs
    .readFileSync(authFramePath, "utf-8")
    .replace(AUTH_FIX_TOKEN, () =>
      JSON.stringify({
        css: authCss,
        containerSelectors: PASSKEY_CONTAINER_SELECTORS,
        logPrefix: AUTH_FRAME_LOG_PREFIX,
      }),
    );
  const navBarPath = getAssetPath("assets", "navigationBar.js");
  const navBarScript = fs
    .readFileSync(navBarPath, "utf-8")
    .replace(NAV_LABELS_TOKEN, () => JSON.stringify(getNavigationStrings()));
  const hookPath = getAssetPath("assets", "musicKitHook.js");
  const hookScript = fs
    .readFileSync(hookPath, "utf-8")
    .replace("__LIDRA_SERVICE_HOSTS__", () =>
      JSON.stringify(allServices().map((service) => service.host)),
    );
  const fastQueueScript = fs.readFileSync(
    getAssetPath("assets", "fastPlaylistQueue.js"),
    "utf-8",
  );
  const drmShimEnabled = getAudioEmeShim();
  const drmShimScript = drmShimEnabled
    ? fs
        .readFileSync(getAssetPath("assets", "lidraDrm.js"), "utf-8")
        // replaceAll: the flag is named in the file's own comment, and replacing
        // only the first match substituted the comment instead of the check.
        .replaceAll("__LIDRA_EME__", "true")
    : "";
  const qualityBadgeScript = fs.readFileSync(
    getAssetPath("assets", "qualityBadge.js"),
    "utf-8",
  );
  return {
    STYLE_FIX_CSS,
    authFrameScript,
    navBarScript,
    hookScript,
    fastQueueScript,
    drmShimScript,
    drmShimEnabled,
    qualityBadgeScript,
  };
}


function createMainWindow(ses: Electron.Session): {
  win: BrowserWindow;
  winReady: Promise<void>;
} {
  const win = new BrowserWindow({
    title: app.getName(),
    width: MAIN_WINDOW_WIDTH_PX,
    height: MAIN_WINDOW_HEIGHT_PX,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#000000",
    webPreferences: {
      partition: "persist:lidra",
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
      plugins: true,
      sandbox: true,
    },
  });

  // The backend may already hold a session (it survives restarts); adopting it
  // before the first load means the player comes up signed in on its own.
  void applyFairplaySession(ses).catch((error) => {
    mainLog.warn(`could not adopt the FairPlay session: ${errorMessage(error)}`);
  });

  // did-finish-load fires while Apple Music is still an empty shell, so the
  // window is held back until the service's contentReadySelector appears in the
  // page. The poll starts at the first in-page navigation, which is where the
  // SPA takes over rendering, and a timeout shows the window regardless so a
  // selector Apple has renamed delays the launch instead of blocking it.
  let pollCancelled = false;
  const winReady = Promise.race([
    new Promise<void>((resolve) => {
      win.webContents.once("did-navigate-in-page", () => {
        const poll = () => {
          if (pollCancelled) return;
          // Guard the native webContents getter before creating the promise.
          // The startup timer can run after the window is destroyed.
          const contents = liveWebContents(win);
          if (!contents) return;
          const selector = getService(getMusicService()).contentReadySelector;
          contents
            .executeJavaScript(contentReadyProbeScript(selector))
            .then((ready) => {
              if (ready) resolve();
              else if (!pollCancelled) setTimeout(poll, CONTENT_READY_POLL_MS);
            })
            .catch(() => {
              if (!pollCancelled) setTimeout(poll, CONTENT_READY_POLL_MS);
            });
        };
        poll();
      });
    }),
    new Promise<void>((resolve) =>
      setTimeout(resolve, CONTENT_READY_TIMEOUT_MS),
    ),
  ]);
  winReady.then(() => {
    pollCancelled = true;
  });

  return { win, winReady };
}

function setupSplashTransition(
  win: BrowserWindow,
  splash: BrowserWindow,
  minDisplay: Promise<void>,
  cssReady: Promise<void>,
  winReady: Promise<void>,
): void {
  Promise.all([minDisplay, cssReady, winReady]).then(() => {
    win.show();
    splashLog.info("splash closed");
    splash.close();
  });
}

function setupSessionHeaders(ses: Electron.Session): void {
  // Set UA on the persist:lidra session used by the window
  ses.setUserAgent(UA);

  // Strip Electron and app name tokens from outgoing request headers
  const urlFilters = allServices().map((svc) => `${svc.origin}/*`);
  ses.webRequest.onBeforeSendHeaders(
    { urls: urlFilters },
    (details, callback) => {
      const ua = details.requestHeaders["User-Agent"];
      if (ua && ua !== UA) {
        details.requestHeaders["User-Agent"] = UA;
      }
      callback({ requestHeaders: details.requestHeaders });
    },
  );
}

function setupWindowZoomAndNav(win: BrowserWindow): void {
  win.webContents.setZoomFactor(getZoomFactor());
  const onSettings: SendListener = (event) =>
    handleSettingsNavigation(event, win);
  win.once("closed", () => ipcMain.removeListener("nav:settings", onSettings));

  onSendChannels<NavSendChannel>({
    "nav:settings": onSettings,
    "nav:back": () => goBackIfPossible(win),
    "nav:forward": () => win.webContents.navigationHistory.goForward(),
    "nav:reload": () => {
      resetWedgeDetector();
      win.webContents.reload();
    },
  });
}

// Contain injection failures in both full-load and in-page navigation handlers.
// The URL read can throw after WebContents destruction, so it stays inside the catch.
// Separate catches let navigation controls load even when the MusicKit hook fails.
async function injectRendererScripts(
  win: BrowserWindow,
  assets: Assets,
  context: string,
): Promise<void> {
  try {
    const currentUrl = win.webContents.getURL();
    if (isAllowedNavigationUrl(currentUrl)) {
      if (assets.drmShimScript.length > 0) {
        try {
          await win.webContents.executeJavaScript(assets.drmShimScript);
          mainLog.debug("EME shim injected");
        } catch (e: unknown) {
          mainLog.warn(`failed to inject the EME shim ${context}:`, e);
        }
      }
      await win.webContents.executeJavaScript(
        assets.hookScript.replace("__LIDRA_DOCUMENT_GENERATION__", () =>
          String(rendererDocumentGeneration),
        ),
      );
      mainLog.debug("MusicKit hook injected");
      try {
        await win.webContents.executeJavaScript(assets.qualityBadgeScript);
        mainLog.debug("Quality badge injected");
      } catch (e: unknown) {
        mainLog.warn(`failed to inject qualityBadgeScript ${context}:`, e);
      }
      try {
        await win.webContents.executeJavaScript(assets.fastQueueScript);
        mainLog.debug("Fast playlist queue injected");
      } catch (e: unknown) {
        // Playback still works through Apple's slower queue, so this must not read as a hook failure.
        mainLog.warn(`failed to inject fastQueueScript ${context}:`, e);
      }
    } else {
      mainLog.warn(
        "skipped hookScript injection on disallowed host:",
        currentUrl,
      );
    }
  } catch (e: unknown) {
    mainLog.warn(`failed to inject hookScript ${context}:`, e);
  }
  try {
    await win.webContents.executeJavaScript(assets.navBarScript);
    mainLog.debug("Navigation bar injected");
  } catch (e: unknown) {
    mainLog.warn(`failed to inject navBarScript ${context}:`, e);
  }
}

function setupNavigationHandlers(win: BrowserWindow, player: Player): void {
  // Keep page-initiated main-frame navigation on registered service and authentication hosts.
  // Main-process loadURL() calls bypass this event and need their own validated targets.
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigationUrl(url)) {
      event.preventDefault();
      mainLog.warn("blocked navigation to disallowed host:", url);
    }
  });
  win.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame) {
      win.webContents.send(CONTROLLER_RESET_CHANNEL);
      mainLog.debug("did-start-navigation:", details.url);
    }
  });
  win.webContents.on("did-navigate", (_event, url) => {
    rendererDocumentGeneration += 1;
    player.resetForDocumentReplacement();
    mainLog.debug("did-navigate:", url);
    handleStorefrontNavigation(url);
  });
}

const AUTH_FRAME_HOSTS = new Set<string>(
  allServices().flatMap((svc) => [...svc.authFrameHosts]),
);
const AUTH_FRAME_LOG_PREFIX = "[lidra] auth-frame hide:";
const AUTH_CREDS_PREFIX = "[lidra] auth-creds:";
const AUTH_CODE_PREFIX = "[lidra] auth-code:";

function setupAuthFrameInjection(win: BrowserWindow, script: string): void {
  const authLog = log.scope("auth-frame");

  win.webContents.on(
    "did-frame-finish-load",
    (_event, isMainFrame, frameProcessId, frameRoutingId) => {
      if (isMainFrame) return;
      const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
      if (!frame) {
        authLog.warn(
          `webFrameMain.fromId returned null for processId=${frameProcessId} routingId=${frameRoutingId}`,
        );
        return;
      }
      let host: string;
      try {
        host = new URL(frame.url).hostname;
      } catch {
        return;
      }
      if (!AUTH_FRAME_HOSTS.has(host)) return;
      authLog.info(`auth iframe detected: ${frame.url}`);
      frame.executeJavaScript(script).catch((err) => {
        authLog.warn("auth iframe injection failed:", errorMessage(err));
      });
    },
  );

  win.webContents.on("console-message", (event) => {
    // Credential events from Apple's sign-in frame: swallow first, never log.
    // Sign-in now happens in the native FairPlay window; the frame's own
    // capture no longer drives anything.
    if (event.message.startsWith(AUTH_CREDS_PREFIX) || event.message.startsWith(AUTH_CODE_PREFIX)) {
      return;
    }
    if (!event.message.startsWith(AUTH_FRAME_LOG_PREFIX)) return;
    const frameHost = (() => {
      try {
        return new URL(event.frame.url).hostname;
      } catch {
        return "";
      }
    })();
    if (!AUTH_FRAME_HOSTS.has(frameHost)) return;
    authLog.info(event.message.slice(AUTH_FRAME_LOG_PREFIX.length).trim());
  });
}

function setupWindowEvents(win: BrowserWindow, markCssReady: () => void): void {
  win.webContents.on("unresponsive", () => {
    mainLog.warn("event=unresponsive processType=renderer");
  });
  win.webContents.on("responsive", () => {
    mainLog.info("event=responsive processType=renderer");
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    mainLog.error(
      `event=render-process-gone processType=renderer reason=${details.reason} exitCode=${details.exitCode}`,
    );
  });
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    const errorName = PRELOAD_ERROR_NAMES.has(error.name)
      ? error.name
      : "UnknownError";
    mainLog.warn(
      `event=preload-error processType=renderer preloadPath=${path.basename(preloadPath)} errorName=${errorName}`,
    );
  });

  win.on("page-title-updated", (event) => {
    event.preventDefault();
  });

  // A failed load cannot apply CSS, so release the splash without waiting for the fallback timeout.
  let cssMarked = false;
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    if (!cssMarked) {
      markCssReady();
      cssMarked = true;
    }
    mainLog.error("page load failed:", errorCode, errorDescription);
  });

  // Apple Music registers a beforeunload handler while audio plays. Electron
  // shows no confirmation dialog, so the handler silently blocks close() and
  // app.quit() with no error. Overriding it here lets Lidra exit.
  win.webContents.on("will-prevent-unload", (event) => {
    event.preventDefault();
  });

  win.on("close", (event) => {
    if (!isQuitting && getCloseToTrayEnabled()) {
      event.preventDefault();
      win.hide();
      mainLog.info("close intercepted: hiding window to tray");
      if (appTray) rebuildTrayMenu(appTray);
    }
  });

  // Keep external navigation out of the renderer and accept only HTTP or HTTPS URLs.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url, mainLog);
    return { action: "deny" };
  });
}

function setupContentHandlers(
  win: BrowserWindow,
  player: Player,
  markCssReady: () => void,
  assets: Assets,
): void {
  async function injectContent(): Promise<void> {
    mainLog.info("page loaded:", win.webContents.getURL());
    win.webContents.setZoomFactor(getZoomFactor());
    await win.webContents.insertCSS(assets.STYLE_FIX_CSS);
    mainLog.debug("CSS fixes injected");
    await injectThemeCss(win.webContents);
    await injectRendererScripts(win, assets, "on load");
  }

  let initialized = false;
  let integrationsReady = false;
  win.webContents.on("did-navigate-in-page", async (_event, url) => {
    handleStorefrontNavigation(url);
    handleLastPageNavigation(url);
    if (integrationsReady)
      await injectRendererScripts(win, assets, "on SPA navigation");
  });
  win.webContents.on("did-finish-load", async () => {
    // Claim initialisation before injectContent() yields. Two did-finish-load
    // events in one injection round trip must not register every integration twice.
    const firstLoad = !initialized;
    initialized = true;

    if (firstLoad) {
      // Isolate initialisers so one failure cannot skip the others or delay
      // markCssReady() until the splash timeout.
      runSteps(
        [
          [
            "notifications",
            () => initNotifications({ player, getMainWindow: () => win }),
          ],
          [
            "discord",
            () => initDiscordPresence({ player, getMainWindow: () => win }),
          ],
          ["lastfm", () => initLastfm({ player, getMainWindow: () => win })],
          ["dock", () => initDock({ player, getMainWindow: () => win })],
          [
            "windowsTaskbar",
            () => initWindowsTaskbar({ player, getMainWindow: () => win }),
          ],
          [
            "mpris",
            () => {
              if (process.platform !== "linux") return;
              const mpris = require("./integrations/mpris") as {
                init(ctx: IntegrationContext): void;
              };
              mpris.init({ player, getMainWindow: () => win });
            },
          ],
          [
            "wedgeDetector",
            () => initWedgeDetector({ player, getMainWindow: () => win }),
          ],
          [
            "trayState",
            () => {
              if (!appTray) return;
              // Register teardown so the tray timers and player listeners end on quit.
              const teardownTrayState = initTrayStateManager(player, appTray);
              app.on("will-quit", teardownTrayState);
            },
          ],
        ],
        (name, e) =>
          mainLog.error(`integration initialisation failed: ${name}:`, e),
      );
      integrationsReady = true;
    }

    // Register integrations before the hook sends its initial playback state.
    // Injection failure must still reach markCssReady() to dismiss the splash.
    try {
      await injectContent();
    } catch (e: unknown) {
      mainLog.warn("failed to inject content on load:", e);
    }

    if (firstLoad) {
      markCssReady();
      setTimeout(() => {
        if (appTray) {
          if (isAutoUpdateSupported()) {
            initAutoUpdate(appTray, rebuildTrayMenu);
          } else {
            checkForUpdates(appTray, rebuildTrayMenu);
          }
        }
      }, UPDATE_CHECK_DELAY_MS);
    }
  });
}

if (gotLock) {
  app.on("will-quit", () => {
    audioEngine?.stop().catch(() => {
      /* shutdown is best effort */
    });
  });

  app.on("second-instance", (_event, argv) => {
    const target = extractItmsUrlFromArgv(argv);
    routeItmsTarget(target);
    focusMainWindow();
  });

  app
    .whenReady()
    .then(async () => {
      mainLog.info("app ready");
      const { splash, minDisplay, cssReady, markCssReady } = createSplash();
      setupApplicationMenu();
      const player = initPlayerIPC();
      initNotificationProbe();
      const ses = await initSession();
      // A fault in the audio stack must not be able to stop the app from
      // opening: everything else (the player) still works without lossless.
      try {
        audioEngine = initAudioEngine(ses);
      } catch (error) {
        mainLog.error(`audio engine setup failed: ${errorMessage(error)}`);
      }
      cleanArtworkCache();

      if (process.platform === "linux" || process.platform === "win32") {
        const ok = app.setAsDefaultProtocolClient("itms");
        mainLog.info(`itms protocol registration: ${ok ? "ok" : "failed"}`);
      }
      // macOS omits open-url handling because Music.app handles itms:// natively.

      const assets = loadAssets();
      const created = createMainWindow(ses);
      win = created.win;
      const winReady = created.winReady;
      initCommandBridge((channel, ...args) => {
        const contents = liveWebContents(win);
        if (!contents) {
          mainLog.warn(
            `source=command channel=${channel} reason=renderer-gone result=dropped`,
          );
          return;
        }
        contents.send(channel, ...args);
      });
      initControllerIPC(win);
      setGetMainWindowCallback(() => win);
      initServiceSwitch({
        getTray: () => appTray,
        loadURL: (url) => {
          win
            ?.loadURL(url, { userAgent: UA })
            .catch((err) =>
              mainLog.warn(
                "service navigation loadURL failed:",
                errorMessage(err),
              ),
            );
          notifySettingsChanged();
        },
      });
      const teardownSettingsActions = initSettingsActions({
        getMainWindow: () => win,
        applyZoom: (factor) => liveWebContents(win)?.setZoomFactor(factor),
        switchService,
        refreshTray: () => {
          if (appTray) rebuildTrayMenu(appTray);
        },
      });
      app.on("will-quit", teardownSettingsActions);
      initSettingsWindow(win);
      setThemeChangedCallback(() => {
        if (appTray) rebuildTrayMenu(appTray);
        notifySettingsChanged();
      });
      setupWindowZoomAndNav(win);
      initThemeCSS(win);
      setupSplashTransition(win, splash, minDisplay, cssReady, winReady);
      setupSessionHeaders(ses);
      setupContentHandlers(win, player, markCssReady, assets);
      setupWindowEvents(win, markCssReady);
      setupNavigationHandlers(win, player);
      initPageLanguageTracking(win);
      setupAuthFrameInjection(win, assets.authFrameScript);
      appTray = createTray();
      if (process.env.LIDRA_DEVTOOLS === "1") {
        win.webContents.openDevTools();
        mainLog.info("DevTools opened (LIDRA_DEVTOOLS=1)");
      }
      mainLog.info("loading Apple Music...");
      win
        .loadURL(buildAppleMusicURL(), { userAgent: UA })
        .catch((err) =>
          mainLog.warn("initial navigation loadURL failed:", errorMessage(err)),
        );

      // Drain any itms target captured at launch. Routed after the initial home
      // load so the content-ready probe binds to its first did-navigate-in-page.
      winReady.then(() => {
        if (pendingItmsTarget) {
          routeItmsTarget(pendingItmsTarget);
          pendingItmsTarget = null;
        }
      });
    })
    .catch((err: unknown) => {
      // The splash is already on screen and setupSplashTransition() was never
      // reached, so without this catch a startup failure leaves the splash up
      // for the life of the process with no message.
      mainLog.error("startup failed:", err);
      const detail = errorMessage(err);
      dialog.showErrorBox(
        "Lidra failed to start",
        `Lidra could not finish starting.\n\n${detail}\n\nSee the Lidra log for details, then start Lidra again.`,
      );
      app.quit();
    });
}

app.on("window-all-closed", () => {
  mainLog.info("all windows closed, quitting");
  app.quit();
});

// Restore a close-to-tray window when macOS activates Lidra from the dock.
app.on("activate", () => {
  focusMainWindow();
});
