import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type DesktopApi,
  type DesktopInfo,
  type BillingModelTarget,
  type OpenWorkspaceRequest,
  type OpenWorkspaceResult,
  type ThemePreference,
  type UpdateChannel,
  type VisionBackendConfig,
  type VisionSettings,
  type ChangeBatch,
} from "../shared/contracts.js";
import type {
  BillingSettings,
  BillingSettingsSnapshot,
  BillingUsageReport,
  BillingUsageSync,
} from "../shared/billing.js";
import type { QuotaSettings, QuotaSnapshot } from "../shared/quota.js";
import type { MemoryEntry } from "../shared/memory.js";

ipcRenderer.on(IPC.openWorkspace, (_event, request: OpenWorkspaceRequest) => {
  window.postMessage(
    { type: IPC.openWorkspace, request },
    window.location.origin,
  );
});

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== window.location.origin)
    return;
  const message = event.data as { type?: unknown; result?: unknown } | null;
  if (message?.type === IPC.harnessIntegrationReady) {
    ipcRenderer.send(IPC.harnessIntegrationReady);
  } else if (message?.type === IPC.openWorkspaceResult) {
    ipcRenderer.send(
      IPC.openWorkspaceResult,
      message.result as OpenWorkspaceResult,
    );
  }
});

const api: DesktopApi = {
  getInfo: () => ipcRenderer.invoke(IPC.getInfo),
  restartHarness: () => ipcRenderer.invoke(IPC.restartHarness),
  chooseWorkspace: () => ipcRenderer.invoke(IPC.chooseWorkspace),
  openLogs: () => ipcRenderer.invoke(IPC.openLogs),
  openSettings: () => ipcRenderer.invoke(IPC.openSettings),
  openBilling: (target?: BillingModelTarget) =>
    ipcRenderer.invoke(IPC.openBilling, target),
  openLegacyBilling: (target?: BillingModelTarget) =>
    ipcRenderer.invoke(IPC.openLegacyBilling, target),
  openWorkbench: (view = "changes") =>
    ipcRenderer.invoke(IPC.openWorkbench, view),
  checkUpdate: () => ipcRenderer.invoke(IPC.checkUpdate),
  checkHarnessUpdate: () => ipcRenderer.invoke(IPC.checkHarnessUpdate),
  downloadUpdate: () => ipcRenderer.invoke(IPC.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(IPC.installUpdate),
  setUpdateChannel: (channel: UpdateChannel) =>
    ipcRenderer.invoke(IPC.setUpdateChannel, channel),
  setThemePreference: (preference: ThemePreference) =>
    ipcRenderer.invoke(IPC.setThemePreference, preference),
  finishSplashAnimation: () => ipcRenderer.invoke(IPC.finishSplashAnimation),
  retryStartup: () => ipcRenderer.invoke(IPC.retryStartup),
  setCredential: (name: string, value: string) =>
    ipcRenderer.invoke(IPC.setCredential, name, value),
  hasCredential: (name: string) => ipcRenderer.invoke(IPC.hasCredential, name),
  removeCredential: (name: string) =>
    ipcRenderer.invoke(IPC.removeCredential, name),
  getDeepSeekBalance: () => ipcRenderer.invoke(IPC.getDeepSeekBalance),
  refreshDeepSeekBalance: () => ipcRenderer.invoke(IPC.refreshDeepSeekBalance),
  useOfficialBilling: (target: BillingModelTarget, catalogProvider: string) =>
    ipcRenderer.invoke(IPC.useOfficialBilling, target, catalogProvider),
  getBillingSettings: () => ipcRenderer.invoke(IPC.getBillingSettings),
  setBillingSettings: (settings: BillingSettings) =>
    ipcRenderer.invoke(IPC.setBillingSettings, settings),
  checkBillingPrices: () => ipcRenderer.invoke(IPC.checkBillingPrices),
  reportBillingUsage: (
    index: BillingUsageSync,
    currentTarget?: BillingModelTarget,
  ) => ipcRenderer.invoke(IPC.reportBillingUsage, index, currentTarget),
  getBillingUsage: () => ipcRenderer.invoke(IPC.getBillingUsage),
  onBillingUsageChanged: (listener: (report: BillingUsageReport) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      report: BillingUsageReport,
    ) => listener(report);
    ipcRenderer.on(IPC.billingUsageChanged, handler);
    return () => ipcRenderer.removeListener(IPC.billingUsageChanged, handler);
  },
  onBillingEditRequested: (listener: (target: BillingModelTarget) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      target: BillingModelTarget,
    ) => listener(target);
    ipcRenderer.on(IPC.billingEditRequested, handler);
    return () => ipcRenderer.removeListener(IPC.billingEditRequested, handler);
  },
  onInfoChanged: (listener: (info: DesktopInfo) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: DesktopInfo) =>
      listener(info);
    ipcRenderer.on(IPC.infoChanged, handler);
    return () => ipcRenderer.removeListener(IPC.infoChanged, handler);
  },
  onBillingChanged: (listener: (settings: BillingSettingsSnapshot) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      settings: BillingSettingsSnapshot,
    ) => listener(settings);
    ipcRenderer.on(IPC.billingChanged, handler);
    return () => ipcRenderer.removeListener(IPC.billingChanged, handler);
  },
  getQuotaUsage: () => ipcRenderer.invoke(IPC.getQuotaUsage),
  refreshQuotaUsage: () => ipcRenderer.invoke(IPC.refreshQuotaUsage),
  onQuotaUsageChanged: (
    listener: (snapshot: QuotaSnapshot) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: QuotaSnapshot,
    ) => listener(snapshot);
    ipcRenderer.on(IPC.quotaChanged, handler);
    return () => ipcRenderer.removeListener(IPC.quotaChanged, handler);
  },
  getQuotaSettings: () => ipcRenderer.invoke(IPC.getQuotaSettings),
  setQuotaSettings: (settings: QuotaSettings) =>
    ipcRenderer.invoke(IPC.setQuotaSettings, settings),
  getMemoryEntries: (): Promise<MemoryEntry[]> =>
    ipcRenderer.invoke(IPC.getMemoryEntries),
  deleteMemoryEntry: (id: string): Promise<MemoryEntry[]> =>
    ipcRenderer.invoke(IPC.deleteMemoryEntry, id),
  getMemoryToolsEnabled: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.getMemoryToolsEnabled),
  setMemoryToolsEnabled: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke(IPC.setMemoryToolsEnabled, enabled),
  onSplashReady: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(IPC.splashReady, handler);
    return () => ipcRenderer.removeListener(IPC.splashReady, handler);
  },
  setActiveWorkspaceContext: (
    sessionId: string,
    workspacePath: string | null,
  ) =>
    ipcRenderer.invoke(IPC.setActiveWorkspaceContext, sessionId, workspacePath),
  createChangeBatch: (title: string) =>
    ipcRenderer.invoke(IPC.createChangeBatch, title),
  closeChangeBatch: (batchId: string) =>
    ipcRenderer.invoke(IPC.closeChangeBatch, batchId),
  listChangeBatches: () => ipcRenderer.invoke(IPC.listChangeBatches),
  getFileDiff: (batchId: string, filePath: string) =>
    ipcRenderer.invoke(IPC.getFileDiff, batchId, filePath),
  markChangeReviewed: (batchId: string, filePath: string, hunkId?: string) =>
    ipcRenderer.invoke(IPC.markChangeReviewed, batchId, filePath, hunkId),
  revertChangeFile: (batchId: string, filePath: string) =>
    ipcRenderer.invoke(IPC.revertChangeFile, batchId, filePath),
  revertChangeHunk: (batchId: string, filePath: string, hunkId: string) =>
    ipcRenderer.invoke(IPC.revertChangeHunk, batchId, filePath, hunkId),
  onChangeBatchesChanged: (listener: (batches: ChangeBatch[]) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      batches: ChangeBatch[],
    ) => listener(batches);
    ipcRenderer.on(IPC.changeBatchesChanged, handler);
    return () => ipcRenderer.removeListener(IPC.changeBatchesChanged, handler);
  },
  getVisionSettings: () => ipcRenderer.invoke(IPC.getVisionSettings),
  setVisionSettings: (value: VisionSettings) =>
    ipcRenderer.invoke(IPC.setVisionSettings, value),
  testVisionBackend: (backend: VisionBackendConfig) =>
    ipcRenderer.invoke(IPC.testVisionBackend, backend),
  saveVisionImage: (dataUrl: string) =>
    ipcRenderer.invoke(IPC.saveVisionImage, dataUrl),
  pickVisionImageDirectory: () =>
    ipcRenderer.invoke(IPC.pickVisionImageDirectory),
  clearVisionImages: () => ipcRenderer.invoke(IPC.clearVisionImages),
  appendEventLog: (entry) => ipcRenderer.invoke(IPC.appendEventLog, entry),
  openLogDirectory: () => ipcRenderer.invoke(IPC.openLogDirectory),
  pickEventLogDirectory: () =>
    ipcRenderer.invoke(IPC.pickEventLogDirectory),
  getEventLogDirectory: () => ipcRenderer.invoke(IPC.getEventLogDirectory),
  resetEventLogDirectory: () =>
    ipcRenderer.invoke(IPC.resetEventLogDirectory),
  getAnalytics: (range) => ipcRenderer.invoke(IPC.getAnalytics, range),
  openAnalytics: () => ipcRenderer.invoke(IPC.openAnalytics),
  getRecentErrors: (withinMs) =>
    ipcRenderer.invoke(IPC.getRecentErrors, withinMs),
  getImageSettings: () => ipcRenderer.invoke(IPC.getImageSettings),
  setImageSettings: (settings) =>
    ipcRenderer.invoke(IPC.setImageSettings, settings),
  pickImageDirectory: () => ipcRenderer.invoke(IPC.pickImageDirectory),
  onWorkbenchNavigate: (listener: (view: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, view: string) =>
      listener(view);
    ipcRenderer.on(IPC.workbenchNavigate, handler);
    return () => ipcRenderer.removeListener(IPC.workbenchNavigate, handler);
  },
};

contextBridge.exposeInMainWorld("desktop", api);
