import type {
  BillingModelBucket,
  BillingUsageSeriesBucket,
} from "../shared/billing.js";

export type RangeKey = "today" | "7d" | "30d" | "all" | "custom";
export type Metric = "cost" | "tokens" | "requests";
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export interface ChartBucket {
  key: number;
  requests: number;
  models: Record<string, BillingModelBucket>;
  cost: Record<string, bigint>;
}

export const dayStart = (time: number): number => {
  const d = new Date(time);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
export const toDateStr = (time: number): string => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const compactTokens = (value: number): string =>
  value >= 1e6
    ? `${(value / 1e6).toFixed(1)}M`
    : value >= 1e3
      ? `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}K`
      : String(value);
export const modelLabel = (key: string): string => {
  try {
    const [provider, model] = JSON.parse(key) as [string, string];
    return `${provider} / ${model}`;
  } catch {
    return key;
  }
};
/** 从 model key（JSON.stringify([provider, model])，provider 已 normalize）解析 provider。 */
export const modelProvider = (key: string): string => {
  try {
    const [provider] = JSON.parse(key) as [string, string];
    return provider;
  } catch {
    return key;
  }
};
export const sumModelTokens = (
  bucket: BillingModelBucket | undefined,
): number =>
  bucket
    ? bucket.input + bucket.cacheRead + bucket.cacheWrite + bucket.output
    : 0;

export function rangeBounds(
  range: RangeKey,
  customStart: string,
  customEnd: string,
): { start: number; end: number } | null {
  const today = dayStart(Date.now());
  if (range === "today") return { start: today, end: today + DAY_MS };
  if (range === "7d") return { start: today - 6 * DAY_MS, end: today + DAY_MS };
  if (range === "30d")
    return { start: today - 29 * DAY_MS, end: today + DAY_MS };
  if (range === "all") return { start: 0, end: Number.MAX_SAFE_INTEGER };
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(customStart) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(customEnd)
  )
    return null;
  const [startY, startM, startD] = customStart.split("-").map(Number);
  const [endY, endM, endD] = customEnd.split("-").map(Number);
  const start = new Date(startY!, startM! - 1, startD!).getTime();
  const end = new Date(endY!, endM! - 1, endD!).getTime() + DAY_MS;
  return end > start ? { start, end } : null;
}

/** 报告里出现的去重 provider（原样大小写），供分片筛选。 */
export function providerOptions(
  sessions: ReadonlyArray<{ models: ReadonlyArray<{ provider: string }> }>,
): string[] {
  const seen = new Set<string>();
  for (const session of sessions)
    for (const model of session.models) seen.add(model.provider);
  return [...seen].sort((left, right) => left.localeCompare(right));
}

/** 把报告里稀疏的小时桶收敛到所选范围内；范围 ≤ 24h 按小时，否则按天聚合。
 *  传 provider 时只保留该厂商的模型，并按模型重算请求数与费用。 */
export function rollupSeries(
  series: BillingUsageSeriesBucket[],
  start: number,
  end: number,
  provider?: string | null,
): ChartBucket[] {
  const byKey = new Map<number, ChartBucket>();
  const hourly = end - start <= DAY_MS;
  const normalizedProvider = provider?.trim().toLowerCase();
  for (const bucket of series) {
    if (bucket.hourStart < start || bucket.hourStart >= end) continue;
    const activeModels = normalizedProvider
      ? Object.entries(bucket.models).filter(
          ([modelKey]) => modelProvider(modelKey) === normalizedProvider,
        )
      : Object.entries(bucket.models);
    if (normalizedProvider && activeModels.length === 0) continue;
    const key = hourly ? bucket.hourStart : dayStart(bucket.hourStart);
    let target = byKey.get(key);
    if (!target) {
      target = { key, requests: 0, models: {}, cost: {} };
      byKey.set(key, target);
    }
    for (const [modelKey, part] of activeModels) {
      const merged = target.models[modelKey];
      if (merged) {
        merged.input += part.input;
        merged.cacheRead += part.cacheRead;
        merged.cacheWrite += part.cacheWrite;
        merged.output += part.output;
        merged.requests += part.requests;
        for (const [currency, nanos] of Object.entries(part.cost))
          merged.cost[currency] = String(
            (merged.cost[currency] ? BigInt(merged.cost[currency]) : 0n) +
              BigInt(nanos),
          );
      } else target.models[modelKey] = { ...part, cost: { ...part.cost } };
    }
    if (normalizedProvider) {
      target.requests = 0;
      target.cost = {};
      for (const part of Object.values(target.models)) {
        target.requests += part.requests;
        for (const [currency, nanos] of Object.entries(part.cost))
          target.cost[currency] =
            (target.cost[currency] ?? 0n) + BigInt(nanos);
      }
    } else {
      target.requests += bucket.requests;
      for (const [currency, nanos] of Object.entries(bucket.cost))
        target.cost[currency] = (target.cost[currency] ?? 0n) + BigInt(nanos);
    }
  }
  return [...byKey.values()].sort((left, right) => left.key - right.key);
}

export function bucketLabel(
  key: number,
  granularity: "hour" | "day",
  full = false,
): string {
  const d = new Date(key);
  if (granularity === "hour")
    return full
      ? `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}时`
      : `${String(d.getHours()).padStart(2, "0")}时`;
  return full
    ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getMonth() + 1}/${d.getDate()}`;
}
