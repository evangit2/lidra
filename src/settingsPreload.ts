import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { SettingsBridge, SettingsState } from "./settings";

// Expose only the Settings API. Keep Electron primitives out of the renderer world.
contextBridge.exposeInMainWorld("lidraSettings", {
  getState: () => ipcRenderer.invoke("settings:get"),
  apply: (action) => ipcRenderer.invoke("settings:apply", action),
  fairplaySignIn: (payload) => ipcRenderer.invoke("lidra:fairplay-signin", payload),
  signOut: () => ipcRenderer.invoke("lidra:signout"),
  onState: (listener) => {
    const onState = (_event: IpcRendererEvent, state: SettingsState): void =>
      listener(state);
    ipcRenderer.on("settings:state", onState);
    return () => {
      ipcRenderer.removeListener("settings:state", onState);
    };
  },
} satisfies SettingsBridge);
