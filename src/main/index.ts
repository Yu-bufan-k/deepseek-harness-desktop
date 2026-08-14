import path from "node:path";
import { randomUUID } from "node:crypto";
import { unwatchFile, watchFile } from "node:fs";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, type IpcMainInvokeEvent } from "electron";
import log from "electron-log/main.js";
import {
  IPC,
  type DesktopInfo,
  type HarnessInfo,
  type OpenWorkspaceRequest,
  type OpenWorkspaceResult,
  type ThemePreference,
  type UpdateChannel,
  type UpdateState
} from "../shared/contracts.js";
import type { BillingSettings, BillingUsageIndex, BillingUsageSample } from "../shared/billing.js";
import { isSafeExternalUrl } from "../shared/security.js";
import { HarnessManager } from "./harness-manager.js";
import { SettingsStore } from "./settings-store.js";
import { CredentialStore } from "./credential-store.js";
import { UpdateManager } from "./update-manager.js";
import { createBackup } from "./backup.js";
import { HarnessThemeStore } from "./harness-theme-store.js";
import { DirectoryPickerBridge } from "./directory-picker-bridge.js";
import { writeDesktopOverlay } from "./desktop-overlay.js";
import { resolveLaunchDirectories } from "./launch-paths.js";
import { BillingStore } from "./billing-store.js";

const PRODUCT_NAME = "DeepSeek Harness Desktop";
const UNOFFICIAL_NOTICE = "非 DeepSeek 官方产品，由社区独立维护。";
const SPLASH_MINIMUM_MS = 3600;
const windows = new Set<BrowserWindow>();
const integrationReadyWindows = new WeakSet<BrowserWindow>();
const pendingWorkspaceOpens = new Map<string, OpenWorkspaceRequest & { sentTo: number | null }>();
const earlyOpenPaths: string[] = [];
let settingsWindow: BrowserWindow | null = null;
let billingWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let harness: HarnessManager;
let settings: SettingsStore;
let credentials: CredentialStore;
let updates: UpdateManager;
let themeStore: HarnessThemeStore;
let directoryPickerBridge: DirectoryPickerBridge;
let billing: BillingStore;
let billingUsageIndex: BillingUsageIndex = { updatedAt: "", sessions: [] };
let appliedTheme: ThemePreference | null = null;
let quitting = false;
let startupCompleting = false;
let splashShownAt = 0;
let resolveSplashAnimation!: () => void;
const splashAnimation = new Promise<void>((resolve) => { resolveSplashAnimation = resolve; });

app.setName(PRODUCT_NAME);
if (!app.requestSingleInstanceLock()) app.quit();

function preloadPath(): string { return path.join(__dirname, "..", "preload", "index.cjs"); }
function rendererPath(file: string): string { return path.join(__dirname, "..", "renderer", file); }
function appIconPath(): string { return rendererPath(path.join("assets", "deepseek-mark.png")); }
function directoryPickerPluginPath(): string { return path.join(__dirname, "..", "sidecar", "electron-directory-picker.js"); }
function billingPluginPath(): string { return path.join(__dirname, "..", "plugins", "billing", "index.js"); }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function launchArgumentsForPath(filePath: string): string[] {
  return app.isPackaged ? [process.execPath, filePath] : [process.execPath, ".", filePath];
}

function focusHarnessWindow(window?: BrowserWindow | null): void {
  const target = window && !window.isDestroyed() ? window : [...windows].find((item) => !item.isDestroyed());
  if (!target) return;
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
}

function sendPendingWorkspaceOpens(window: BrowserWindow): void {
  for (const request of pendingWorkspaceOpens.values()) {
    if (request.sentTo !== null) continue;
    request.sentTo = window.id;
    window.webContents.send(IPC.openWorkspace, {
      requestId: request.requestId,
      path: request.path
    } satisfies OpenWorkspaceRequest);
  }
}

async function queueLaunchDirectories(argv: readonly string[], workingDirectory: string): Promise<void> {
  const directories = await resolveLaunchDirectories(argv, workingDirectory, app.isPackaged);
  for (const directory of directories) {
    const requestId = randomUUID();
    pendingWorkspaceOpens.set(requestId, { requestId, path: directory, sentTo: null });
    log.info(`[desktop] queued workspace from shell: ${directory}`);
  }
  if (directories.length === 0) return;
  const window = [...windows].find((item) => !item.isDestroyed());
  if (window) {
    focusHarnessWindow(window);
    if (integrationReadyWindows.has(window)) sendPendingWorkspaceOpens(window);
  }
}

function currentInfo(): DesktopInfo {
  const value = settings.get();
  return {
    appVersion: app.getVersion(),
    harness: harness.getInfo(),
    update: updates.getState(),
    updateChannel: value.updateChannel,
    themePreference: themeStore.getPreference(),
    userDataPath: app.getPath("userData"),
    workspacePath: value.workspacePath,
    logsPath: app.getPath("logs"),
    unofficialNotice: UNOFFICIAL_NOTICE
  };
}

function syncThemeFromHarness(shouldBroadcast = true): void {
  const preference = themeStore.getPreference();
  if (preference === appliedTheme) return;
  appliedTheme = preference;
  nativeTheme.themeSource = preference;
  if (shouldBroadcast) broadcastInfo();
}

function broadcastInfo(): void {
  const info = currentInfo();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC.infoChanged, info);
  }
}

function broadcastBilling(): void {
  const value = billing.get();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC.billingChanged, value);
  }
}

function secureWindow(window: BrowserWindow, harnessOrigin?: string): void {
  const allowNavigation = (target: string): boolean => {
    if (target.startsWith("file://") && (target.includes("/settings.html") || target.includes("/billing.html") || target.includes("/splash.html"))) return true;
    if (!harnessOrigin) return false;
    try { return new URL(target).origin === harnessOrigin; } catch { return false; }
  };
  window.webContents.on("will-navigate", (event, target) => {
    if (!allowNavigation(target)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

async function createHarnessWindow(readyInfo?: HarnessInfo, show = true): Promise<BrowserWindow> {
  const info = readyInfo?.status === "ready"
    ? readyInfo
    : harness.getInfo().status === "ready" ? harness.getInfo() : await harness.start();
  if (!info.port) throw new Error("Harness 启动后未提供端口");
  const origin = `http://127.0.0.1:${info.port}`;
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    icon: appIconPath(),
    title: PRODUCT_NAME,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  windows.add(window);
  window.webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) integrationReadyWindows.delete(window);
  });
  window.on("closed", () => {
    windows.delete(window);
    for (const request of pendingWorkspaceOpens.values()) {
      if (request.sentTo === window.id) request.sentTo = null;
    }
  });
  secureWindow(window, origin);
  await window.loadURL(`${origin}/#desktop-session=${harness.sessionToken}`);
  if (show && !window.isDestroyed()) window.show();
  return window;
}

async function showSplash(): Promise<void> {
  splashWindow = new BrowserWindow({
    width: 720,
    height: 460,
    minWidth: 720,
    minHeight: 460,
    maxWidth: 720,
    maxHeight: 460,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    icon: appIconPath(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111214" : "#f7f7f8",
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  secureWindow(splashWindow);
  splashWindow.on("closed", () => { splashWindow = null; });
  await splashWindow.loadFile(rendererPath("splash.html"));
  if (!splashWindow.isDestroyed()) {
    splashShownAt = Date.now();
    splashWindow.show();
  }
}

async function revealHarnessAfterSplash(info: HarnessInfo): Promise<void> {
  if (startupCompleting || windows.size > 0) return;
  startupCompleting = true;
  try {
    const remainingAnimationTime = Math.max(0, SPLASH_MINIMUM_MS - (Date.now() - splashShownAt));
    const [window] = await Promise.all([
      createHarnessWindow(info, false),
      delay(remainingAnimationTime),
      Promise.race([splashAnimation, delay(SPLASH_MINIMUM_MS + 1400)])
    ]);
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.webContents.send(IPC.splashReady);
    await delay(440);
    if (!window.isDestroyed()) window.show();
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
    await settings.patch({ lastGoodVersion: app.getVersion(), pendingVersion: null, failedStarts: 0 });
  } finally {
    startupCompleting = false;
  }
}

async function launchWithSplash(): Promise<void> {
  await showSplash();
  try {
    const info = await harness.start();
    await revealHarnessAfterSplash(info);
  } catch (error) {
    log.error("Harness 首次启动失败", error);
    broadcastInfo();
  }
}

async function retryStartup(): Promise<HarnessInfo> {
  const info = await harness.restart();
  setTimeout(() => void revealHarnessAfterSplash(info), 0);
  return info;
}

async function showSettings(): Promise<void> {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 820,
    height: 760,
    minWidth: 680,
    minHeight: 560,
    icon: appIconPath(),
    title: `${PRODUCT_NAME} 设置`,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  secureWindow(settingsWindow);
  settingsWindow.on("closed", () => { settingsWindow = null; });
  await settingsWindow.loadFile(rendererPath("settings.html"));
}

function isBillingSample(value: unknown): value is BillingUsageSample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Record<string, unknown>;
  return typeof sample.provider === "string" && typeof sample.model === "string"
    && ["time", "uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"]
      .every((key) => typeof sample[key] === "number" && Number.isFinite(sample[key]) && (sample[key] as number) >= 0);
}

function normalizeBillingUsageIndex(value: unknown): BillingUsageIndex {
  if (!value || typeof value !== "object") throw new Error("无效的用量汇总");
  const candidate = value as { sessions?: unknown };
  if (!Array.isArray(candidate.sessions) || candidate.sessions.length > 10_000) throw new Error("无效的会话用量列表");
  return {
    updatedAt: new Date().toISOString(),
    sessions: candidate.sessions.map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error("无效的会话用量");
      const session = entry as { sessionId?: unknown; title?: unknown; samples?: unknown };
      if (typeof session.sessionId !== "string" || typeof session.title !== "string" || !Array.isArray(session.samples)) throw new Error("无效的会话用量");
      if (session.samples.length > 100_000 || !session.samples.every(isBillingSample)) throw new Error("无效的请求用量");
      return { sessionId: session.sessionId.slice(0, 256), title: session.title.slice(0, 500), samples: session.samples };
    })
  };
}

function broadcastBillingUsage(): void {
  if (billingWindow && !billingWindow.isDestroyed()) billingWindow.webContents.send(IPC.billingUsageChanged, billingUsageIndex);
}

async function showBilling(): Promise<void> {
  if (billingWindow && !billingWindow.isDestroyed()) {
    billingWindow.show();
    billingWindow.focus();
    return;
  }
  billingWindow = new BrowserWindow({
    width: 940,
    height: 800,
    minWidth: 720,
    minHeight: 620,
    icon: appIconPath(),
    title: `${PRODUCT_NAME} 用量与费用`,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  secureWindow(billingWindow);
  billingWindow.on("closed", () => { billingWindow = null; });
  await billingWindow.loadFile(rendererPath("billing.html"));
}

async function showUpdateResult(state: UpdateState): Promise<void> {
  if (!state.configured) {
    await dialog.showMessageBox({
      type: "info",
      title: "检查更新",
      message: "当前版本未配置在线更新源",
      detail: "本地开发包不会连接更新服务器。配置 GitHub Releases 后，正式构建会在这里检查更新。",
      buttons: ["知道了"]
    });
    return;
  }
  if (state.phase === "error") {
    await dialog.showMessageBox({ type: "error", title: "检查更新失败", message: "暂时无法完成更新检查", detail: state.errorSummary ?? "请检查网络后重试。", buttons: ["知道了"] });
    return;
  }
  if (state.phase === "available") {
    const result = await dialog.showMessageBox({ type: "info", title: "发现新版本", message: `DeepSeek Harness Desktop ${state.version ?? "新版本"} 可用`, detail: "可前往设置页面下载并安装更新。", buttons: ["打开设置", "稍后"], defaultId: 0, cancelId: 1 });
    if (result.response === 0) await showSettings();
    return;
  }
  if (state.phase === "ready") {
    await dialog.showMessageBox({ type: "info", title: "更新已就绪", message: `${state.version ?? "新版本"} 已下载`, detail: "可在设置页面选择“重启并安装”。", buttons: ["知道了"] });
    return;
  }
  await dialog.showMessageBox({ type: "info", title: "检查更新", message: "当前已是最新版本", detail: `当前版本：${app.getVersion()}`, buttons: ["知道了"] });
}

async function checkUpdatesWithFeedback(): Promise<void> {
  try {
    const state = await updates.check();
    await showUpdateResult(state);
  } catch (error) {
    await dialog.showMessageBox({ type: "error", title: "检查更新失败", message: "更新检查发生异常", detail: error instanceof Error ? error.message : String(error), buttons: ["知道了"] });
  }
}

function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "文件",
      submenu: [
        { label: "新建窗口", accelerator: "CmdOrCtrl+N", click: () => void createHarnessWindow() },
        { label: "选择工作区…", click: () => void chooseWorkspace() },
        { type: "separator" },
        { role: "quit", label: "退出" }
      ]
    },
    {
      label: "Harness",
      submenu: [
        { label: "重新启动", accelerator: "CmdOrCtrl+Shift+R", click: () => void restartHarness() },
        { label: "打开日志目录", click: () => void shell.openPath(app.getPath("logs")) }
      ]
    },
    {
      label: "应用",
      submenu: [
        { label: "设置…", accelerator: "CmdOrCtrl+,", click: () => void showSettings() },
        { label: "用量与费用", accelerator: "CmdOrCtrl+Shift+U", click: () => void showBilling() },
        { label: "检查更新…", click: () => void checkUpdatesWithFeedback() },
        { type: "separator" },
        { role: "toggleDevTools", label: "开发者工具" }
      ]
    },
    {
      label: "帮助",
      submenu: [{
        label: "关于",
        click: () => void dialog.showMessageBox({
          type: "info",
          icon: appIconPath(),
          title: `关于 ${PRODUCT_NAME}`,
          message: `${PRODUCT_NAME} ${app.getVersion()}`,
          detail: `${UNOFFICIAL_NOTICE}\n内置 DeepSeek Harness ${harness.getInfo().version}`
        })
      }]
    }
  ]));
}

async function chooseWorkspace(): Promise<string | null> {
  const selectedPath = await showDirectoryPicker();
  if (!selectedPath) return null;
  await settings.patch({ workspacePath: selectedPath });
  await restartHarness();
  return selectedPath;
}

async function showDirectoryPicker(): Promise<string | null> {
  const parent = BrowserWindow.getFocusedWindow();
  const options: Electron.OpenDialogOptions = {
    title: "选择工作区目录",
    properties: ["openDirectory", "createDirectory"]
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
}

async function restartHarness(): Promise<HarnessInfo> {
  const info = await harness.restart();
  const origin = `http://127.0.0.1:${info.port}`;
  await Promise.all([...windows].filter((window) => !window.isDestroyed()).map((window) => window.loadURL(`${origin}/#desktop-session=${harness.sessionToken}`)));
  broadcastInfo();
  return info;
}

function assertTrustedIpc(event: IpcMainInvokeEvent): void {
  const sender = event.senderFrame?.url ?? "";
  let trusted = sender.startsWith("file://") && (sender.includes("/settings.html") || sender.includes("/billing.html") || sender.includes("/splash.html"));
  try {
    const url = new URL(sender);
    trusted ||= url.hostname === "127.0.0.1" && url.protocol === "http:";
  } catch { /* 交由下方统一拒绝 */ }
  if (!trusted) throw new Error("拒绝来自不受信任页面的 IPC 请求");
}

function registerIpc(): void {
  const handle = <T extends unknown[]>(channel: string, action: (event: IpcMainInvokeEvent, ...args: T) => unknown) => {
    ipcMain.handle(channel, async (event, ...args) => { assertTrustedIpc(event); return await action(event, ...(args as T)); });
  };
  handle(IPC.getInfo, () => currentInfo());
  handle(IPC.restartHarness, () => restartHarness());
  handle(IPC.chooseWorkspace, () => chooseWorkspace());
  handle(IPC.openLogs, async () => { await shell.openPath(app.getPath("logs")); });
  handle(IPC.openSettings, () => showSettings());
  handle(IPC.openBilling, () => showBilling());
  handle(IPC.checkUpdate, () => updates.check());
  handle(IPC.downloadUpdate, () => updates.download());
  handle(IPC.finishSplashAnimation, () => { resolveSplashAnimation(); });
  handle(IPC.retryStartup, () => retryStartup());
  handle(IPC.installUpdate, async () => {
    const userData = app.getPath("userData");
    await createBackup(path.join(userData, "dsh"), path.join(userData, "backups"), {
      desktopVersion: app.getVersion(), harnessVersion: harness.getInfo().version, createdAt: new Date().toISOString()
    });
    updates.install();
  });
  handle(IPC.setUpdateChannel, async (_event, channel: UpdateChannel) => {
    if (channel !== "stable" && channel !== "beta") throw new Error("无效的更新通道");
    await settings.patch({ updateChannel: channel });
    const state = await updates.setChannel(channel);
    broadcastInfo();
    return state;
  });
  handle(IPC.setThemePreference, async (_event, preference: ThemePreference) => {
    if (!( ["light", "dark", "system"] as const).includes(preference)) throw new Error("无效的外观设置");
    await themeStore.setPreference(preference);
    syncThemeFromHarness();
    return preference;
  });
  handle(IPC.setCredential, async (_event, name: string, value: string) => { await credentials.set(name, value); });
  handle(IPC.hasCredential, (_event, name: string) => credentials.has(name));
  handle(IPC.removeCredential, (_event, name: string) => credentials.remove(name));
  handle(IPC.getBillingSettings, () => billing.get());
  handle(IPC.setBillingSettings, async (_event, value: BillingSettings) => {
    const saved = await billing.save(value);
    broadcastBilling();
    return saved;
  });
  handle(IPC.checkBillingPrices, async () => {
    const result = await billing.checkForUpdates();
    broadcastBilling();
    return result;
  });
  handle(IPC.getBillingUsage, () => billingUsageIndex);
  handle(IPC.reportBillingUsage, (_event, value: unknown) => {
    billingUsageIndex = normalizeBillingUsageIndex(value);
    broadcastBillingUsage();
  });
  ipcMain.on(IPC.harnessIntegrationReady, (event) => {
    try { assertTrustedIpc(event); } catch { return; }
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !windows.has(window)) return;
    integrationReadyWindows.add(window);
    for (const request of pendingWorkspaceOpens.values()) {
      if (request.sentTo === window.id) request.sentTo = null;
    }
    sendPendingWorkspaceOpens(window);
  });
  ipcMain.on(IPC.openWorkspaceResult, (event, result: OpenWorkspaceResult) => {
    try { assertTrustedIpc(event); } catch { return; }
    if (!result || typeof result.requestId !== "string" || typeof result.path !== "string" || typeof result.ok !== "boolean") return;
    const request = pendingWorkspaceOpens.get(result.requestId);
    if (!request || request.path !== result.path) return;
    pendingWorkspaceOpens.delete(result.requestId);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (result.ok) {
      log.info(`[desktop] opened workspace in a new session: ${result.path}`);
      focusHarnessWindow(window);
      return;
    }
    log.error(`[desktop] failed to open workspace from shell: ${result.path}: ${result.error ?? "unknown error"}`);
    const options: Electron.MessageBoxOptions = {
      type: "error",
      title: "无法打开工作区",
      message: "拖入的文件夹未能在 Harness 中打开",
      detail: `${result.path}\n\n${result.error ?? "未知错误"}`,
      buttons: ["知道了"]
    };
    void (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
  });
}

async function handleHarnessFailure(): Promise<void> {
  if (quitting) return;
  broadcastInfo();
  if (splashWindow && !splashWindow.isDestroyed()) return;
  const result = await dialog.showMessageBox({
    type: "error",
    title: "Harness 已停止",
    message: harness.getInfo().errorSummary ?? "Harness 意外停止",
    buttons: ["重新启动", "打开日志", "退出"],
    defaultId: 0,
    cancelId: 2
  });
  if (result.response === 0) await restartHarness();
  else if (result.response === 1) await shell.openPath(app.getPath("logs"));
  else app.quit();
}

app.on("second-instance", (_event, commandLine, workingDirectory) => {
  void queueLaunchDirectories(commandLine, workingDirectory);
  if (splashWindow && !splashWindow.isDestroyed()) { splashWindow.show(); splashWindow.focus(); return; }
  const window = [...windows][0];
  if (window) focusHarnessWindow(window);
  else if (harness) void createHarnessWindow();
});

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) void queueLaunchDirectories(launchArgumentsForPath(filePath), process.cwd());
  else earlyOpenPaths.push(filePath);
});

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  if (themeStore) unwatchFile(themeStore.filePath);
  void harness.stop().then(() => directoryPickerBridge?.stop()).finally(() => app.quit());
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (windows.size === 0 && !splashWindow) void createHarnessWindow(); });

void app.whenReady().then(async () => {
  log.initialize();
  log.transports.file.level = "info";
  log.transports.console.level = "info";
  const userData = app.getPath("userData");
  themeStore = new HarnessThemeStore(path.join(userData, "dsh"));
  syncThemeFromHarness(false);
  watchFile(themeStore.filePath, { interval: 500, persistent: false }, () => syncThemeFromHarness());
  settings = new SettingsStore(userData);
  await settings.load();
  billing = new BillingStore(settings, app.getAppPath());
  await billing.load();
  credentials = new CredentialStore(userData);
  updates = new UpdateManager(settings.get().updateChannel, settings.get().updateRepository);
  directoryPickerBridge = new DirectoryPickerBridge(showDirectoryPicker);
  const bridgeInfo = await directoryPickerBridge.start();
  const desktopOverlayPath = await writeDesktopOverlay(
    path.join(userData, "desktop-runtime"),
    directoryPickerPluginPath(),
    billingPluginPath()
  );
  harness = new HarnessManager({
    dshHome: path.join(userData, "dsh"),
    workspace: () => settings.get().workspacePath,
    credentials: () => credentials.environment(),
    log: (message) => log.info(message),
    desktopOverlayPath,
    directoryPickerBridge: bridgeInfo
  });
  harness.on("changed", (info) => {
    broadcastInfo();
    if (info.status === "failed") void handleHarnessFailure();
  });
  updates.on("changed", broadcastInfo);
  registerIpc();
  if (billing.shouldAutoCheck()) void billing.checkForUpdates().then(broadcastBilling).catch((error) => log.warn("价格清单自动检查失败", error));
  installMenu();
  await queueLaunchDirectories(process.argv, process.cwd());
  for (const filePath of earlyOpenPaths.splice(0)) {
    await queueLaunchDirectories(launchArgumentsForPath(filePath), process.cwd());
  }
  try {
    if (process.env.DSH_DESKTOP_SMOKE_TEST === "1") {
      const started = await harness.start();
      const root = await fetch(`http://127.0.0.1:${started.port}/`).then((response) => response.text());
      if (!root.includes("deepseek-harness-desktop-integration")) {
        throw new Error("桌面集成客户端未写入 Harness 启动清单");
      }
      const bootScripts = [...root.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map((match) => match[1])
        .filter((source): source is string => typeof source === "string"
          && (source.includes("window.__DSH_BOOT__ =") || source.includes("deepseek-harness-desktop-integration")));
      const smokeWindow: { __DSH_BOOT__?: { entries: Array<{ id: string }> } } = {};
      for (const source of bootScripts) Function("window", source)(smokeWindow);
      if (!smokeWindow.__DSH_BOOT__?.entries.some((entry) => entry.id === "deepseek-harness-desktop-integration")) {
        throw new Error("桌面集成客户端未能加入 Harness 启动图");
      }
      const clientSource = await fetch(`http://127.0.0.1:${started.port}/desktop-integration/client.js`).then((response) => response.text());
      if (!clientSource.includes("desktop:open-workspace")) {
        throw new Error("桌面集成客户端路由不可用");
      }
      if (!clientSource.includes("conversation.session.header.utilities") || !clientSource.includes("openBilling")) {
        throw new Error("右上角用量与费用入口不可用");
      }
      let clientExports: { inject?: unknown } | undefined;
      const moduleWindow = {
        __ModuleLoader__: {
          load: (handoff: { factory: (require: (id: string) => unknown) => { inject?: unknown } }) => { clientExports = handoff.factory(() => ({})); }
        }
      };
      Function("window", clientSource)(moduleWindow);
      if (JSON.stringify(clientExports?.inject) !== JSON.stringify(["workspaces", "sessions", "slots", "modelDirectories"])) {
        throw new Error("桌面集成客户端未声明 Harness 服务依赖");
      }
      // Parse the browser bundle without executing it in Node.
      Function(clientSource);
      await harness.restart();
      log.info("桌面端冒烟测试通过", harness.getInfo());
      quitting = true;
      await harness.stop();
      app.exit(0);
      return;
    }
    await launchWithSplash();
  } catch (error) {
    log.error(error);
    if (process.env.DSH_DESKTOP_SMOKE_TEST === "1") {
      quitting = true;
      await harness.stop();
      app.exit(1);
      return;
    }
    await handleHarnessFailure();
  }
});
