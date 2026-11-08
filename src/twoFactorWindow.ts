/**
 * The prompt Lidra shows when the wrapper's login needs Apple's 2FA code.
 *
 * Apple sends the code to the user's phone, but the wrapper can only receive it
 * as a file, so the app has to ask — a modal keeps that inside the sign-in the
 * user is already doing instead of sending them to a settings page mid-flow.
 */
import { BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import log from "electron-log/main";
import { getAssetPath } from "./paths";

const promptLog = log.scope("two-factor");

let promptWindow: BrowserWindow | null = null;
let pending: Promise<string | null> | null = null;
let settle: ((code: string | null) => void) | null = null;

/**
 * Show the code prompt. Resolves with the submitted code, or null when the
 * window is dismissed. A second call while it is open just focuses it.
 */
export function showTwoFactorPrompt(parent: BrowserWindow | null): Promise<string | null> {
  if (promptWindow && pending) {
    if (!promptWindow.isDestroyed()) promptWindow.focus();
    return pending;
  }

  const pageUrl = pathToFileURL(getAssetPath("assets", "twoFactor.html")).toString();
  const win = new BrowserWindow({
    parent: parent ?? undefined,
    modal: Boolean(parent),
    show: false,
    width: 420,
    height: 236,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Two-factor code",
    backgroundColor: "#111111",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "twoFactorPreload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  promptWindow = win;

  const done = (code: string | null): void => {
    const resolve = settle;
    settle = null;
    pending = null;
    if (resolve) resolve(code);
  };

  const handle = (event: Electron.IpcMainEvent, value: unknown): void => {
    if (event.sender !== win.webContents) return;
    const code = typeof value === "string" ? value.trim() : "";
    promptLog.info(code ? "2FA code submitted" : "2FA prompt dismissed");
    if (!win.isDestroyed()) win.close();
    done(code || null);
  };
  ipcMain.on("lidra:two-factor", handle);

  win.once("ready-to-show", () => win.show());
  win.once("closed", () => {
    ipcMain.off("lidra:two-factor", handle);
    promptWindow = null;
    done(null);
  });

  void win.loadURL(pageUrl);
  pending = new Promise<string | null>((resolve) => {
    settle = resolve;
  });
  return pending;
}

/** True while the prompt is on screen. */
export function twoFactorPromptOpen(): boolean {
  return promptWindow !== null;
}

/** Close the prompt without submitting (the login already finished or failed). */
export function dismissTwoFactorPrompt(): void {
  if (promptWindow && !promptWindow.isDestroyed()) promptWindow.close();
}
