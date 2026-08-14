import { contextBridge, ipcRenderer } from "electron";
import { IPC, type DesktopApi, type DesktopInfo, type ThemePreference, type UpdateChannel } from "../shared/contracts.js";

const api: DesktopApi = {
  getInfo: () => ipcRenderer.invoke(IPC.getInfo),
  restartHarness: () => ipcRenderer.invoke(IPC.restartHarness),
  chooseWorkspace: () => ipcRenderer.invoke(IPC.chooseWorkspace),
  openLogs: () => ipcRenderer.invoke(IPC.openLogs),
  checkUpdate: () => ipcRenderer.invoke(IPC.checkUpdate),
  downloadUpdate: () => ipcRenderer.invoke(IPC.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(IPC.installUpdate),
  setUpdateChannel: (channel: UpdateChannel) => ipcRenderer.invoke(IPC.setUpdateChannel, channel),
  setThemePreference: (preference: ThemePreference) => ipcRenderer.invoke(IPC.setThemePreference, preference),
  finishSplashAnimation: () => ipcRenderer.invoke(IPC.finishSplashAnimation),
  retryStartup: () => ipcRenderer.invoke(IPC.retryStartup),
  setCredential: (name: string, value: string) => ipcRenderer.invoke(IPC.setCredential, name, value),
  hasCredential: (name: string) => ipcRenderer.invoke(IPC.hasCredential, name),
  removeCredential: (name: string) => ipcRenderer.invoke(IPC.removeCredential, name),
  onInfoChanged: (listener: (info: DesktopInfo) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: DesktopInfo) => listener(info);
    ipcRenderer.on(IPC.infoChanged, handler);
    return () => ipcRenderer.removeListener(IPC.infoChanged, handler);
  },
  onSplashReady: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(IPC.splashReady, handler);
    return () => ipcRenderer.removeListener(IPC.splashReady, handler);
  }
};

contextBridge.exposeInMainWorld("desktop", api);
