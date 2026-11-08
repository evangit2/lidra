import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("lidraTwoFactor", {
  submit: (code: string) => ipcRenderer.send("lidra:two-factor", code),
  cancel: () => ipcRenderer.send("lidra:two-factor", null),
});
