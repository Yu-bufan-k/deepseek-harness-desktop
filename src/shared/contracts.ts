import type {
  BillingSettings,
  BillingSettingsSnapshot,
  BillingUpdateResult,
  BillingUsageReport,
  BillingUsageSync,
} from "./billing.js";

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
export type VisionImageEncoding = "data-url" | "base64" | "path";

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
  headers: Record<string, string>;
  headerCredentialNames: Record<string, string>;
}

export interface McpVisionArgumentMapping {
  imageArgument: string;
  imageEncoding: VisionImageEncoding;
  questionArgument: string | null;
  mimeTypeArgument: string | null;
  resultTextPath: string | null;
}

export interface McpStdioVisionBackendConfig extends VisionBackendBase {
  kind: "mcp";
  transport: "stdio";
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  envCredentialNames: Record<string, string>;
  allowLocalPath: boolean;
  toolName: string;
  mapping: McpVisionArgumentMapping;
}

export interface McpHttpVisionBackendConfig extends VisionBackendBase {
  kind: "mcp";
  transport: "streamable-http";
  url: string;
  headers: Record<string, string>;
  headerCredentialNames: Record<string, string>;
  toolName: string;
  mapping: McpVisionArgumentMapping;
}

export type VisionBackendConfig =
  | DirectVisionBackendConfig
  | McpStdioVisionBackendConfig
  | McpHttpVisionBackendConfig;
export type McpVisionBackendConfig =
  McpStdioVisionBackendConfig | McpHttpVisionBackendConfig;

export interface VisionSettings {
  policy: VisionPolicy;
  defaultBackendId: string | null;
  remoteDisclosureAccepted: boolean;
  backends: VisionBackendConfig[];
}

export interface VisionToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

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

export interface DesktopAttachmentRecord {
  id: string;
  sessionId: string | null;
  requestId: string;
  mimeType: string;
  imageHash: string;
  backendId: string | null;
  status: "pending" | "analyzing" | "ready" | "failed";
  visionText: string | null;
  errorSummary: string | null;
  createdAt: string;
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
  discoverVisionTools: "desktop:discover-vision-tools",
  testVisionBackend: "desktop:test-vision-backend",
  analyzeVision: "desktop:analyze-vision",
  cancelVision: "desktop:cancel-vision",
  getCachedVision: "desktop:get-cached-vision",
  listVisionAttachments: "desktop:list-vision-attachments",
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
  openWorkbench(view?: "changes" | "vision"): Promise<void>;
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
  discoverVisionTools(
    backend: VisionBackendConfig,
  ): Promise<VisionToolDescriptor[]>;
  testVisionBackend(
    backend: VisionBackendConfig,
  ): Promise<{ ok: true; tools?: VisionToolDescriptor[] }>;
  analyzeVision(request: VisionRequest): Promise<VisionResult>;
  cancelVision(requestId: string): Promise<void>;
  getCachedVision(request: VisionRequest): Promise<VisionResult | null>;
  listVisionAttachments(sessionId?: string): Promise<DesktopAttachmentRecord[]>;
  onWorkbenchNavigate(listener: (view: string) => void): () => void;
}
