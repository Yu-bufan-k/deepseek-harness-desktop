import { createHash } from "node:crypto";
import type { BillingSettings } from "../shared/billing.js";
import type { QuotaPlan, QuotaWindow } from "../shared/quota.js";

/** Kimi Code 配额接口（逆向工程、未官方文档化）：GET /coding/v1/usages。
 *  响应示例：
 *  {
 *    "usage": { "limit": "100", "used": "48", "remaining": "52", "resetTime": "2026-05-19T04:12:48Z" },
 *    "limits": [ { "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },
 *                  "limit": "100", "used": "7", "remaining": "93", "resetTime": "..." } ],
 *    "parallel": { "limit": "20" }, "totalQuota": "99", "user": { "level": "LEVEL_INTERMEDIATE" }
 *  }
 *  `usage` = 周配额（订阅日重置，不累积）；`limits[]` 中 TIME_UNIT_MINUTE 的窗口为滚动吞吐限额
 *  （duration 300 = 5 小时，自恢复）。字段可能随时变化，故按防御性解析 + fixture 测试。 */
const KIMI_USAGES_ENDPOINT = "https://api.kimi.com/coding/v1/usages";
const MAX_RESPONSE_BYTES = 64_000;
const CACHE_MS = 5 * 60_000;

export interface QuotaSource {
  readonly provider: string;
  /** 拉取配额计划；无 key 时返回 null，出错时抛出。 */
  poll(force?: boolean): Promise<QuotaPlan | null>;
}

interface KimiSourceOptions {
  credential: () => Promise<string | null>;
  fetcher?: typeof fetch;
  now?: () => number;
}

interface KimiUsageValue {
  limit?: unknown;
  used?: unknown;
  remaining?: unknown;
  resetTime?: unknown;
}
interface KimiUsageWindow {
  limit?: unknown;
  used?: unknown;
  remaining?: unknown;
  window?: { duration?: unknown; timeUnit?: unknown };
}
interface KimiUsagesResponse {
  usage?: KimiUsageValue;
  limits?: KimiUsageWindow[];
  totalQuota?: unknown;
}

const toCount = (value: unknown): number | null => {
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return value;
  return null;
};

/** 把 Kimi usages 响应解析成配额计划；结构不符时抛错。 */
export function parseKimiUsages(value: unknown, asOf: string): QuotaPlan {
  if (!value || typeof value !== "object")
    throw new Error("Kimi 配额响应格式无效");
  const body = value as KimiUsagesResponse;
  if (!body.usage || typeof body.usage !== "object")
    throw new Error("Kimi 配额响应缺少 usage 字段");
  const usageLimit = toCount(body.usage.limit);
  const usageUsed = toCount(body.usage.used);
  if (usageLimit === null || usageUsed === null)
    throw new Error("Kimi 配额响应 usage 字段无效");
  const windows: QuotaWindow[] = [];
  windows.push({
    id: "weekly",
    label: "本周",
    kind: "weekly",
    unit: "次",
    used: usageUsed,
    limit: usageLimit,
    remaining: Math.max(0, usageLimit - usageUsed),
    resetTime:
      typeof body.usage.resetTime === "string" &&
      Number.isFinite(Date.parse(body.usage.resetTime))
        ? new Date(body.usage.resetTime).toISOString()
        : null,
    asOf,
  });
  const limits = Array.isArray(body.limits) ? body.limits : [];
  for (const [index, entry] of limits.entries()) {
    if (!entry || typeof entry !== "object" || !entry.window) continue;
    const timeUnit = entry.window.timeUnit;
    const duration = toCount(entry.window.duration);
    if (timeUnit !== "TIME_UNIT_MINUTE" || duration === null) continue;
    const limit = toCount(entry.limit);
    const used = toCount(entry.used);
    if (limit === null || used === null) continue;
    const hours = duration / 60;
    windows.push({
      id: `rolling-${index}`,
      label: hours >= 1 ? `近${hours}小时` : `${duration}分钟滚动`,
      kind: "rolling",
      unit: "次",
      used,
      limit,
      remaining: Math.max(0, limit - used),
      resetTime: null,
      asOf,
    });
  }
  return {
    provider: "kimi",
    planName:
      typeof body.totalQuota === "string" && body.totalQuota.trim()
        ? `Kimi 套餐 · ${body.totalQuota.trim()}`
        : "Kimi 套餐",
    windows,
  };
}

export class KimiQuotaSource implements QuotaSource {
  readonly provider = "kimi";
  private cached: { fetchedAt: number; plan: QuotaPlan } | null = null;
  private credentialFingerprint = "";
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: KimiSourceOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async poll(force = false): Promise<QuotaPlan | null> {
    const key = await this.options.credential();
    if (!key) {
      this.credentialFingerprint = "";
      this.cached = null;
      return null;
    }
    const fingerprint = createHash("sha256").update(key).digest("base64url");
    if (fingerprint !== this.credentialFingerprint) {
      this.credentialFingerprint = fingerprint;
      this.cached = null;
    }
    if (!force && this.cached && this.now() - this.cached.fetchedAt < CACHE_MS)
      return this.cached.plan;
    const response = await this.fetcher(KIMI_USAGES_ENDPOINT, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${key}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "Kimi API Key 无效或已失效"
          : `Kimi 配额接口返回 HTTP ${response.status}`,
      );
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
      throw new Error("Kimi 配额响应过大");
    const plan = parseKimiUsages(
      JSON.parse(text) as unknown,
      new Date(this.now()).toISOString(),
    );
    this.cached = { fetchedAt: this.now(), plan };
    return plan;
  }
}

export interface QuotaSourceContext {
  /** 取某 provider 的 API key（明文只进内存，绝不下发）。 */
  credentialFor(provider: string): Promise<string | null>;
}

/** 按 providerBindings 构造活跃配额源；现在只有 kimi。 */
export function quotaSourcesFor(
  settings: BillingSettings,
  context: QuotaSourceContext,
): QuotaSource[] {
  const bound = new Set(
    settings.providerBindings.map((binding) => binding.provider.toLowerCase()),
  );
  const sources: QuotaSource[] = [];
  if (bound.has("kimi"))
    sources.push(
      new KimiQuotaSource({
        credential: async () => context.credentialFor("kimi"),
      }),
    );
  return sources;
}
