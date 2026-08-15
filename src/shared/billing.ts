export type BillingPriceMode = "official" | "custom" | "free";

export interface BillingRates {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface BillingPeakWindow { startMinute: number; endMinute: number; }
export interface BillingPeakSchedule { id: string; label: string; timezone: string; windows: BillingPeakWindow[]; }

export interface BillingPriceRule {
  id: string;
  provider: string;
  model: string;
  label: string;
  currency: string;
  mode: BillingPriceMode;
  effectiveFrom: string;
  effectiveTo?: string;
  rates: BillingRates;
  peakRates?: BillingRates;
  peakScheduleId?: string;
  source?: string;
}

export interface BillingCatalog {
  schemaVersion: 2;
  publishedAt: string;
  source: string;
  peakSchedules: BillingPeakSchedule[];
  rules: BillingPriceRule[];
}

export interface BillingSettings {
  autoUpdate: boolean;
  checkIntervalHours: number;
  lastCheckedAt: string | null;
  catalog: BillingCatalog;
  customRules: BillingPriceRule[];
}

export interface BillingUpdateResult { updated: boolean; checkedAt: string; settings: BillingSettings; message: string; }

export interface BillingUsageSample {
  provider: string;
  model: string;
  time: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface BillingSessionUsage { sessionId: string; title: string; samples: BillingUsageSample[]; }
export interface BillingUsageIndex { collectedAt: string; sessions: BillingSessionUsage[]; }
export interface BillingMoney { currency: string; /** Integer nanounits for exact IPC-safe addition. */ nanos: string; }

export interface BillingCostLine extends BillingUsageSample {
  ruleId: string | null;
  currency: string | null;
  amountNanos: string | null;
}

export interface BillingResolvedPrice {
  rule: BillingPriceRule;
  rates: BillingRates;
  isPeak: boolean;
  scheduleLabel: string | null;
  timezone: string | null;
}

export interface BillingModelUsageSummary {
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  unpricedRequests: number;
  totals: BillingMoney[];
  currentPricing: BillingResolvedPrice | null;
}

export interface BillingSessionUsageSummary {
  sessionId: string;
  title: string;
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  unpricedRequests: number;
  lastUsageAt: string | null;
  totals: BillingMoney[];
  models: BillingModelUsageSummary[];
}

export interface BillingUsageReport {
  syncedAt: string;
  collectedAt: string;
  lastUsageAt: string | null;
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  unpricedRequests: number;
  totals: BillingMoney[];
  sessions: BillingSessionUsageSummary[];
  currentTarget: { provider: string; model: string; pricing: BillingResolvedPrice | null } | null;
  warnings: string[];
}

const normalize = (value: string): string => value.trim().toLowerCase();
const billingFormatters = new Map<string, Intl.DateTimeFormat>();

export function isBillingPeakWindow(minute: number, startMinute: number, endMinute: number): boolean {
  if (startMinute === endMinute) return true;
  return startMinute < endMinute ? minute >= startMinute && minute < endMinute : minute >= startMinute || minute < endMinute;
}

export function billingMinuteAt(time: number, timezone: string): number {
  let formatter = billingFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    billingFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(time);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error(`无法解析计费时区：${timezone}`);
  return hour * 60 + minute;
}

export function selectBillingRule(settings: BillingSettings, sample: BillingUsageSample): BillingPriceRule | null {
  const provider = normalize(sample.provider), model = normalize(sample.model);
  const candidates = [...settings.catalog.rules, ...settings.customRules]
    .filter((rule) => normalize(rule.provider) === provider && normalize(rule.model) === model)
    .filter((rule) => Date.parse(rule.effectiveFrom) <= sample.time)
    .filter((rule) => rule.effectiveTo === undefined || sample.time < Date.parse(rule.effectiveTo))
    .sort((left, right) => {
      const customDifference = Number(right.mode === "custom" || right.mode === "free") - Number(left.mode === "custom" || left.mode === "free");
      if (customDifference !== 0) return customDifference;
      return Date.parse(right.effectiveFrom) - Date.parse(left.effectiveFrom) || right.id.localeCompare(left.id);
    });
  return candidates[0] ?? null;
}

function decimalToScaledInteger(value: number, scale: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new Error("计费单价必须是非负有限数值");
  const [coefficient, exponentText = "0"] = String(value).toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [whole, fraction = ""] = coefficient!.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  const shift = scale - (fraction.length - exponent);
  if (shift >= 0) return BigInt(digits) * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift), integer = BigInt(digits);
  return integer / divisor + (integer % divisor * 2n >= divisor ? 1n : 0n);
}

const scaledRateCache = new WeakMap<BillingRates, { input: bigint; cacheRead: bigint; cacheWrite: bigint; output: bigint }>();
function scaledRates(rates: BillingRates) {
  let scaled = scaledRateCache.get(rates);
  if (!scaled) {
    scaled = {
      input: decimalToScaledInteger(rates.input, 9), cacheRead: decimalToScaledInteger(rates.cacheRead, 9),
      cacheWrite: decimalToScaledInteger(rates.cacheWrite, 9), output: decimalToScaledInteger(rates.output, 9)
    };
    scaledRateCache.set(rates, scaled);
  }
  return scaled;
}

function resolveRates(settings: BillingSettings, rule: BillingPriceRule, time: number): Omit<BillingResolvedPrice, "rule"> {
  if (!rule.peakRates || !rule.peakScheduleId) return { rates: rule.rates, isPeak: false, scheduleLabel: null, timezone: null };
  const schedule = settings.catalog.peakSchedules.find((entry) => entry.id === rule.peakScheduleId);
  if (!schedule) return { rates: rule.rates, isPeak: false, scheduleLabel: null, timezone: null };
  const minute = billingMinuteAt(time, schedule.timezone);
  const isPeak = schedule.windows.some((window) => isBillingPeakWindow(minute, window.startMinute, window.endMinute));
  return { rates: isPeak ? rule.peakRates : rule.rates, isPeak, scheduleLabel: schedule.label, timezone: schedule.timezone };
}

export function resolveBillingPrice(settings: BillingSettings, provider: string, model: string, time: number): BillingResolvedPrice | null {
  const rule = selectBillingRule(settings, { provider, model, time, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  return rule ? { rule, ...resolveRates(settings, rule, time) } : null;
}

export function calculateBillingCost(settings: BillingSettings, sample: BillingUsageSample): BillingCostLine {
  const rule = selectBillingRule(settings, sample);
  if (!rule) return { ...sample, ruleId: null, currency: null, amountNanos: null };
  if (rule.mode === "free") return { ...sample, ruleId: rule.id, currency: rule.currency, amountNanos: "0" };
  const rates = resolveRates(settings, rule, sample.time).rates;
  const scaled = scaledRates(rates);
  const numerator = BigInt(sample.uncachedInputTokens) * scaled.input + BigInt(sample.cacheReadTokens) * scaled.cacheRead
    + BigInt(sample.cacheWriteTokens) * scaled.cacheWrite + BigInt(sample.outputTokens) * scaled.output;
  const million = 1_000_000n;
  const amountNanos = numerator / million + (numerator % million * 2n >= million ? 1n : 0n);
  return { ...sample, ruleId: rule.id, currency: rule.currency, amountNanos: amountNanos.toString() };
}

function addMoney(target: Map<string, bigint>, currency: string, nanos: string): void {
  target.set(currency, (target.get(currency) ?? 0n) + BigInt(nanos));
}
const moneyList = (totals: Map<string, bigint>): BillingMoney[] => [...totals].sort(([left], [right]) => left.localeCompare(right)).map(([currency, nanos]) => ({ currency, nanos: nanos.toString() }));
export function summarizeBillingUsage(settings: BillingSettings, index: BillingUsageIndex, syncedAt: string, currentTarget?: { provider: string; model: string }, warnings: string[] = []): BillingUsageReport {
  const totals = new Map<string, bigint>();
  let requests = 0, inputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, outputTokens = 0, unpricedRequests = 0, latestTime = 0;
  const sessions = index.sessions.map((session): BillingSessionUsageSummary => {
    const sessionTotals = new Map<string, bigint>();
    const models = new Map<string, { summary: Omit<BillingModelUsageSummary, "totals" | "currentPricing">; totals: Map<string, bigint> }>();
    let sessionInput = 0, sessionCacheRead = 0, sessionCacheWrite = 0, sessionOutput = 0, sessionUnpriced = 0, sessionLatest = 0;
    for (const sample of session.samples) {
      requests += 1; sessionLatest = Math.max(sessionLatest, sample.time); latestTime = Math.max(latestTime, sample.time);
      sessionInput += sample.uncachedInputTokens; inputTokens += sample.uncachedInputTokens;
      sessionCacheRead += sample.cacheReadTokens; cacheReadTokens += sample.cacheReadTokens;
      sessionCacheWrite += sample.cacheWriteTokens; cacheWriteTokens += sample.cacheWriteTokens;
      sessionOutput += sample.outputTokens; outputTokens += sample.outputTokens;
      const key = JSON.stringify([normalize(sample.provider), normalize(sample.model)]);
      let model = models.get(key);
      if (!model) {
        model = { summary: { provider: sample.provider, model: sample.model, requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, unpricedRequests: 0 }, totals: new Map() };
        models.set(key, model);
      }
      model.summary.requests += 1; model.summary.inputTokens += sample.uncachedInputTokens; model.summary.cacheReadTokens += sample.cacheReadTokens;
      model.summary.cacheWriteTokens += sample.cacheWriteTokens; model.summary.outputTokens += sample.outputTokens;
      const line = calculateBillingCost(settings, sample);
      if (line.amountNanos === null || line.currency === null) { unpricedRequests += 1; sessionUnpriced += 1; model.summary.unpricedRequests += 1; }
      else { addMoney(totals, line.currency, line.amountNanos); addMoney(sessionTotals, line.currency, line.amountNanos); addMoney(model.totals, line.currency, line.amountNanos); }
    }
    return {
      sessionId: session.sessionId, title: session.title, requests: session.samples.length, inputTokens: sessionInput, cacheReadTokens: sessionCacheRead,
      cacheWriteTokens: sessionCacheWrite, outputTokens: sessionOutput, unpricedRequests: sessionUnpriced,
      lastUsageAt: sessionLatest ? new Date(sessionLatest).toISOString() : null, totals: moneyList(sessionTotals),
      models: [...models.values()].map(({ summary, totals: modelTotals }) => ({ ...summary, totals: moneyList(modelTotals), currentPricing: resolveBillingPrice(settings, summary.provider, summary.model, Date.now()) }))
    };
  });
  return {
    syncedAt, collectedAt: index.collectedAt, lastUsageAt: latestTime ? new Date(latestTime).toISOString() : null, requests, inputTokens, cacheReadTokens,
    cacheWriteTokens, outputTokens, unpricedRequests, totals: moneyList(totals), sessions,
    currentTarget: currentTarget ? { ...currentTarget, pricing: resolveBillingPrice(settings, currentTarget.provider, currentTarget.model, Date.now()) } : null,
    warnings: [...warnings]
  };
}
