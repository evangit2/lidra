/**
 * First-run FairPlay sign-in window.
 *
 * Instead of a web-player sign-in, the app authorises the device through the
 * vendored fairplay-decrypter backend: Apple ID + password, then the Apple
 * 2FA code when the backend asks for it. Resolves with the backend's own
 * failure reason when sign-in does not complete, so the window and the
 * status channels can say what actually happened.
 */
import { BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import log from "electron-log/main";
import { getAssetPath } from "./paths";
import { login as fairplayLogin, type FairplayEnv, type LoginResult } from "./audio/fairplay/service";

const loginLog = log.scope("fairplay-login");

export interface FairplayLoginOutcome {
  ok: boolean;
  /** Present when the user did not cancel: what the backend reported. */
  error?: string;
}

export async function runFairplayLogin(
  parent: BrowserWindow | null,
  env: FairplayEnv,
): Promise<FairplayLoginOutcome> {
  const pageUrl = pathToFileURL(getAssetPath("assets", "fairplayLogin.html")).toString();
  const win = new BrowserWindow({
    parent: parent ?? undefined,
    modal: Boolean(parent),
    show: false,
    width: 460,
    height: 430,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Sign in with Apple ID",
    backgroundColor: "#1c1c1e",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "fairplayLoginPreload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  let done = false;
  let codeResolve: ((code: string) => void) | null = null;
  const aborter = new AbortController();
  const finish = (outcome: FairplayLoginOutcome): FairplayLoginOutcome => {
    if (done) return outcome;
    done = true;
    ipcMain.off("lidra:fairplay-creds", onCreds);
    ipcMain.off("lidra:fairplay-code", onCode);
    ipcMain.off("lidra:fairplay-cancel", onCancel);
    if (!win.isDestroyed()) win.close();
    return outcome;
  };
  let resolveOuter: (outcome: FairplayLoginOutcome) => void = () => {};
  const result = new Promise<FairplayLoginOutcome>((resolve) => {
    resolveOuter = resolve;
  });
  const settle = (outcome: FairplayLoginOutcome): void => resolveOuter(finish(outcome));

  const phase = (name: string, message?: string): void => {
    if (!win.isDestroyed()) win.webContents.send("lidra:fairplay-phase", name, message);
  };

  const onCreds = (
    event: Electron.IpcMainEvent,
    value: unknown,
  ): void => {
    if (event.sender !== win.webContents || done) return;
    const { user, password } = (value ?? {}) as { user?: unknown; password?: unknown };
    if (typeof user !== "string" || typeof password !== "string" || !user || !password) {
      phase("error", "Enter your Apple ID and password.");
      return;
    }
    phase("working", "Contacting Apple…");
    void fairplayLogin(
      env,
      user,
      password,
      {
        onNeedCode: () => {
          phase("code");
          return new Promise<string>((resolve) => {
            codeResolve = resolve;
          });
        },
      },
      240_000,
      aborter.signal,
    )
      .then((outcome: LoginResult) => {
        loginLog.info(outcome.ok ? "sign-in complete" : `sign-in failed: ${outcome.detail}`);
        if (!outcome.ok) {
          phase("error", `Sign-in did not complete — ${outcome.detail ?? "unknown error"}.`);
          // Promise resolution wins once: report the failure for the status
          // channels but leave the window open so the reason can be read and
          // the attempt retried. A later success still settles and closes.
          resolveOuter({ ok: false, error: outcome.detail });
        } else settle({ ok: true });
      })
      .catch((e: unknown) => {
        const detail = e instanceof Error ? e.message : String(e);
        loginLog.warn(`sign-in error: ${detail}`);
        phase("error", `Sign-in did not complete — ${detail}.`);
      });
  };
  const onCode = (event: Electron.IpcMainEvent, value: unknown): void => {
    if (event.sender !== win.webContents || done) return;
    const resolve = codeResolve;
    codeResolve = null;
    if (resolve && typeof value === "string" && value.trim()) {
      phase("working", "Verifying…");
      resolve(value.trim());
    }
  };
  const onCancel = (event: Electron.IpcMainEvent): void => {
    if (event.sender !== win.webContents || done) return;
    codeResolve = null;
    // Abort the backend wait immediately; its promise settles cancelled.
    aborter.abort();
    settle({ ok: false });
  };
  ipcMain.on("lidra:fairplay-creds", onCreds);
  ipcMain.on("lidra:fairplay-code", onCode);
  ipcMain.on("lidra:fairplay-cancel", onCancel);

  win.once("ready-to-show", () => win.show());
  win.once("closed", () => {
    aborter.abort();
    settle({ ok: false });
  });
  void win.loadURL(pageUrl);
  return result;
}
