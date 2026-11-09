/**
 * First-run FairPlay sign-in window.
 *
 * Instead of a web-player sign-in, the app authorises the device through the
 * vendored fairplay-decrypter backend: Apple ID + password, then the Apple
 * 2FA code when the backend asks for it. Resolves true once the backend
 * reports a signed-in session, false when the user cancels or it fails.
 */
import { BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import log from "electron-log/main";
import { getAssetPath } from "./paths";
import { login as fairplayLogin, type FairplayEnv } from "./audio/fairplay/service";

const loginLog = log.scope("fairplay-login");

export async function runFairplayLogin(
  parent: BrowserWindow | null,
  env: FairplayEnv,
): Promise<boolean> {
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
  const finish = (ok: boolean): boolean => {
    if (done) return ok;
    done = true;
    ipcMain.off("lidra:fairplay-creds", onCreds);
    ipcMain.off("lidra:fairplay-code", onCode);
    ipcMain.off("lidra:fairplay-cancel", onCancel);
    if (!win.isDestroyed()) win.close();
    return ok;
  };
  let resolveOuter: (ok: boolean) => void = () => {};
  const result = new Promise<boolean>((resolve) => {
    resolveOuter = resolve;
  });
  const settle = (ok: boolean): void => resolveOuter(finish(ok));

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
      .then((ok) => {
        loginLog.info(ok ? "sign-in complete" : "sign-in failed");
        if (!ok) phase("error", "Sign-in did not complete — check the details and try again.");
        else settle(true);
      })
      .catch((e: unknown) => {
        loginLog.warn(`sign-in error: ${String(e)}`);
        phase("error", "Sign-in did not complete — check the details and try again.");
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
    // Abort the backend wait immediately; its promise settles false.
    aborter.abort();
    settle(false);
  };
  ipcMain.on("lidra:fairplay-creds", onCreds);
  ipcMain.on("lidra:fairplay-code", onCode);
  ipcMain.on("lidra:fairplay-cancel", onCancel);

  win.once("ready-to-show", () => win.show());
  win.once("closed", () => {
    aborter.abort();
    settle(false);
  });
  void win.loadURL(pageUrl);
  return result;
}
