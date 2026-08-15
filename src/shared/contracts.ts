import type { BillingSettings, BillingSettingsSnapshot, BillingUpdateResult, BillingUsageReport, BillingUsageSync } from "./billing.js";

export type HarnessStatus = "starting" | "ready" | "stopping" | "stopped" | "failed";

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

export interface BillingModelTarget { provider: string; model: string; }
export interface BillingUpdateSnapshotResult extends Omit<BillingUpdateResult, "settings"> { settings: BillingSettingsSnapshot; }

export type UpdateChannel = "stable" | "beta";
export type ThemePreference = "light" | "dark" | "system";

export interface DesktopInfo {
  appVersion: string;
  harness: HarnessInfo;
  update: UpdateState;
  harnessUpdate: HarnessUpdateState;
  updateChannel: UpdateChannel;
  themePreference: ThemePreference;
  userDataPath: string;
  workspacePath: string | null;
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
  openWorkspaceResult: "desktop:open-workspace-result"
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
  getBillingSettings(): Promise<BillingSettingsSnapshot>;
  setBillingSettings(settings: BillingSettings): Promise<BillingSettingsSnapshot>;
  checkBillingPrices(): Promise<BillingUpdateSnapshotResult>;
  reportBillingUsage(index: BillingUsageSync, currentTarget?: BillingModelTarget): Promise<BillingUsageReport>;
  getBillingUsage(): Promise<BillingUsageReport>;
  onBillingUsageChanged(listener: (report: BillingUsageReport) => void): () => void;
  onBillingEditRequested(listener: (target: BillingModelTarget) => void): () => void;
  onBillingChanged(listener: (settings: BillingSettingsSnapshot) => void): () => void;
  onInfoChanged(listener: (info: DesktopInfo) => void): () => void;
  onSplashReady(listener: () => void): () => void;
}
