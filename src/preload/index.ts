import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type DesktopApi,
  type DesktopInfo,
  type BillingModelTarget,
  type OpenWorkspaceRequest,
  type OpenWorkspaceResult,
  type ThemePreference,
  type UpdateChannel
} from "../shared/contracts.js";
import type { BillingSettings, BillingUsageIndex, BillingUsageReport } from "../shared/billing.js";

ipcRenderer.on(IPC.openWorkspace, (_event, request: OpenWorkspaceRequest) => {
  window.postMessage({ type: IPC.openWorkspace, request }, window.location.origin);
});

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = event.data as { type?: unknown; result?: unknown } | null;
  if (message?.type === IPC.harnessIntegrationReady) {
    ipcRenderer.send(IPC.harnessIntegrationReady);
  } else if (message?.type === IPC.openWorkspaceResult) {
    ipcRenderer.send(IPC.openWorkspaceResult, message.result as OpenWorkspaceResult);
  }
});

const api: DesktopApi = {
  getInfo: () => ipcRenderer.invoke(IPC.getInfo),
  restartHarness: () => ipcRenderer.invoke(IPC.restartHarness),
  chooseWorkspace: () => ipcRenderer.invoke(IPC.chooseWorkspace),
  openLogs: () => ipcRenderer.invoke(IPC.openLogs),
  openSettings: () => ipcRenderer.invoke(IPC.openSettings),
  openBilling: (target?: BillingModelTarget) => ipcRenderer.invoke(IPC.openBilling, target),
  checkUpdate: () => ipcRenderer.invoke(IPC.checkUpdate),
  checkHarnessUpdate: () => ipcRenderer.invoke(IPC.checkHarnessUpdate),
  downloadUpdate: () => ipcRenderer.invoke(IPC.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(IPC.installUpdate),
  setUpdateChannel: (channel: UpdateChannel) => ipcRenderer.invoke(IPC.setUpdateChannel, channel),
  setThemePreference: (preference: ThemePreference) => ipcRenderer.invoke(IPC.setThemePreference, preference),
  finishSplashAnimation: () => ipcRenderer.invoke(IPC.finishSplashAnimation),
  retryStartup: () => ipcRenderer.invoke(IPC.retryStartup),
  setCredential: (name: string, value: string) => ipcRenderer.invoke(IPC.setCredential, name, value),
  hasCredential: (name: string) => ipcRenderer.invoke(IPC.hasCredential, name),
  removeCredential: (name: string) => ipcRenderer.invoke(IPC.removeCredential, name),
  getBillingSettings: () => ipcRenderer.invoke(IPC.getBillingSettings),
  setBillingSettings: (settings: BillingSettings) => ipcRenderer.invoke(IPC.setBillingSettings, settings),
  checkBillingPrices: () => ipcRenderer.invoke(IPC.checkBillingPrices),
  reportBillingUsage: (index: BillingUsageIndex, currentTarget?: BillingModelTarget) => ipcRenderer.invoke(IPC.reportBillingUsage, index, currentTarget),
  getBillingUsage: () => ipcRenderer.invoke(IPC.getBillingUsage),
  onBillingUsageChanged: (listener: (report: BillingUsageReport) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, report: BillingUsageReport) => listener(report);
    ipcRenderer.on(IPC.billingUsageChanged, handler);
    return () => ipcRenderer.removeListener(IPC.billingUsageChanged, handler);
  },
  onBillingEditRequested: (listener: (target: BillingModelTarget) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, target: BillingModelTarget) => listener(target);
    ipcRenderer.on(IPC.billingEditRequested, handler);
    return () => ipcRenderer.removeListener(IPC.billingEditRequested, handler);
  },
  onInfoChanged: (listener: (info: DesktopInfo) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: DesktopInfo) => listener(info);
    ipcRenderer.on(IPC.infoChanged, handler);
    return () => ipcRenderer.removeListener(IPC.infoChanged, handler);
  },
  onBillingChanged: (listener: (settings: BillingSettings) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, settings: BillingSettings) => listener(settings);
    ipcRenderer.on(IPC.billingChanged, handler);
    return () => ipcRenderer.removeListener(IPC.billingChanged, handler);
  },
  onSplashReady: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(IPC.splashReady, handler);
    return () => ipcRenderer.removeListener(IPC.splashReady, handler);
  }
};

contextBridge.exposeInMainWorld("desktop", api);
