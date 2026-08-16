/** 配额监控域：套餐配额（限额）≠ 扣费。独立于计费规则。 */

export type QuotaWindowKind = "weekly" | "rolling" | "expiry";

export interface QuotaWindow {
  id: string;
  label: string;
  kind: QuotaWindowKind;
  /** 计量单位，如 "次" / "token"。 */
  unit: string;
  used: number;
  limit: number;
  /** clamp(limit - used, 0)。 */
  remaining: number;
  /** weekly/expiry 有重置时刻；rolling（滚动吞吐）为 null，自恢复。 */
  resetTime: string | null;
  /** 本次抓取时刻（ISO）。 */
  asOf: string;
}

export interface QuotaPlan {
  /** Harness provider route。 */
  provider: string;
  planName: string | null;
  windows: QuotaWindow[];
}

export type QuotaWarningKind = "near-limit" | "exhausted";

export interface QuotaWarning {
  provider: string;
  windowId: string;
  kind: QuotaWarningKind;
  remaining: number;
  limit: number;
  threshold: number;
}

export interface QuotaSnapshot {
  fetchedAt: string;
  plans: QuotaPlan[];
  warnings: QuotaWarning[];
  /** provider → 错误摘要（网络 / 401 / 格式无效）。 */
  errors: Record<string, string>;
  /** 有配额源但未配置 API key 的 provider。 */
  needsKey: string[];
}

export interface QuotaSettings {
  enabled: boolean;
  /** 定时轮询间隔（分钟）。 */
  pollIntervalMinutes: number;
  /** 剩余占比低于该值预警，如 0.2 = 用到 80% 提醒。 */
  warningThreshold: number;
}

export const DEFAULT_QUOTA_SETTINGS: QuotaSettings = {
  enabled: true,
  pollIntervalMinutes: 30,
  warningThreshold: 0.2,
};

export function validateQuotaSettings(
  value: Partial<QuotaSettings> | undefined,
): QuotaSettings {
  const settings: QuotaSettings = {
    enabled: value?.enabled ?? DEFAULT_QUOTA_SETTINGS.enabled,
    pollIntervalMinutes:
      value?.pollIntervalMinutes ?? DEFAULT_QUOTA_SETTINGS.pollIntervalMinutes,
    warningThreshold:
      value?.warningThreshold ?? DEFAULT_QUOTA_SETTINGS.warningThreshold,
  };
  settings.enabled = Boolean(settings.enabled);
  settings.pollIntervalMinutes = Number.isSafeInteger(
    settings.pollIntervalMinutes,
  )
    ? Math.min(60 * 24, Math.max(1, settings.pollIntervalMinutes))
    : DEFAULT_QUOTA_SETTINGS.pollIntervalMinutes;
  settings.warningThreshold = Number.isFinite(settings.warningThreshold)
    ? Math.min(1, Math.max(0, settings.warningThreshold))
    : DEFAULT_QUOTA_SETTINGS.warningThreshold;
  return settings;
}
