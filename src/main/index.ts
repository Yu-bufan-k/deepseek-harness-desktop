import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { unwatchFile, watchFile } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import log from "electron-log/main.js";
import {
  IPC,
  type BillingModelTarget,
  type DeepSeekBalanceSnapshot,
  type DesktopInfo,
  type HarnessUpdateState,
  type HarnessInfo,
  type OpenWorkspaceRequest,
  type OpenWorkspaceResult,
  type SavedVisionImage,
  type ThemePreference,
  type VisionSettings,
  type UpdateChannel,
  type UpdateState,
} from "../shared/contracts.js";
import { EventLog } from "./event-log.js";
import {
  billingSettingsSnapshot,
  BillingUsageSummarizer,
  decimalBillingAmountToNanos,
  formatDecimalBillingMoney,
  restoreOfficialBilling,
  type BillingSettings,
  type BillingUsageIndex,
  type BillingUsageReport,
  type BillingUsageSample,
  type BillingUsageSync,
  type BillingSessionTools,
} from "../shared/billing.js";
import {
  DEFAULT_QUOTA_SETTINGS,
  validateQuotaSettings,
  type QuotaSettings,
} from "../shared/quota.js";
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
import { checkHarnessUpdate as fetchHarnessUpdate } from "./harness-update-checker.js";
import { DeepSeekBalanceService } from "./deepseek-balance.js";
import { readHarnessCredential } from "./harness-credential-reader.js";
import { ChangeSetService } from "./change-set-service.js";
import { VisionService } from "./vision-service.js";
import { quotaSourcesFor, type QuotaSource } from "./quota-source.js";
import { QuotaMonitor } from "./quota-monitor.js";
import { MemoryStore } from "./memory-store.js";

const PRODUCT_NAME = "DeepSeek Harness Desktop";
const UNOFFICIAL_NOTICE = "非 DeepSeek 官方产品，由社区独立维护。";
const SPLASH_MINIMUM_MS = 3600;
const windows = new Set<BrowserWindow>();
const integrationReadyWindows = new WeakSet<BrowserWindow>();
const pendingWorkspaceOpens = new Map<
  string,
  OpenWorkspaceRequest & { sentTo: number | null }
>();
const earlyOpenPaths: string[] = [];
let workbenchWindow: BrowserWindow | null = null;
let billingWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let usageWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
const popupWindows = new Map<BrowserWindow, BrowserWindow | undefined>();
const workspaceContexts = new Map<
  number,
  { sessionId: string; path: string; windowId: number }
>();
let activeWorkspaceContext: {
  sessionId: string;
  path: string;
  windowId: number;
} | null = null;
let harness: HarnessManager;
let settings: SettingsStore;
let eventLog: EventLog;
let credentials: CredentialStore;
let deepSeekBalance: DeepSeekBalanceService;
let changeSets: ChangeSetService;
let vision: VisionService;
let updates: UpdateManager;
let themeStore: HarnessThemeStore;
let directoryPickerBridge: DirectoryPickerBridge;
let billing: BillingStore;
let harnessUpdate: HarnessUpdateState = {
  phase: "idle",
  currentVersion: "",
  latestVersion: null,
  updateAvailable: false,
  checkedAt: null,
  errorSummary: null,
};
let billingUsageIndex: BillingUsageIndex = { collectedAt: "", sessions: [] };
const billingUsageSessions = new Map<
  string,
  BillingUsageIndex["sessions"][number]
>();
const billingUsageSummarizer = new BillingUsageSummarizer();
let billingUsageWarnings: string[] = [];
let billingCurrentTarget: BillingModelTarget | undefined;
let billingUsageReport: BillingUsageReport;
let quotaMonitor: QuotaMonitor;
let quotaRefreshTimer: NodeJS.Timeout | null = null;
let memoryStore: MemoryStore;
let appliedTheme: ThemePreference | null = null;
let quitting = false;
let startupCompleting = false;
let splashShownAt = 0;
let resolveSplashAnimation!: () => void;
const splashAnimation = new Promise<void>((resolve) => {
  resolveSplashAnimation = resolve;
});

app.setName(PRODUCT_NAME);
if (!app.requestSingleInstanceLock()) app.quit();

function preloadPath(): string {
  return path.join(__dirname, "..", "preload", "index.cjs");
}
function rendererPath(file: string): string {
  return path.join(__dirname, "..", "renderer", file);
}
function appIconPath(): string {
  return rendererPath(path.join("assets", "deepseek-mark.png"));
}
function directoryPickerPluginPath(): string {
  return path.join(__dirname, "..", "sidecar", "electron-directory-picker.js");
}
function billingPluginPath(): string {
  return path.join(__dirname, "..", "plugins", "billing", "index.js");
}
function memoryPluginPath(): string {
  return path.join(__dirname, "..", "plugins", "memory", "index.js");
}
function visionPluginPath(): string {
  return path.join(__dirname, "..", "plugins", "vision", "index.js");
}
// 视觉图片存盘目录：默认 userData/vision，用户可在视觉设置里自定义
// imageDirectory（切换目录后旧占位指向旧目录，解析会失败，属预期行为）。
function visionImagesDirectory(settings: VisionSettings): string {
  const custom = settings.imageDirectory?.trim();
  return custom
    ? path.resolve(custom)
    : path.join(app.getPath("userData"), "vision");
}
function visionExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/bmp":
      return "bmp";
    case "image/avif":
      return "avif";
    default:
      return "bin";
  }
}
function visionMimeForExtension(extension: string): string {
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "avif":
      return "image/avif";
    default:
      return "application/octet-stream";
  }
}
async function saveVisionImageFile(
  dataUrl: string,
  directory: string,
): Promise<SavedVisionImage> {
  const match =
    /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error("图片 Data URL 无效");
  const buffer = Buffer.from(match[2]!, "base64");
  if (!buffer.length || buffer.length > 20 * 1024 * 1024)
    throw new Error("图片大小必须在 20 MB 以内");
  const mimeType = match[1]!;
  const imageId = createHash("sha256").update(buffer).digest("hex");
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(
      path.join(directory, `${imageId}.${visionExtension(mimeType)}`),
      buffer,
      { flag: "wx" },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return { imageId, mimeType };
}
async function resolveVisionImageFile(imageId: string, directory: string): Promise<{
  dataUrl: string;
  mimeType: string;
}> {
  if (!/^[a-f0-9]{64}$/i.test(imageId)) throw new Error("无效的图片 ID");
  const entries = await readdir(directory);
  const entry = entries.find((name) => name.startsWith(`${imageId}.`));
  if (!entry) throw new Error("图片不存在或已被清理");
  const mimeType = visionMimeForExtension(entry.split(".").pop() ?? "");
  const buffer = await readFile(path.join(directory, entry));
  return {
    dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
    mimeType,
  };
}
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function launchArgumentsForPath(filePath: string): string[] {
  return app.isPackaged
    ? [process.execPath, filePath]
    : [process.execPath, ".", filePath];
}

function focusHarnessWindow(window?: BrowserWindow | null): void {
  const target =
    window && !window.isDestroyed()
      ? window
      : [...windows].find((item) => !item.isDestroyed());
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
      path: request.path,
    } satisfies OpenWorkspaceRequest);
  }
}

async function queueLaunchDirectories(
  argv: readonly string[],
  workingDirectory: string,
): Promise<void> {
  const directories = await resolveLaunchDirectories(
    argv,
    workingDirectory,
    app.isPackaged,
  );
  for (const directory of directories) {
    const requestId = randomUUID();
    pendingWorkspaceOpens.set(requestId, {
      requestId,
      path: directory,
      sentTo: null,
    });
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
    harnessUpdate: {
      ...harnessUpdate,
      currentVersion: harness.getInfo().version,
    },
    updateChannel: value.updateChannel,
    themePreference: themeStore.getPreference(),
    userDataPath: app.getPath("userData"),
    workspacePath: value.workspacePath,
    activeWorkspacePath: activeWorkspaceContext?.path ?? null,
    logsPath: app.getPath("logs"),
    unofficialNotice: UNOFFICIAL_NOTICE,
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
  const value = billingSettingsSnapshot(billing.get());
  const report = refreshBillingReport();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC.billingChanged, value);
      window.webContents.send(IPC.billingUsageChanged, report);
    }
  }
}

async function deepSeekBalanceSnapshot(
  force = false,
): Promise<DeepSeekBalanceSnapshot> {
  const snapshot = await deepSeekBalance.get(force);
  const warning = billing.get().balanceWarning;
  return {
    ...snapshot,
    balances: snapshot.balances.map((entry) => {
      const threshold = warning.enabled
        ? warning.thresholds[entry.currency]
        : null;
      return {
        ...entry,
        warningThreshold: threshold,
        warningThresholdDisplay: threshold
          ? formatDecimalBillingMoney(entry.currency, threshold)
          : null,
        warning:
          threshold !== null &&
          decimalBillingAmountToNanos(entry.totalBalance) <=
            decimalBillingAmountToNanos(threshold),
      };
    }),
  };
}

function secureWindow(window: BrowserWindow, harnessOrigin?: string): void {
  const allowNavigation = (target: string): boolean => {
    if (
      target.startsWith("file://") &&
      (target.includes("/settings.html") ||
        target.includes("/billing.html") ||
        target.includes("/splash.html") ||
        target.includes("/workbench/index.html"))
    )
      return true;
    if (!harnessOrigin) return false;
    try {
      return new URL(target).origin === harnessOrigin;
    } catch {
      return false;
    }
  };
  window.webContents.on("will-navigate", (event, target) => {
    if (!allowNavigation(target)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

function createPopupWindow(
  options: Electron.BrowserWindowConstructorOptions,
): BrowserWindow {
  const parentWindow = BrowserWindow.getFocusedWindow() ?? undefined;
  const parentBounds = parentWindow?.getBounds();
  const position =
    parentBounds && options.width && options.height
      ? {
          x: Math.round(
            parentBounds.x + (parentBounds.width - options.width) / 2,
          ),
          y: Math.round(
            parentBounds.y + (parentBounds.height - options.height) / 2,
          ),
        }
      : {};
  const window = new BrowserWindow({
    ...options,
    ...position,
    parent: parentWindow,
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...options.webPreferences,
    },
  });
  window.setMenu(null);
  secureWindow(window);
  popupWindows.set(window, parentWindow);
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
  });
  window.on("closed", () => {
    popupWindows.delete(window);
  });
  return window;
}

function destroyPopupsOf(parent: BrowserWindow): void {
  for (const [popup, parentWindow] of popupWindows) {
    if (parentWindow === parent && !popup.isDestroyed()) popup.destroy();
  }
}

async function createHarnessWindow(
  readyInfo?: HarnessInfo,
  show = true,
): Promise<BrowserWindow> {
  const info =
    readyInfo?.status === "ready"
      ? readyInfo
      : harness.getInfo().status === "ready"
        ? harness.getInfo()
        : await harness.start();
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
      webSecurity: true,
    },
  });
  windows.add(window);
  window.on("focus", () => {
    activeWorkspaceContext = workspaceContexts.get(window.id) ?? null;
    broadcastInfo();
  });
  window.webContents.on(
    "did-start-navigation",
    (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) integrationReadyWindows.delete(window);
    },
  );
  window.on("closed", () => {
    windows.delete(window);
    workspaceContexts.delete(window.id);
    if (activeWorkspaceContext?.windowId === window.id)
      activeWorkspaceContext = null;
    for (const request of pendingWorkspaceOpens.values()) {
      if (request.sentTo === window.id) request.sentTo = null;
    }
    destroyPopupsOf(window);
    if (windows.size === 0 && !quitting) {
      if (workbenchWindow && !workbenchWindow.isDestroyed())
        workbenchWindow.destroy();
      for (const popup of popupWindows.keys())
        if (!popup.isDestroyed()) popup.destroy();
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
      sandbox: true,
    },
  });
  secureWindow(splashWindow);
  splashWindow.on("closed", () => {
    splashWindow = null;
  });
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
    const remainingAnimationTime = Math.max(
      0,
      SPLASH_MINIMUM_MS - (Date.now() - splashShownAt),
    );
    const [window] = await Promise.all([
      createHarnessWindow(info, false),
      delay(remainingAnimationTime),
      Promise.race([splashAnimation, delay(SPLASH_MINIMUM_MS + 1400)]),
    ]);
    if (splashWindow && !splashWindow.isDestroyed())
      splashWindow.webContents.send(IPC.splashReady);
    await delay(440);
    if (!window.isDestroyed()) window.show();
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
    await settings.patch({
      lastGoodVersion: app.getVersion(),
      pendingVersion: null,
      failedStarts: 0,
    });
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
  if (harnessUpdate.phase === "idle") void checkHarnessVersion();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const window = createPopupWindow({
    width: 920,
    height: 780,
    minWidth: 720,
    minHeight: 620,
    icon: appIconPath(),
    title: `桌面设置 · ${PRODUCT_NAME}`,
    backgroundColor: "#f7f8fa",
  });
  settingsWindow = window;
  window.on("closed", () => {
    if (settingsWindow === window) settingsWindow = null;
  });
  await window.loadFile(rendererPath(path.join("workbench", "index.html")), {
    query: { view: "settings", mode: "popup" },
  });
}

function isBillingSample(value: unknown): value is BillingUsageSample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Record<string, unknown>;
  return (
    typeof sample.provider === "string" &&
    typeof sample.model === "string" &&
    typeof sample.time === "number" &&
    Number.isFinite(sample.time) &&
    sample.time >= 0 &&
    [
      "uncachedInputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "outputTokens",
    ].every(
      (key) =>
        typeof sample[key] === "number" &&
        Number.isSafeInteger(sample[key]) &&
        (sample[key] as number) >= 0,
    )
  );
}

function isBillingTools(value: unknown): value is BillingSessionTools {
  if (!value || typeof value !== "object") return false;
  const tools = value as Record<string, unknown>;
  const isRecord = (field: unknown): field is Record<string, number> =>
    !!field &&
    typeof field === "object" &&
    !Array.isArray(field) &&
    Object.entries(field).every(
      ([key, count]) =>
        key.length > 0 &&
        typeof count === "number" &&
        Number.isSafeInteger(count) &&
        count >= 0,
    );
  return isRecord(tools.tools) && isRecord(tools.mcp) && isRecord(tools.skills);
}

function normalizeBillingUsageSync(value: unknown): {
  sync: BillingUsageSync;
  warnings: string[];
} {
  if (!value || typeof value !== "object") throw new Error("无效的用量汇总");
  const candidate = value as {
    collectedAt?: unknown;
    sessionIds?: unknown;
    sessions?: unknown;
    droppedSessions?: unknown;
  };
  if (
    !Array.isArray(candidate.sessions) ||
    !Array.isArray(candidate.sessionIds)
  )
    throw new Error("无效的会话用量列表");
  if (
    candidate.sessionIds.length > 10_000 ||
    candidate.sessions.length > 10_000
  )
    throw new Error("单次同步的会话数量超过安全上限");
  const declaredIds = new Set(candidate.sessionIds);
  if (
    !candidate.sessionIds.every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 256,
    ) ||
    declaredIds.size !== candidate.sessionIds.length
  )
    throw new Error("无效或重复的会话 ID");
  const warnings: string[] = [];
  const droppedSessions =
    typeof candidate.droppedSessions === "number" &&
    Number.isSafeInteger(candidate.droppedSessions) &&
    candidate.droppedSessions >= 0
      ? candidate.droppedSessions
      : 0;
  if (droppedSessions)
    warnings.push(
      `有 ${droppedSessions} 个较早对话超过安全上限，未纳入本次汇总。`,
    );
  let droppedSamples = 0;
  const sessions = candidate.sessions.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("无效的会话用量");
    const session = entry as {
      sessionId?: unknown;
      title?: unknown;
      revision?: unknown;
      samples?: unknown;
      tools?: unknown;
    };
    if (
      typeof session.sessionId !== "string" ||
      !declaredIds.has(session.sessionId) ||
      typeof session.title !== "string" ||
      typeof session.revision !== "string" ||
      !session.revision ||
      session.revision.length > 128 ||
      !Array.isArray(session.samples)
    )
      throw new Error("无效的会话用量");
    const samples = session.samples.slice(-100_000);
    droppedSamples += session.samples.length - samples.length;
    if (!samples.every(isBillingSample)) throw new Error("无效的请求用量");
    if (session.tools !== undefined && !isBillingTools(session.tools))
      throw new Error("无效的工具调用汇总");
    const next = {
      sessionId: session.sessionId,
      title: session.title.slice(0, 500),
      revision: session.revision,
      samples,
    };
    return session.tools === undefined
      ? next
      : { ...next, tools: session.tools };
  });
  if (
    new Set(sessions.map((session) => session.sessionId)).size !==
    sessions.length
  )
    throw new Error("单次同步包含重复会话");
  if (droppedSamples)
    warnings.push(
      `有 ${droppedSamples} 条较早请求超过单对话安全上限，未纳入本次汇总。`,
    );
  const collectedAt =
    typeof candidate.collectedAt === "string" &&
    Number.isFinite(Date.parse(candidate.collectedAt))
      ? candidate.collectedAt
      : new Date().toISOString();
  return {
    sync: {
      collectedAt,
      sessionIds: candidate.sessionIds,
      sessions,
      droppedSessions,
    },
    warnings,
  };
}

function applyBillingUsageSync(sync: BillingUsageSync): number {
  const activeIds = new Set(sync.sessionIds);
  for (const id of billingUsageSessions.keys())
    if (!activeIds.has(id)) billingUsageSessions.delete(id);
  for (const session of sync.sessions)
    billingUsageSessions.set(session.sessionId, session);
  billingUsageIndex = {
    collectedAt: sync.collectedAt,
    sessions: sync.sessionIds
      .map((id) => billingUsageSessions.get(id))
      .filter((session): session is BillingUsageIndex["sessions"][number] =>
        Boolean(session),
      ),
  };
  return sync.sessionIds.length - billingUsageIndex.sessions.length;
}

function refreshBillingReport(): BillingUsageReport {
  billingUsageReport = billingUsageSummarizer.summarize(
    billing.get(),
    billingUsageIndex,
    new Date().toISOString(),
    billingCurrentTarget,
    billingUsageWarnings,
  );
  return billingUsageReport;
}

function broadcastBillingUsage(): void {
  const report = refreshBillingReport();
  for (const window of BrowserWindow.getAllWindows())
    if (!window.isDestroyed())
      window.webContents.send(IPC.billingUsageChanged, report);
}

function quotaSettings(): QuotaSettings {
  return settings.get().quota ?? DEFAULT_QUOTA_SETTINGS;
}

function broadcastQuota(): void {
  const snapshot = quotaMonitor.get();
  for (const window of BrowserWindow.getAllWindows())
    if (!window.isDestroyed()) window.webContents.send(IPC.quotaChanged, snapshot);
}

function quotaSources(): QuotaSource[] {
  return quotaSourcesFor(billing.get(), {
    credentialFor: async (provider: string) => {
      const name = `${provider.toUpperCase()}_API_KEY`;
      return (
        (await credentials.get(name)) ??
        (await readHarnessCredential(
          path.join(app.getPath("userData"), "dsh"),
          name,
        ))
      );
    },
  });
}

/** 发请求后防抖刷新配额，让"刚刚撞上限额"尽快体现在界面上。 */
function scheduleQuotaRefresh(): void {
  if (quotaRefreshTimer) clearTimeout(quotaRefreshTimer);
  quotaRefreshTimer = setTimeout(() => {
    quotaRefreshTimer = null;
    void quotaMonitor.refresh(true);
  }, 2_000);
}

function billingTarget(value: unknown): BillingModelTarget | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object")
    throw new Error("无效的模型价格目标");
  const target = value as Partial<BillingModelTarget>;
  if (
    typeof target.provider !== "string" ||
    typeof target.model !== "string" ||
    !target.provider.trim() ||
    !target.model.trim()
  )
    throw new Error("无效的模型价格目标");
  return {
    provider: target.provider.trim().slice(0, 200),
    model: target.model.trim().slice(0, 300),
  };
}

async function showUsageWindow(): Promise<void> {
  if (usageWindow && !usageWindow.isDestroyed()) {
    usageWindow.show();
    usageWindow.focus();
    return;
  }
  const window = createPopupWindow({
    width: 980,
    height: 820,
    minWidth: 760,
    minHeight: 640,
    icon: appIconPath(),
    title: `用量与费用 · ${PRODUCT_NAME}`,
    backgroundColor: "#f7f8fa",
  });
  usageWindow = window;
  window.on("closed", () => {
    if (usageWindow === window) usageWindow = null;
  });
  await window.loadFile(rendererPath(path.join("workbench", "index.html")), {
    query: { view: "billing", mode: "popup" },
  });
}

async function showBilling(target?: BillingModelTarget): Promise<void> {
  if (target) await showLegacyBilling(target);
  else await showUsageWindow();
}

async function showLegacyBilling(target?: BillingModelTarget): Promise<void> {
  if (billingWindow && !billingWindow.isDestroyed()) {
    billingWindow.show();
    billingWindow.focus();
    if (target)
      billingWindow.webContents.send(IPC.billingEditRequested, target);
    return;
  }
  const window = createPopupWindow({
    width: 940,
    height: 800,
    minWidth: 720,
    minHeight: 620,
    icon: appIconPath(),
    title: `${PRODUCT_NAME} 计费与价格规则`,
  });
  billingWindow = window;
  window.on("closed", () => {
    if (billingWindow === window) billingWindow = null;
  });
  await window.loadFile(rendererPath("billing.html"));
  if (target && !billingWindow.isDestroyed())
    billingWindow.webContents.send(IPC.billingEditRequested, target);
}

type WorkbenchView = "changes";
const workbenchViews = new Set<WorkbenchView>(["changes"]);

async function showWorkbench(view: WorkbenchView = "changes"): Promise<void> {
  if (workbenchWindow && !workbenchWindow.isDestroyed()) {
    workbenchWindow.show();
    workbenchWindow.focus();
    workbenchWindow.webContents.send(IPC.workbenchNavigate, view);
    return;
  }
  const window = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 860,
    minHeight: 600,
    icon: appIconPath(),
    title: `审阅与工具 · ${PRODUCT_NAME}`,
    backgroundColor: "#f7f8fa",
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  workbenchWindow = window;
  secureWindow(window);
  workbenchWindow.setMenu(null);
  window.on("closed", () => {
    destroyPopupsOf(window);
    workbenchWindow = null;
  });
  await window.loadFile(rendererPath(path.join("workbench", "index.html")), {
    query: { view },
  });
}

async function checkHarnessVersion(): Promise<HarnessUpdateState> {
  const currentVersion = harness.getInfo().version;
  harnessUpdate = {
    ...harnessUpdate,
    phase: "checking",
    currentVersion,
    errorSummary: null,
  };
  broadcastInfo();
  harnessUpdate = await fetchHarnessUpdate(currentVersion);
  broadcastInfo();
  return harnessUpdate;
}

async function showUpdateResult(state: UpdateState): Promise<void> {
  if (!state.configured) {
    await dialog.showMessageBox({
      type: "info",
      title: "检查更新",
      message: "当前版本未配置在线更新源",
      detail:
        "本地开发包不会连接更新服务器。配置 GitHub Releases 后，正式构建会在这里检查更新。",
      buttons: ["知道了"],
    });
    return;
  }
  if (state.phase === "error") {
    await dialog.showMessageBox({
      type: "error",
      title: "检查更新失败",
      message: "暂时无法完成更新检查",
      detail: state.errorSummary ?? "请检查网络后重试。",
      buttons: ["知道了"],
    });
    return;
  }
  if (state.phase === "available") {
    const result = await dialog.showMessageBox({
      type: "info",
      title: "发现新版本",
      message: `DeepSeek Harness Desktop ${state.version ?? "新版本"} 可用`,
      detail: "可前往设置页面下载并安装更新。",
      buttons: ["打开设置", "稍后"],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) await showSettings();
    return;
  }
  if (state.phase === "ready") {
    await dialog.showMessageBox({
      type: "info",
      title: "更新已就绪",
      message: `${state.version ?? "新版本"} 已下载`,
      detail: "可在设置页面选择“重启并安装”。",
      buttons: ["知道了"],
    });
    return;
  }
  await dialog.showMessageBox({
    type: "info",
    title: "检查更新",
    message: "当前已是最新版本",
    detail: `当前版本：${app.getVersion()}`,
    buttons: ["知道了"],
  });
}

async function checkUpdatesWithFeedback(): Promise<void> {
  try {
    const state = await updates.check();
    await showUpdateResult(state);
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      title: "检查更新失败",
      message: "更新检查发生异常",
      detail: error instanceof Error ? error.message : String(error),
      buttons: ["知道了"],
    });
  }
}

function installMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "文件",
        submenu: [
          {
            label: "新建窗口",
            accelerator: "CmdOrCtrl+N",
            click: () => void createHarnessWindow(),
          },
          { type: "separator" },
          { role: "quit", label: "退出" },
        ],
      },
      {
        label: "Harness",
        submenu: [
          {
            label: "重新启动",
            accelerator: "CmdOrCtrl+Shift+R",
            click: () => void restartHarness(),
          },
          {
            label: "打开日志目录",
            click: () => void shell.openPath(app.getPath("logs")),
          },
        ],
      },
      {
        label: "应用",
        submenu: [
          {
            label: "打开工作台",
            accelerator: "CmdOrCtrl+Shift+E",
            click: () => void showWorkbench("changes"),
          },
          { type: "separator" },
          {
            label: "设置…",
            accelerator: "CmdOrCtrl+,",
            click: () => void showSettings(),
          },
          {
            label: "计费与价格规则",
            accelerator: "CmdOrCtrl+Shift+U",
            click: () => void showBilling(),
          },
          { label: "检查更新…", click: () => void checkUpdatesWithFeedback() },
          { type: "separator" },
          { role: "toggleDevTools", label: "开发者工具" },
        ],
      },
      {
        label: "帮助",
        submenu: [
          {
            label: "关于",
            click: () =>
              void dialog.showMessageBox({
                type: "info",
                icon: appIconPath(),
                title: `关于 ${PRODUCT_NAME}`,
                message: `${PRODUCT_NAME} ${app.getVersion()}`,
                detail: `${UNOFFICIAL_NOTICE}\n内置 DeepSeek Harness ${harness.getInfo().version}`,
              }),
          },
        ],
      },
    ]),
  );
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
    properties: ["openDirectory", "createDirectory"],
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
  await Promise.all(
    [...windows]
      .filter((window) => !window.isDestroyed())
      .map((window) =>
        window.loadURL(`${origin}/#desktop-session=${harness.sessionToken}`),
      ),
  );
  broadcastInfo();
  return info;
}

function assertTrustedIpc(event: IpcMainInvokeEvent): void {
  const sender = event.senderFrame?.url ?? "";
  let trusted =
    sender.startsWith("file://") &&
    (sender.includes("/settings.html") ||
      sender.includes("/billing.html") ||
      sender.includes("/splash.html") ||
      sender.includes("/workbench/index.html"));
  try {
    const url = new URL(sender);
    trusted ||= url.hostname === "127.0.0.1" && url.protocol === "http:";
  } catch {
    /* 交由下方统一拒绝 */
  }
  if (!trusted) throw new Error("拒绝来自不受信任页面的 IPC 请求");
}

function registerIpc(): void {
  const handle = <T extends unknown[]>(
    channel: string,
    action: (event: IpcMainInvokeEvent, ...args: T) => unknown,
  ) => {
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedIpc(event);
      return await action(event, ...(args as T));
    });
  };
  handle(IPC.getInfo, () => currentInfo());
  handle(IPC.restartHarness, () => restartHarness());
  handle(IPC.chooseWorkspace, () => chooseWorkspace());
  handle(IPC.openLogs, async () => {
    await shell.openPath(app.getPath("logs"));
  });
  handle(IPC.openSettings, () => showSettings());
  handle(IPC.openBilling, (_event, target?: unknown) =>
    showBilling(billingTarget(target)),
  );
  handle(IPC.openLegacyBilling, (_event, target?: unknown) =>
    showLegacyBilling(billingTarget(target)),
  );
  handle(IPC.openWorkbench, (_event, value?: unknown) => {
    const view =
      typeof value === "string" && workbenchViews.has(value as WorkbenchView)
        ? (value as WorkbenchView)
        : "changes";
    return showWorkbench(view);
  });
  handle(IPC.checkUpdate, () => updates.check());
  handle(IPC.checkHarnessUpdate, () => checkHarnessVersion());
  handle(IPC.downloadUpdate, () => updates.download());
  handle(IPC.finishSplashAnimation, () => {
    resolveSplashAnimation();
  });
  handle(IPC.retryStartup, () => retryStartup());
  handle(IPC.installUpdate, async () => {
    const userData = app.getPath("userData");
    await createBackup(
      path.join(userData, "dsh"),
      path.join(userData, "backups"),
      {
        desktopVersion: app.getVersion(),
        harnessVersion: harness.getInfo().version,
        createdAt: new Date().toISOString(),
      },
    );
    updates.install();
  });
  handle(IPC.setUpdateChannel, async (_event, channel: UpdateChannel) => {
    if (channel !== "stable" && channel !== "beta")
      throw new Error("无效的更新通道");
    await settings.patch({ updateChannel: channel });
    const state = await updates.setChannel(channel);
    broadcastInfo();
    return state;
  });
  handle(
    IPC.setThemePreference,
    async (_event, preference: ThemePreference) => {
      if (!(["light", "dark", "system"] as const).includes(preference))
        throw new Error("无效的外观设置");
      await themeStore.setPreference(preference);
      syncThemeFromHarness();
      return preference;
    },
  );
  handle(IPC.setCredential, async (_event, name: string, value: string) => {
    await credentials.set(name, value);
    if (name === "DEEPSEEK_API_KEY") deepSeekBalance.invalidate();
    if (name.endsWith("_API_KEY")) quotaMonitor.invalidate();
  });
  handle(IPC.hasCredential, (_event, name: string) => credentials.has(name));
  handle(IPC.removeCredential, async (_event, name: string) => {
    await credentials.remove(name);
    if (name === "DEEPSEEK_API_KEY") deepSeekBalance.invalidate();
    if (name.endsWith("_API_KEY")) quotaMonitor.invalidate();
  });
  handle(IPC.getDeepSeekBalance, () => deepSeekBalanceSnapshot());
  handle(IPC.refreshDeepSeekBalance, () => deepSeekBalanceSnapshot(true));
  handle(
    IPC.useOfficialBilling,
    async (_event, targetValue: unknown, catalogProviderValue: unknown) => {
      const target = billingTarget(targetValue);
      if (!target || typeof catalogProviderValue !== "string")
        throw new Error("无效的官方价格目标");
      const current = billing.get();
      const catalogProvider = catalogProviderValue.trim();
      if (
        !current.catalog.rules.some(
          (rule) =>
            rule.provider.toLowerCase() === catalogProvider.toLowerCase() &&
            rule.model.toLowerCase() === target.model.toLowerCase(),
        )
      )
        throw new Error("官方价格清单中没有这个模型");
      const providerBindings = current.providerBindings.filter(
        (binding) =>
          binding.provider.toLowerCase() !== target.provider.toLowerCase(),
      );
      if (target.provider.toLowerCase() !== catalogProvider.toLowerCase())
        providerBindings.push({ provider: target.provider, catalogProvider });
      const saved = await billing.saveUserSettings({
        ...restoreOfficialBilling(current, target.provider, target.model),
        providerBindings,
      });
      broadcastBilling();
      return billingSettingsSnapshot(saved);
    },
  );
  handle(IPC.getBillingSettings, () => billingSettingsSnapshot(billing.get()));
  handle(IPC.setBillingSettings, async (_event, value: BillingSettings) => {
    const saved = await billing.saveUserSettings(value);
    broadcastBilling();
    return billingSettingsSnapshot(saved);
  });
  handle(IPC.checkBillingPrices, async () => {
    const result = await billing.checkForUpdates();
    broadcastBilling();
    return { ...result, settings: billingSettingsSnapshot(result.settings) };
  });
  handle(IPC.getBillingUsage, () => refreshBillingReport());
  handle(IPC.getQuotaUsage, async () => {
    if (!quotaSettings().enabled) return quotaMonitor.refresh();
    const snapshot = quotaMonitor.get();
    const fresh =
      Boolean(snapshot.fetchedAt) &&
      Date.parse(snapshot.fetchedAt) >=
        Date.now() - quotaSettings().pollIntervalMinutes * 60_000;
    return fresh ? snapshot : quotaMonitor.refresh();
  });
  handle(IPC.refreshQuotaUsage, () => quotaMonitor.refresh(true));
  handle(IPC.getQuotaSettings, () => quotaSettings());
  handle(IPC.setQuotaSettings, async (_event, value: unknown) => {
    const saved = await settings.patch({
      quota: validateQuotaSettings(
        value && typeof value === "object"
          ? (value as Partial<QuotaSettings>)
          : undefined,
      ),
    });
    quotaMonitor.start();
    return saved.quota ?? DEFAULT_QUOTA_SETTINGS;
  });
  handle(IPC.getMemoryEntries, () => memoryStore.list());
  handle(IPC.deleteMemoryEntry, async (_event, idValue: unknown) => {
    if (typeof idValue !== "string" || !idValue) throw new Error("记忆 ID 无效");
    return await memoryStore.delete(idValue);
  });
  handle(IPC.getMemoryToolsEnabled, () => memoryStore.getEnabled());
  handle(IPC.setMemoryToolsEnabled, async (_event, enabledValue: unknown) => {
    if (typeof enabledValue !== "boolean") throw new Error("记忆开关值无效");
    return await memoryStore.setEnabled(enabledValue);
  });
  handle(
    IPC.reportBillingUsage,
    (_event, value: unknown, targetValue?: unknown) => {
      const normalized = normalizeBillingUsageSync(value);
      const missingSessions = applyBillingUsageSync(normalized.sync);
      billingUsageWarnings = missingSessions
        ? [
            ...normalized.warnings,
            `有 ${missingSessions} 个对话尚未完成增量同步，将在下次更新后计入。`,
          ]
        : normalized.warnings;
      billingCurrentTarget = billingTarget(targetValue);
      broadcastBillingUsage();
      scheduleQuotaRefresh();
      const reported = value as {
        collectedAt?: string;
        sessionIds?: string[];
        sessions?: Array<{ sessionId: string; revision: string; samples?: unknown[] }>;
        droppedSessions?: string[];
      } | null;
      void eventLog.append("session", "usage-report", {
        collectedAt: reported?.collectedAt ?? null,
        sessionIds: reported?.sessionIds ?? [],
        sessionCount: reported?.sessions?.length ?? 0,
        sampleCount:
          reported?.sessions?.reduce(
            (sum, session) => sum + (session.samples?.length ?? 0),
            0,
          ) ?? 0,
        droppedSessions: reported?.droppedSessions ?? [],
      });
      return billingUsageReport;
    },
  );
  const checkedText = (value: unknown, label: string, max = 500): string => {
    if (typeof value !== "string" || !value.trim() || value.length > max)
      throw new Error(`${label}无效`);
    return value.trim();
  };
  const broadcastChangeBatches = async () => {
    const batches = await changeSets.list();
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed())
        window.webContents.send(IPC.changeBatchesChanged, batches);
    return batches;
  };
  handle(
    IPC.setActiveWorkspaceContext,
    async (event, sessionValue: unknown, workspaceValue: unknown) => {
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      if (!senderWindow || !windows.has(senderWindow))
        throw new Error("只能由 Harness 会话更新工作区上下文");
      const sessionId = checkedText(sessionValue, "会话 ID", 200);
      if (workspaceValue === null) {
        workspaceContexts.delete(senderWindow.id);
        if (activeWorkspaceContext?.windowId === senderWindow.id)
          activeWorkspaceContext = null;
      } else {
        const workspace = path.resolve(
          checkedText(workspaceValue, "工作区", 2_000),
        );
        const context = {
          sessionId,
          path: workspace,
          windowId: senderWindow.id,
        };
        workspaceContexts.set(senderWindow.id, context);
        if (
          senderWindow.isFocused() ||
          activeWorkspaceContext?.windowId === senderWindow.id ||
          !activeWorkspaceContext
        )
          activeWorkspaceContext = context;
      }
      broadcastInfo();
    },
  );
  handle(IPC.createChangeBatch, async (_event, titleValue: unknown) => {
    const workspace = activeWorkspaceContext?.path;
    if (!workspace) throw new Error("请先在 Harness 中打开一个带工作区的对话");
    const batch = await changeSets.create(
      checkedText(titleValue, "任务标题", 240),
      workspace,
    );
    await broadcastChangeBatches();
    return batch;
  });
  handle(IPC.closeChangeBatch, async (_event, idValue: unknown) => {
    const batch = await changeSets.close(checkedText(idValue, "批次 ID", 120));
    await broadcastChangeBatches();
    return batch;
  });
  handle(IPC.listChangeBatches, () => changeSets.list());
  handle(IPC.getFileDiff, (_event, idValue: unknown, fileValue: unknown) =>
    changeSets.diff(
      checkedText(idValue, "批次 ID", 120),
      checkedText(fileValue, "文件路径", 2_000),
    ),
  );
  handle(
    IPC.markChangeReviewed,
    async (
      _event,
      idValue: unknown,
      fileValue: unknown,
      hunkValue?: unknown,
    ) => {
      const value = await changeSets.markReviewed(
        checkedText(idValue, "批次 ID", 120),
        checkedText(fileValue, "文件路径", 2_000),
        hunkValue === undefined
          ? undefined
          : checkedText(hunkValue, "代码块 ID", 120),
      );
      await broadcastChangeBatches();
      return value;
    },
  );
  handle(
    IPC.revertChangeFile,
    async (_event, idValue: unknown, fileValue: unknown) => {
      const value = await changeSets.revertFile(
        checkedText(idValue, "批次 ID", 120),
        checkedText(fileValue, "文件路径", 2_000),
      );
      await broadcastChangeBatches();
      return value;
    },
  );
  handle(
    IPC.revertChangeHunk,
    async (
      _event,
      idValue: unknown,
      fileValue: unknown,
      hunkValue: unknown,
    ) => {
      const value = await changeSets.revertHunk(
        checkedText(idValue, "批次 ID", 120),
        checkedText(fileValue, "文件路径", 2_000),
        checkedText(hunkValue, "代码块 ID", 120),
      );
      await broadcastChangeBatches();
      return value;
    },
  );
  handle(IPC.getVisionSettings, () => vision.getSettings());
  handle(IPC.setVisionSettings, (_event, value: unknown) => {
    const before = vision.getSettings();
    return vision.setSettings(value as never).then((saved) => {
      void eventLog.append("setting-change", "vision", {
        policy: saved.policy,
        defaultBackendId: saved.defaultBackendId,
        backends: saved.backends.length,
        imageDirectory: saved.imageDirectory,
        remoteDisclosureAccepted: saved.remoteDisclosureAccepted,
        changed: JSON.stringify(before) !== JSON.stringify(saved),
      });
      return saved;
    });
  });
  handle(IPC.testVisionBackend, (_event, value: unknown) =>
    vision
      .testBackend(value as never)
      .then((result) => {
        const backend = value as { id?: string; name?: string };
        void eventLog.append("ipc", "test-vision-backend", {
          backendId: backend?.id ?? null,
          backendName: backend?.name ?? null,
          ok: true,
        });
        return result;
      })
      .catch((cause) => {
        const backend = value as { id?: string; name?: string };
        void eventLog.append("error", "test-vision-backend", {
          backendId: backend?.id ?? null,
          backendName: backend?.name ?? null,
          message: cause instanceof Error ? cause.message : String(cause),
        });
        throw cause;
      }),
  );
  handle(IPC.saveVisionImage, (_event, value: unknown) => {
    if (typeof value !== "string" || value.length > 30_000_000)
      throw new Error("图片 Data URL 无效");
    return saveVisionImageFile(
      value,
      visionImagesDirectory(vision.getSettings()),
    ).then((saved) => {
      void eventLog.append("ipc", "save-vision-image", {
        imageId: saved.imageId,
        mimeType: saved.mimeType,
      });
      return saved;
    });
  });
  handle(IPC.pickVisionImageDirectory, async () => {
    const picked = await showDirectoryPicker();
    void eventLog.append("ipc", "pick-vision-image-directory", {
      picked: picked ?? null,
    });
    return picked;
  });
  handle(IPC.clearVisionImages, async () => {
    const directory = visionImagesDirectory(vision.getSettings());
    let removed = 0;
    try {
      const entries = await readdir(directory);
      for (const entry of entries) {
        await rm(path.join(directory, entry), { force: true });
        removed += 1;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    void eventLog.append("user-action", "clear-vision-images", {
      removed,
      directory,
    });
    return removed;
  });
  handle(IPC.appendEventLog, (_event, entry: unknown) => {
    const value = entry as { area?: unknown; type?: unknown } | null;
    const area =
      typeof value?.area === "string" ? value.area.slice(0, 60) : "sidecar";
    const type =
      typeof value?.type === "string" ? value.type.slice(0, 60) : "event";
    const fields: Record<string, unknown> = { ...value };
    delete fields.area;
    delete fields.type;
    return eventLog.append(area, type, fields);
  });
  handle(IPC.openLogDirectory, async () => {
    const directory = eventLog.directoryPath();
    await shell.openPath(directory);
    void eventLog.append("user-action", "open-log-directory", { directory });
  });
  handle(IPC.pickEventLogDirectory, async () => {
    const picked = await showDirectoryPicker();
    await settings.patch({ eventLogDirectory: picked });
    if (picked) {
      eventLog = new EventLog({ directory: () => picked });
      void eventLog.prune();
    }
    void eventLog.append("setting-change", "event-log-directory", {
      picked: picked ?? null,
    });
    return picked;
  });
  handle(IPC.getEventLogDirectory, () => settings.get()?.eventLogDirectory ?? null);
  handle(IPC.resetEventLogDirectory, async () => {
    await settings.patch({ eventLogDirectory: null });
    eventLog = new EventLog({
      directory: () => {
        const current = settings.get();
        return current?.eventLogDirectory?.trim()
          ? path.resolve(current.eventLogDirectory.trim())
          : path.join(app.getPath("userData"), "logs");
      },
    });
    void eventLog.append("setting-change", "event-log-directory", {
      picked: null,
    });
  });
  ipcMain.on(IPC.harnessIntegrationReady, (event) => {
    try {
      assertTrustedIpc(event);
    } catch {
      return;
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !windows.has(window)) return;
    integrationReadyWindows.add(window);
    for (const request of pendingWorkspaceOpens.values()) {
      if (request.sentTo === window.id) request.sentTo = null;
    }
    sendPendingWorkspaceOpens(window);
  });
  ipcMain.on(IPC.openWorkspaceResult, (event, result: OpenWorkspaceResult) => {
    try {
      assertTrustedIpc(event);
    } catch {
      return;
    }
    if (
      !result ||
      typeof result.requestId !== "string" ||
      typeof result.path !== "string" ||
      typeof result.ok !== "boolean"
    )
      return;
    const request = pendingWorkspaceOpens.get(result.requestId);
    if (!request || request.path !== result.path) return;
    pendingWorkspaceOpens.delete(result.requestId);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (result.ok) {
      log.info(`[desktop] opened workspace in a new session: ${result.path}`);
      focusHarnessWindow(window);
      return;
    }
    log.error(
      `[desktop] failed to open workspace from shell: ${result.path}: ${result.error ?? "unknown error"}`,
    );
    const options: Electron.MessageBoxOptions = {
      type: "error",
      title: "无法打开工作区",
      message: "拖入的文件夹未能在 Harness 中打开",
      detail: `${result.path}\n\n${result.error ?? "未知错误"}`,
      buttons: ["知道了"],
    };
    void (window
      ? dialog.showMessageBox(window, options)
      : dialog.showMessageBox(options));
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
    cancelId: 2,
  });
  if (result.response === 0) await restartHarness();
  else if (result.response === 1) await shell.openPath(app.getPath("logs"));
  else app.quit();
}

app.on("second-instance", (_event, commandLine, workingDirectory) => {
  void queueLaunchDirectories(commandLine, workingDirectory);
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.show();
    splashWindow.focus();
    return;
  }
  const window = [...windows][0];
  if (window) focusHarnessWindow(window);
  else if (harness) void createHarnessWindow();
});

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (app.isReady())
    void queueLaunchDirectories(
      launchArgumentsForPath(filePath),
      process.cwd(),
    );
  else earlyOpenPaths.push(filePath);
});

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  if (themeStore) unwatchFile(themeStore.filePath);
  if (quotaRefreshTimer) clearTimeout(quotaRefreshTimer);
  quotaMonitor?.stop();
  void harness
    .stop()
    .then(() => directoryPickerBridge?.stop())
    .finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (windows.size === 0 && !splashWindow) void createHarnessWindow();
});

void app.whenReady().then(async () => {
  log.initialize();
  log.transports.file.level = "info";
  log.transports.console.level = "info";
  const userData = app.getPath("userData");
  themeStore = new HarnessThemeStore(path.join(userData, "dsh"));
  syncThemeFromHarness(false);
  watchFile(themeStore.filePath, { interval: 500, persistent: false }, () =>
    syncThemeFromHarness(),
  );
  settings = new SettingsStore(userData);
  await settings.load();
  eventLog = new EventLog({
    directory: () => {
      const current = settings.get();
      return current?.eventLogDirectory?.trim()
        ? path.resolve(current.eventLogDirectory.trim())
        : path.join(userData, "logs");
    },
  });
  void eventLog.prune();
  billing = new BillingStore(settings, app.getAppPath());
  await billing.load();
  billingUsageReport = billingUsageSummarizer.summarize(
    billing.get(),
    billingUsageIndex,
    new Date().toISOString(),
  );
  credentials = new CredentialStore(userData);
  memoryStore = new MemoryStore(userData);
  changeSets = new ChangeSetService(userData);
  vision = new VisionService(settings, credentials, userData);
  deepSeekBalance = new DeepSeekBalanceService({
    credential: async () =>
      (await credentials.get("DEEPSEEK_API_KEY")) ??
      (await readHarnessCredential(
        path.join(userData, "dsh"),
        "DEEPSEEK_API_KEY",
      )),
  });
  quotaMonitor = new QuotaMonitor({
    sources: quotaSources,
    settings: quotaSettings,
    broadcast: broadcastQuota,
  });
  quotaMonitor.start();
  updates = new UpdateManager(
    settings.get().updateChannel,
    settings.get().updateRepository,
  );
  directoryPickerBridge = new DirectoryPickerBridge(showDirectoryPicker, {
    getConfig: async () => {
      const settings = vision.getSettings();
      return {
        policy: settings.policy,
        hasBackends: settings.backends.some((backend) => backend.enabled),
        defaultBackendId: settings.defaultBackendId,
      };
    },
    analyze: async (request) => {
      const settings = vision.getSettings();
      const startedAt = Date.now();
      try {
        const image = await resolveVisionImageFile(
          request.imageId,
          visionImagesDirectory(settings),
        );
        const result = await vision.analyze({
          requestId: randomUUID(),
          backendId: request.backendId ?? settings.defaultBackendId ?? undefined,
          question: request.question,
          imageDataUrl: image.dataUrl,
          mimeType: image.mimeType,
        });
        void eventLog.append("vision-analyze", "request", {
          imageId: request.imageId,
          backendName: result.backendName,
          model: result.model,
          cached: result.cached,
          durationMs: result.durationMs,
          outputTokens: result.usage?.outputTokens ?? null,
        });
        return {
          text: result.text,
          backendName: result.backendName,
          model: result.model,
          cached: result.cached,
          durationMs: result.durationMs,
        };
      } catch (cause) {
        void eventLog.append("error", "vision-analyze", {
          imageId: request.imageId,
          durationMs: Date.now() - startedAt,
          message: cause instanceof Error ? cause.message : String(cause),
        });
        throw cause;
      }
    },
  });
  const bridgeInfo = await directoryPickerBridge.start();
  const desktopOverlayPath = await writeDesktopOverlay(
    path.join(userData, "desktop-runtime"),
    directoryPickerPluginPath(),
    billingPluginPath(),
    memoryPluginPath(),
    visionPluginPath(),
  );
  harness = new HarnessManager({
    dshHome: path.join(userData, "dsh"),
    workspace: () => settings.get().workspacePath,
    credentials: () => credentials.environment(),
    log: (message) => log.info(message),
    desktopOverlayPath,
    directoryPickerBridge: bridgeInfo,
    memoryPath: path.join(userData, "memory.json"),
  });
  harness.on("changed", (info) => {
    broadcastInfo();
    if (info.status === "failed") void handleHarnessFailure();
  });
  updates.on("changed", broadcastInfo);
  registerIpc();
  if (billing.shouldAutoCheck())
    void billing
      .checkForUpdates()
      .then(broadcastBilling)
      .catch((error) => log.warn("价格清单自动检查失败", error));
  installMenu();
  await queueLaunchDirectories(process.argv, process.cwd());
  for (const filePath of earlyOpenPaths.splice(0)) {
    await queueLaunchDirectories(
      launchArgumentsForPath(filePath),
      process.cwd(),
    );
  }
  try {
    if (process.env.DSH_DESKTOP_SMOKE_TEST === "1") {
      const started = await harness.start();
      const root = await fetch(`http://127.0.0.1:${started.port}/`).then(
        (response) => response.text(),
      );
      if (!root.includes("deepseek-harness-desktop-integration")) {
        throw new Error("桌面集成客户端未写入 Harness 启动清单");
      }
      const bootScripts = [...root.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map((match) => match[1])
        .filter(
          (source): source is string =>
            typeof source === "string" &&
            (source.includes("window.__DSH_BOOT__ =") ||
              source.includes("deepseek-harness-desktop-integration")),
        );
      const smokeWindow: { __DSH_BOOT__?: { entries: Array<{ id: string }> } } =
        {};
      for (const source of bootScripts) Function("window", source)(smokeWindow);
      if (
        !smokeWindow.__DSH_BOOT__?.entries.some(
          (entry) => entry.id === "deepseek-harness-desktop-integration",
        )
      ) {
        throw new Error("桌面集成客户端未能加入 Harness 启动图");
      }
      const clientSource = await fetch(
        `http://127.0.0.1:${started.port}/desktop-integration/client.js`,
      ).then((response) => response.text());
      if (!clientSource.includes("desktop:open-workspace")) {
        throw new Error("桌面集成客户端路由不可用");
      }
      if (
        !clientSource.includes("conversation.session.header.utilities") ||
        !clientSource.includes("openBilling")
      ) {
        throw new Error("右上角用量与费用入口不可用");
      }
      let clientExports: { inject?: unknown } | undefined;
      const moduleWindow = {
        __ModuleLoader__: {
          load: (handoff: {
            factory: (require: (id: string) => unknown) => { inject?: unknown };
          }) => {
            clientExports = handoff.factory(() => ({}));
          },
        },
      };
      Function("window", clientSource)(moduleWindow);
      if (
        JSON.stringify(clientExports?.inject) !==
        JSON.stringify(["workspaces", "sessions", "slots", "modelDirectories"])
      ) {
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
