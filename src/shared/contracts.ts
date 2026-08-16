import type {
  BillingSettings,
  BillingSettingsSnapshot,
  BillingUpdateResult,
  BillingUsageReport,
  BillingUsageSync,
} from "./billing.js";
import type { QuotaSettings, QuotaSnapshot } from "./quota.js";
import type { MemoryEntry } from "./memory.js";

export type HarnessStatus =
  "starting" | "ready" | "stopping" | "stopped" | "failed";

export interface HarnessInfo {
  status: HarnessStatus;
  version: string;
  port: number | null;
  pid: number | null;
  startedAt: string | null;
  errorSummary: string | null;
}

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export interface UpdateState {
  phase: UpdatePhase;
  configured: boolean;
  version: string | null;
  percent: number | null;
  errorSummary: string | null;
}

export interface HarnessUpdateState {
  phase: "idle" | "checking" | "ready" | "error";
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  errorSummary: string | null;
}

export interface BillingModelTarget {
  provider: string;
  model: string;
}
export interface BillingUpdateSnapshotResult extends Omit<
  BillingUpdateResult,
  "settings"
> {
  settings: BillingSettingsSnapshot;
}
export interface DeepSeekBalanceInfo {
  currency: "CNY" | "USD";
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
  totalDisplay: string;
  grantedDisplay: string;
  toppedUpDisplay: string;
  warning: boolean;
  warningThreshold: string | null;
  warningThresholdDisplay: string | null;
}
export interface DeepSeekBalanceSnapshot {
  configured: boolean;
  isAvailable: boolean | null;
  balances: DeepSeekBalanceInfo[];
  checkedAt: string | null;
  stale: boolean;
  errorSummary: string | null;
}

export type UpdateChannel = "stable" | "beta";
export type ThemePreference = "light" | "dark" | "system";

export type ReviewState = "unreviewed" | "reviewed" | "reverted";
export type FileChangeKind =
  "added" | "modified" | "deleted" | "renamed" | "binary";

export interface DiffHunk {
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  reviewState: ReviewState;
}

export interface FileChange {
  path: string;
  previousPath: string | null;
  kind: FileChangeKind;
  binary: boolean;
  originalHash: string | null;
  currentHash: string | null;
  additions: number;
  deletions: number;
  reviewState: ReviewState;
  hunks: DiffHunk[];
}

export interface ChangeBatch {
  id: string;
  title: string;
  workspacePath: string;
  createdAt: string;
  closedAt: string | null;
  state: "capturing" | "ready" | "stale";
  preexistingDirtyPaths: string[];
  files: FileChange[];
}

export interface FileDiff {
  batchId: string;
  path: string;
  language: string;
  original: string;
  modified: string;
  change: FileChange;
}

export type VisionPolicy = "auto" | "always" | "off";

interface VisionBackendBase {
  id: string;
  name: string;
  enabled: boolean;
  model: string;
  timeoutMs: number;
}

export interface DirectVisionBackendConfig extends VisionBackendBase {
  kind: "direct";
  baseUrl: string;
  credentialName: string;
}

export interface McpVisionBackendConfig extends VisionBackendBase {
  kind: "mcp";
  command: string;
  args: string[];
  cwd: string;
  toolName: string;
  imageArgument: string;
  questionArgument: string;
}

export type VisionBackendConfig =
  | DirectVisionBackendConfig
  | McpVisionBackendConfig;

export interface VisionSettings {
  policy: VisionPolicy;
  defaultBackendId: string | null;
  remoteDisclosureAccepted: boolean;
  /** 图片存盘目录；null = 默认 userData/vision */
  imageDirectory: string | null;
  backends: VisionBackendConfig[];
}

export interface VisionToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 图片存盘后返回给侧边栏的标识；imageId 即 sha256，文件在 userData/vision/<imageId>.<ext>。 */
export interface SavedVisionImage {
  imageId: string;
  mimeType: string;
}

/** 视觉工具经桥调用主进程 VisionService 的请求 / 结果（仅主进程侧使用，不进 IPC）。 */
export interface VisionAnalyzeRequest {
  imageId: string;
  question: string;
  backendId?: string;
}

export interface VisionAnalyzeResult {
  text: string;
  backendName: string;
  model: string;
  cached: boolean;
  durationMs: number;
}

// VisionService 内部使用的请求/结果类型（analyze 直接调用，不再经 IPC 暴露）。
export interface VisionRequest {
  requestId: string;
  sessionId?: string;
  backendId?: string;
  question: string;
  imageDataUrl?: string;
  imagePath?: string;
  mimeType: string;
  force?: boolean;
}

export interface VisionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface VisionResult {
  requestId: string;
  backendId: string;
  backendName: string;
  model: string;
  text: string;
  imageHash: string;
  cached: boolean;
  durationMs: number;
  createdAt: string;
  usage: VisionUsage;
}

export interface DesktopInfo {
  appVersion: string;
  harness: HarnessInfo;
  update: UpdateState;
  harnessUpdate: HarnessUpdateState;
  updateChannel: UpdateChannel;
  themePreference: ThemePreference;
  userDataPath: string;
  workspacePath: string | null;
  activeWorkspacePath: string | null;
  logsPath: string;
  unofficialNotice: string;
}

export const IPC = {
  getInfo: "desktop:get-info",
  restartHarness: "desktop:restart-harness",
  chooseWorkspace: "desktop:choose-workspace",
  openLogs: "desktop:open-logs",
  openSettings: "desktop:open-settings",
  openBilling: "desktop:open-billing",
  openLegacyBilling: "desktop:open-legacy-billing",
  openWorkbench: "desktop:open-workbench",
  workbenchNavigate: "desktop:workbench-navigate",
  checkUpdate: "desktop:check-update",
  checkHarnessUpdate: "desktop:check-harness-update",
  downloadUpdate: "desktop:download-update",
  installUpdate: "desktop:install-update",
  setUpdateChannel: "desktop:set-update-channel",
  setThemePreference: "desktop:set-theme-preference",
  finishSplashAnimation: "desktop:finish-splash-animation",
  retryStartup: "desktop:retry-startup",
  splashReady: "desktop:splash-ready",
  setCredential: "desktop:set-credential",
  hasCredential: "desktop:has-credential",
  removeCredential: "desktop:remove-credential",
  getDeepSeekBalance: "desktop:get-deepseek-balance",
  refreshDeepSeekBalance: "desktop:refresh-deepseek-balance",
  useOfficialBilling: "desktop:use-official-billing",
  getBillingSettings: "desktop:get-billing-settings",
  setBillingSettings: "desktop:set-billing-settings",
  checkBillingPrices: "desktop:check-billing-prices",
  billingChanged: "desktop:billing-changed",
  reportBillingUsage: "desktop:report-billing-usage",
  getBillingUsage: "desktop:get-billing-usage",
  billingUsageChanged: "desktop:billing-usage-changed",
  billingEditRequested: "desktop:billing-edit-requested",
  getQuotaUsage: "desktop:get-quota-usage",
  refreshQuotaUsage: "desktop:refresh-quota-usage",
  quotaChanged: "desktop:quota-changed",
  getQuotaSettings: "desktop:get-quota-settings",
  setQuotaSettings: "desktop:set-quota-settings",
  getMemoryEntries: "desktop:get-memory-entries",
  deleteMemoryEntry: "desktop:delete-memory-entry",
  getMemoryToolsEnabled: "desktop:get-memory-tools-enabled",
  setMemoryToolsEnabled: "desktop:set-memory-tools-enabled",
  infoChanged: "desktop:info-changed",
  harnessIntegrationReady: "desktop:harness-integration-ready",
  openWorkspace: "desktop:open-workspace",
  openWorkspaceResult: "desktop:open-workspace-result",
  createChangeBatch: "desktop:create-change-batch",
  setActiveWorkspaceContext: "desktop:set-active-workspace-context",
  closeChangeBatch: "desktop:close-change-batch",
  listChangeBatches: "desktop:list-change-batches",
  getFileDiff: "desktop:get-file-diff",
  markChangeReviewed: "desktop:mark-change-reviewed",
  revertChangeFile: "desktop:revert-change-file",
  revertChangeHunk: "desktop:revert-change-hunk",
  changeBatchesChanged: "desktop:change-batches-changed",
  getVisionSettings: "desktop:get-vision-settings",
  setVisionSettings: "desktop:set-vision-settings",
  testVisionBackend: "desktop:test-vision-backend",
  saveVisionImage: "desktop:save-vision-image",
  pickVisionImageDirectory: "desktop:pick-vision-image-directory",
  clearVisionImages: "desktop:clear-vision-images",
  appendEventLog: "desktop:append-event-log",
  openLogDirectory: "desktop:open-log-directory",
  pickEventLogDirectory: "desktop:pick-event-log-directory",
  getEventLogDirectory: "desktop:get-event-log-directory",
  resetEventLogDirectory: "desktop:reset-event-log-directory",
} as const;

export interface OpenWorkspaceRequest {
  requestId: string;
  path: string;
}

export interface OpenWorkspaceResult {
  requestId: string;
  path: string;
  ok: boolean;
  error?: string;
}

export interface DesktopApi {
  getInfo(): Promise<DesktopInfo>;
  restartHarness(): Promise<HarnessInfo>;
  chooseWorkspace(): Promise<string | null>;
  openLogs(): Promise<void>;
  openSettings(): Promise<void>;
  openBilling(target?: BillingModelTarget): Promise<void>;
  openLegacyBilling(target?: BillingModelTarget): Promise<void>;
  openWorkbench(view?: "changes"): Promise<void>;
  checkUpdate(): Promise<UpdateState>;
  checkHarnessUpdate(): Promise<HarnessUpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<void>;
  setUpdateChannel(channel: UpdateChannel): Promise<UpdateState>;
  setThemePreference(preference: ThemePreference): Promise<ThemePreference>;
  finishSplashAnimation(): Promise<void>;
  retryStartup(): Promise<HarnessInfo>;
  setCredential(name: string, value: string): Promise<void>;
  hasCredential(name: string): Promise<boolean>;
  removeCredential(name: string): Promise<void>;
  getDeepSeekBalance(): Promise<DeepSeekBalanceSnapshot>;
  refreshDeepSeekBalance(): Promise<DeepSeekBalanceSnapshot>;
  useOfficialBilling(
    target: BillingModelTarget,
    catalogProvider: string,
  ): Promise<BillingSettingsSnapshot>;
  getBillingSettings(): Promise<BillingSettingsSnapshot>;
  setBillingSettings(
    settings: BillingSettings,
  ): Promise<BillingSettingsSnapshot>;
  checkBillingPrices(): Promise<BillingUpdateSnapshotResult>;
  reportBillingUsage(
    index: BillingUsageSync,
    currentTarget?: BillingModelTarget,
  ): Promise<BillingUsageReport>;
  getBillingUsage(): Promise<BillingUsageReport>;
  onBillingUsageChanged(
    listener: (report: BillingUsageReport) => void,
  ): () => void;
  onBillingEditRequested(
    listener: (target: BillingModelTarget) => void,
  ): () => void;
  onBillingChanged(
    listener: (settings: BillingSettingsSnapshot) => void,
  ): () => void;
  getQuotaUsage(): Promise<QuotaSnapshot>;
  refreshQuotaUsage(): Promise<QuotaSnapshot>;
  onQuotaUsageChanged(
    listener: (snapshot: QuotaSnapshot) => void,
  ): () => void;
  getQuotaSettings(): Promise<QuotaSettings>;
  setQuotaSettings(settings: QuotaSettings): Promise<QuotaSettings>;
  getMemoryEntries(): Promise<MemoryEntry[]>;
  deleteMemoryEntry(id: string): Promise<MemoryEntry[]>;
  getMemoryToolsEnabled(): Promise<boolean>;
  setMemoryToolsEnabled(enabled: boolean): Promise<boolean>;
  onInfoChanged(listener: (info: DesktopInfo) => void): () => void;
  onSplashReady(listener: () => void): () => void;
  setActiveWorkspaceContext(
    sessionId: string,
    workspacePath: string | null,
  ): Promise<void>;
  createChangeBatch(title: string): Promise<ChangeBatch>;
  closeChangeBatch(batchId: string): Promise<ChangeBatch>;
  listChangeBatches(): Promise<ChangeBatch[]>;
  getFileDiff(batchId: string, filePath: string): Promise<FileDiff>;
  markChangeReviewed(
    batchId: string,
    filePath: string,
    hunkId?: string,
  ): Promise<ChangeBatch>;
  revertChangeFile(batchId: string, filePath: string): Promise<ChangeBatch>;
  revertChangeHunk(
    batchId: string,
    filePath: string,
    hunkId: string,
  ): Promise<ChangeBatch>;
  onChangeBatchesChanged(
    listener: (batches: ChangeBatch[]) => void,
  ): () => void;
  getVisionSettings(): Promise<VisionSettings>;
  setVisionSettings(settings: VisionSettings): Promise<VisionSettings>;
  testVisionBackend(
    backend: VisionBackendConfig,
  ): Promise<{ ok: true; tools?: VisionToolDescriptor[] }>;
  saveVisionImage(dataUrl: string): Promise<SavedVisionImage>;
  /** 弹系统目录选择器；返回选择的目录，取消返回 null */
  pickVisionImageDirectory(): Promise<string | null>;
  /** 清空图片存盘目录里的文件，返回删除数量 */
  clearVisionImages(): Promise<number>;
  /** 上报一条事件日志（sidecar 用户操作等） */
  appendEventLog(entry: {
    area: string;
    type: string;
    [key: string]: unknown;
  }): Promise<void>;
  /** 打开事件日志目录（系统文件管理器） */
  openLogDirectory(): Promise<void>;
  /** 弹系统目录选择器选择日志目录（选中即保存）；取消返回 null */
  pickEventLogDirectory(): Promise<string | null>;
  /** 当前自定义日志目录；null = 默认 userData/logs */
  getEventLogDirectory(): Promise<string | null>;
  /** 恢复默认日志目录 */
  resetEventLogDirectory(): Promise<void>;
  onWorkbenchNavigate(listener: (view: string) => void): () => void;
}
