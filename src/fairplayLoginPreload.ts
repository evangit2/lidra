import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("lidraFairplayLogin", {
  submitCreds: (user: string, password: string) =>
    ipcRenderer.send("lidra:fairplay-creds", { user, password }),
  submitCode: (code: string) => ipcRenderer.send("lidra:fairplay-code", code),
  cancel: () => ipcRenderer.send("lidra:fairplay-cancel"),
  onPhase: (cb: (phase: string, message?: string) => void) =>
    ipcRenderer.on("lidra:fairplay-phase", (_event, phase: string, message?: string) =>
      cb(phase, message),
    ),
});
