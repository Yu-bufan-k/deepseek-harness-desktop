export type BillingPriceMode = "official" | "custom" | "free";

export interface BillingRates {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface BillingPeakWindow {
  startMinute: number;
  endMinute: number;
}
export interface BillingPeakSchedule {
  id: string;
  label: string;
  timezone: string;
  windows: BillingPeakWindow[];
}

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

export interface BillingProviderBinding {
  /** Harness provider route chosen by the user. */
  provider: string;
  /** Provider id used by the signed price catalog. */
  catalogProvider: string;
}

export interface BillingBalanceWarningSettings {
  enabled: boolean;
  thresholds: Record<"CNY" | "USD", string>;
}

export interface BillingSettings {
  autoUpdate: boolean;
  checkIntervalHours: number;
  lastCheckedAt: string | null;
  catalog: BillingCatalog;
  customRules: BillingPriceRule[];
  providerBindings: BillingProviderBinding[];
  balanceWarning: BillingBalanceWarningSettings;
}

export interface BillingUpdateResult {
  updated: boolean;
  checkedAt: string;
  settings: BillingSettings;
  message: string;
  errorSummary?: string;
}
export type BillingRuleStatus =
  "future" | "active" | "overridden" | "expired" | "historical";
export interface BillingSettingsSnapshot extends BillingSettings {
  ruleStatuses: Record<string, BillingRuleStatus>;
}

export interface BillingUsageSample {
  provider: string;
  model: string;
  time: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface BillingModelBucket {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface BillingUsageSeriesBucket {
  /** 本机时区对齐的小时起始（毫秒时间戳）。 */
  hourStart: number;
  requests: number;
  /** key = JSON.stringify([normalize(provider), normalize(model)])。 */
  models: Record<string, BillingModelBucket>;
  /** currency → nanos，整数纳单位，与 BillingMoney 一致。 */
  cost: Record<string, string>;
}

export interface BillingSessionUsage {
  sessionId: string;
  title: string;
  revision: string;
  samples: BillingUsageSample[];
}
export interface BillingUsageIndex {
  collectedAt: string;
  sessions: BillingSessionUsage[];
}
export interface BillingUsageSync {
  collectedAt: string;
  sessionIds: string[];
  sessions: BillingSessionUsage[];
  droppedSessions?: number;
}
export interface BillingMoney {
  currency: string;
  /** Integer nanounits for exact IPC-safe addition. */ nanos: string;
  /** Locale-formatted without floating-point conversion. */ display: string;
}

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
  officialPricing: BillingResolvedPrice | null;
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
  /** 全部时间范围内的稀疏小时桶，按 hourStart 升序。 */
  series: BillingUsageSeriesBucket[];
  /** sessionId → 该会话触碰过的小时桶集合（升序去重）。 */
  sessionHours: Record<string, number[]>;
  currentTarget: {
    provider: string;
    model: string;
    pricing: BillingResolvedPrice | null;
    officialPricing: BillingResolvedPrice | null;
  } | null;
  warnings: string[];
}

const normalize = (value: string): string => value.trim().toLowerCase();
const billingFormatters = new Map<string, Intl.DateTimeFormat>();

export function isBillingPeakWindow(
  minute: number,
  startMinute: number,
  endMinute: number,
): boolean {
  if (startMinute === endMinute) return false;
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

export function billingMinuteAt(time: number, timezone: string): number {
  let formatter = billingFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    billingFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(time);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute))
    throw new Error(`无法解析计费时区：${timezone}`);
  return hour * 60 + minute;
}

export function selectBillingRule(
  settings: BillingSettings,
  sample: BillingUsageSample,
): BillingPriceRule | null {
  const provider = normalize(sample.provider),
    model = normalize(sample.model);
  const catalogProvider = normalize(
    settings.providerBindings?.find(
      (binding) => normalize(binding.provider) === provider,
    )?.catalogProvider ?? sample.provider,
  );
  const candidates = [
    ...settings.catalog.rules.filter(
      (rule) => normalize(rule.provider) === catalogProvider,
    ),
    ...settings.customRules.filter(
      (rule) => normalize(rule.provider) === provider,
    ),
  ]
    .filter((rule) => normalize(rule.model) === model)
    .filter((rule) => Date.parse(rule.effectiveFrom) <= sample.time)
    .filter(
      (rule) =>
        rule.effectiveTo === undefined ||
        sample.time < Date.parse(rule.effectiveTo),
    )
    .sort((left, right) => {
      const customDifference =
        Number(right.mode === "custom" || right.mode === "free") -
        Number(left.mode === "custom" || left.mode === "free");
      if (customDifference !== 0) return customDifference;
      return (
        Date.parse(right.effectiveFrom) - Date.parse(left.effectiveFrom) ||
        right.id.localeCompare(left.id)
      );
    });
  return candidates[0] ?? null;
}

export function officialBillingRule(
  settings: BillingSettings,
  provider: string,
  model: string,
  at = Date.now(),
): BillingPriceRule | null {
  const normalizedProvider = normalize(provider),
    normalizedModel = normalize(model);
  const catalogProvider = normalize(
    settings.providerBindings?.find(
      (binding) => normalize(binding.provider) === normalizedProvider,
    )?.catalogProvider ?? provider,
  );
  return (
    settings.catalog.rules
      .filter(
        (rule) =>
          normalize(rule.provider) === catalogProvider &&
          normalize(rule.model) === normalizedModel,
      )
      .filter(
        (rule) =>
          Date.parse(rule.effectiveFrom) <= at &&
          (rule.effectiveTo === undefined || at < Date.parse(rule.effectiveTo)),
      )
      .sort(
        (left, right) =>
          Date.parse(right.effectiveFrom) - Date.parse(left.effectiveFrom) ||
          right.id.localeCompare(left.id),
      )[0] ?? null
  );
}

export function restoreOfficialBilling(
  settings: BillingSettings,
  provider: string,
  model: string,
  at = Date.now(),
): BillingSettings {
  const targetProvider = normalize(provider),
    targetModel = normalize(model);
  const effectiveTo = new Date(at).toISOString();
  const customRules = settings.customRules.flatMap((rule) => {
    if (
      normalize(rule.provider) !== targetProvider ||
      normalize(rule.model) !== targetModel ||
      (rule.effectiveTo && Date.parse(rule.effectiveTo) <= at)
    )
      return [rule];
    if (Date.parse(rule.effectiveFrom) >= at) return [];
    return [{ ...rule, effectiveTo }];
  });
  return { ...settings, customRules };
}

export function billingRuleStatus(
  settings: BillingSettings,
  rule: BillingPriceRule,
  at = Date.now(),
): BillingRuleStatus {
  if (Date.parse(rule.effectiveFrom) > at) return "future";
  if (rule.effectiveTo !== undefined && Date.parse(rule.effectiveTo) <= at)
    return "expired";
  const selected = selectBillingRule(settings, {
    provider: rule.provider,
    model: rule.model,
    time: at,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  });
  if (selected?.id === rule.id) return "active";
  if (selected && (selected.mode === "custom" || selected.mode === "free"))
    return "overridden";
  return "historical";
}

export function billingSettingsSnapshot(
  settings: BillingSettings,
  at = Date.now(),
): BillingSettingsSnapshot {
  return {
    ...settings,
    ruleStatuses: Object.fromEntries(
      [...settings.catalog.rules, ...settings.customRules].map((rule) => [
        rule.id,
        billingRuleStatus(settings, rule, at),
      ]),
    ),
  };
}

function decimalToScaledInteger(value: number, scale: number): bigint {
  if (!Number.isFinite(value) || value < 0)
    throw new Error("计费单价必须是非负有限数值");
  const [coefficient, exponentText = "0"] = String(value)
    .toLowerCase()
    .split("e");
  const exponent = Number(exponentText);
  const [whole, fraction = ""] = coefficient!.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  const shift = scale - (fraction.length - exponent);
  if (shift >= 0) return BigInt(digits) * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift),
    integer = BigInt(digits);
  return integer / divisor + ((integer % divisor) * 2n >= divisor ? 1n : 0n);
}

const scaledRateCache = new WeakMap<
  BillingRates,
  { input: bigint; cacheRead: bigint; cacheWrite: bigint; output: bigint }
>();
function scaledRates(rates: BillingRates) {
  let scaled = scaledRateCache.get(rates);
  if (!scaled) {
    scaled = {
      input: decimalToScaledInteger(rates.input, 9),
      cacheRead: decimalToScaledInteger(rates.cacheRead, 9),
      cacheWrite: decimalToScaledInteger(rates.cacheWrite, 9),
      output: decimalToScaledInteger(rates.output, 9),
    };
    scaledRateCache.set(rates, scaled);
  }
  return scaled;
}

function resolveRates(
  settings: BillingSettings,
  rule: BillingPriceRule,
  time: number,
): Omit<BillingResolvedPrice, "rule"> {
  if (!rule.peakRates || !rule.peakScheduleId)
    return {
      rates: rule.rates,
      isPeak: false,
      scheduleLabel: null,
      timezone: null,
    };
  const schedule = settings.catalog.peakSchedules.find(
    (entry) => entry.id === rule.peakScheduleId,
  );
  if (!schedule)
    return {
      rates: rule.rates,
      isPeak: false,
      scheduleLabel: null,
      timezone: null,
    };
  const minute = billingMinuteAt(time, schedule.timezone);
  const isPeak = schedule.windows.some((window) =>
    isBillingPeakWindow(minute, window.startMinute, window.endMinute),
  );
  return {
    rates: isPeak ? rule.peakRates : rule.rates,
    isPeak,
    scheduleLabel: schedule.label,
    timezone: schedule.timezone,
  };
}

export function resolveBillingPrice(
  settings: BillingSettings,
  provider: string,
  model: string,
  time: number,
): BillingResolvedPrice | null {
  const rule = selectBillingRule(settings, {
    provider,
    model,
    time,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  });
  return rule ? { rule, ...resolveRates(settings, rule, time) } : null;
}

export function resolveOfficialBillingPrice(
  settings: BillingSettings,
  provider: string,
  model: string,
  time: number,
): BillingResolvedPrice | null {
  const rule = officialBillingRule(settings, provider, model, time);
  return rule ? { rule, ...resolveRates(settings, rule, time) } : null;
}

export function calculateBillingCost(
  settings: BillingSettings,
  sample: BillingUsageSample,
): BillingCostLine {
  const rule = selectBillingRule(settings, sample);
  if (!rule)
    return { ...sample, ruleId: null, currency: null, amountNanos: null };
  if (rule.mode === "free")
    return {
      ...sample,
      ruleId: rule.id,
      currency: rule.currency,
      amountNanos: "0",
    };
  const rates = resolveRates(settings, rule, sample.time).rates;
  const scaled = scaledRates(rates);
  const numerator =
    BigInt(sample.uncachedInputTokens) * scaled.input +
    BigInt(sample.cacheReadTokens) * scaled.cacheRead +
    BigInt(sample.cacheWriteTokens) * scaled.cacheWrite +
    BigInt(sample.outputTokens) * scaled.output;
  const million = 1_000_000n;
  const amountNanos =
    numerator / million + ((numerator % million) * 2n >= million ? 1n : 0n);
  return {
    ...sample,
    ruleId: rule.id,
    currency: rule.currency,
    amountNanos: amountNanos.toString(),
  };
}

function addMoney(
  target: Map<string, bigint>,
  currency: string,
  nanos: string,
): void {
  target.set(currency, (target.get(currency) ?? 0n) + BigInt(nanos));
}

export function formatBillingMoney(
  currency: string,
  nanosValue: string,
  locale = "zh-CN",
): string {
  const nanos = BigInt(nanosValue);
  if (nanos < 0n) throw new Error("计费金额不能为负数");
  const roundedMicros = (nanos + 500n) / 1_000n;
  const whole = roundedMicros / 1_000_000n;
  let fraction = (roundedMicros % 1_000_000n).toString().padStart(6, "0");
  const minimumDigits = nanos < 10_000_000n ? 4 : 2;
  while (fraction.length > minimumDigits && fraction.endsWith("0"))
    fraction = fraction.slice(0, -1);
  const groupedWhole = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(whole);
  const decimal =
    new Intl.NumberFormat(locale, { minimumFractionDigits: 1 })
      .formatToParts(0)
      .find((part) => part.type === "decimal")?.value ?? ".";
  const number = `${groupedWhole}${fraction ? decimal + fraction : ""}`;
  let inserted = false;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
    .formatToParts(0n)
    .map((part) => {
      if (["integer", "group", "decimal", "fraction"].includes(part.type)) {
        if (inserted) return "";
        inserted = true;
        return number;
      }
      return part.value;
    })
    .join("");
}

export function decimalBillingAmountToNanos(value: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error("金额格式无效");
  const fraction = match[2] ?? "";
  if (fraction.length > 9) throw new Error("金额最多支持 9 位小数");
  return (
    BigInt(match[1]!) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0") || "0")
  );
}

export function formatDecimalBillingMoney(
  currency: string,
  value: string,
  locale = "zh-CN",
): string {
  return formatBillingMoney(
    currency,
    decimalBillingAmountToNanos(value).toString(),
    locale,
  );
}

const moneyList = (totals: Map<string, bigint>): BillingMoney[] =>
  [...totals]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, nanos]) => ({
      currency,
      nanos: nanos.toString(),
      display: formatBillingMoney(currency, nanos.toString()),
    }));

interface BillingSessionBucketData {
  requests: number;
  models: Map<string, BillingModelBucket>;
  cost: Map<string, bigint>;
}
interface BillingSessionSeriesData {
  summary: BillingSessionUsageSummary;
  hours: number[];
  buckets: Map<number, BillingSessionBucketData>;
}

export function localHourStart(time: number): number {
  const date = new Date(time);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
  ).getTime();
}

function summarizeSession(
  settings: BillingSettings,
  session: BillingSessionUsage,
): BillingSessionSeriesData {
  const sessionTotals = new Map<string, bigint>();
  const models = new Map<
    string,
    {
      summary: Omit<
        BillingModelUsageSummary,
        "totals" | "currentPricing" | "officialPricing"
      >;
      totals: Map<string, bigint>;
    }
  >();
  const hourSet = new Set<number>();
  const buckets = new Map<number, BillingSessionBucketData>();
  let inputTokens = 0,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    outputTokens = 0,
    unpricedRequests = 0,
    latestTime = 0;
  for (const sample of session.samples) {
    latestTime = Math.max(latestTime, sample.time);
    inputTokens += sample.uncachedInputTokens;
    cacheReadTokens += sample.cacheReadTokens;
    cacheWriteTokens += sample.cacheWriteTokens;
    outputTokens += sample.outputTokens;
    const key = JSON.stringify([
      normalize(sample.provider),
      normalize(sample.model),
    ]);
    const hourStart = localHourStart(sample.time);
    hourSet.add(hourStart);
    let bucket = buckets.get(hourStart);
    if (!bucket) {
      bucket = { requests: 0, models: new Map(), cost: new Map() };
      buckets.set(hourStart, bucket);
    }
    bucket.requests += 1;
    let modelBucket = bucket.models.get(key);
    if (!modelBucket) {
      modelBucket = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      bucket.models.set(key, modelBucket);
    }
    modelBucket.input += sample.uncachedInputTokens;
    modelBucket.cacheRead += sample.cacheReadTokens;
    modelBucket.cacheWrite += sample.cacheWriteTokens;
    modelBucket.output += sample.outputTokens;
    let model = models.get(key);
    if (!model) {
      model = {
        summary: {
          provider: sample.provider,
          model: sample.model,
          requests: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          unpricedRequests: 0,
        },
        totals: new Map(),
      };
      models.set(key, model);
    }
    model.summary.requests += 1;
    model.summary.inputTokens += sample.uncachedInputTokens;
    model.summary.cacheReadTokens += sample.cacheReadTokens;
    model.summary.cacheWriteTokens += sample.cacheWriteTokens;
    model.summary.outputTokens += sample.outputTokens;
    const line = calculateBillingCost(settings, sample);
    if (line.amountNanos === null || line.currency === null) {
      unpricedRequests += 1;
      model.summary.unpricedRequests += 1;
    } else {
      addMoney(sessionTotals, line.currency, line.amountNanos);
      addMoney(model.totals, line.currency, line.amountNanos);
      addMoney(bucket.cost, line.currency, line.amountNanos);
    }
  }
  return {
    summary: {
      sessionId: session.sessionId,
      title: session.title,
      requests: session.samples.length,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      unpricedRequests,
      lastUsageAt: latestTime ? new Date(latestTime).toISOString() : null,
      totals: moneyList(sessionTotals),
      models: [...models.values()].map(({ summary, totals }) => ({
        ...summary,
        totals: moneyList(totals),
        currentPricing: null,
        officialPricing: null,
      })),
    },
    hours: [...hourSet].sort((left, right) => left - right),
    buckets,
  };
}

const settingsCacheKey = (settings: BillingSettings): string =>
  JSON.stringify({
    catalog: settings.catalog,
    customRules: settings.customRules,
    providerBindings: settings.providerBindings,
  });

interface BillingSeriesAggregate {
  requests: number;
  models: Map<string, BillingModelBucket>;
  cost: Map<string, bigint>;
}

export class BillingUsageSummarizer {
  private settingsKey = "";
  private readonly sessionCache = new Map<
    string,
    { revision: string; title: string; series: BillingSessionSeriesData }
  >();
  private hits = 0;
  private misses = 0;

  summarize(
    settings: BillingSettings,
    index: BillingUsageIndex,
    syncedAt: string,
    currentTarget?: { provider: string; model: string },
    warnings: string[] = [],
    at = Date.now(),
  ): BillingUsageReport {
    const nextSettingsKey = settingsCacheKey(settings);
    if (nextSettingsKey !== this.settingsKey) {
      this.settingsKey = nextSettingsKey;
      this.sessionCache.clear();
    }
    const activeIds = new Set(
      index.sessions.map((session) => session.sessionId),
    );
    for (const id of this.sessionCache.keys())
      if (!activeIds.has(id)) this.sessionCache.delete(id);
    const sessionHours: Record<string, number[]> = {};
    const aggregates = new Map<number, BillingSeriesAggregate>();
    const sessions = index.sessions.map((session) => {
      let cached = this.sessionCache.get(session.sessionId);
      if (
        !cached ||
        cached.revision !== session.revision ||
        cached.title !== session.title
      ) {
        cached = {
          revision: session.revision,
          title: session.title,
          series: summarizeSession(settings, session),
        };
        this.sessionCache.set(session.sessionId, cached);
        this.misses += 1;
      } else this.hits += 1;
      sessionHours[session.sessionId] = cached.series.hours;
      for (const [hourStart, bucket] of cached.series.buckets) {
        let aggregate = aggregates.get(hourStart);
        if (!aggregate) {
          aggregate = { requests: 0, models: new Map(), cost: new Map() };
          aggregates.set(hourStart, aggregate);
        }
        aggregate.requests += bucket.requests;
        for (const [modelKey, modelBucket] of bucket.models) {
          const merged = aggregate.models.get(modelKey);
          if (merged) {
            merged.input += modelBucket.input;
            merged.cacheRead += modelBucket.cacheRead;
            merged.cacheWrite += modelBucket.cacheWrite;
            merged.output += modelBucket.output;
          } else aggregate.models.set(modelKey, { ...modelBucket });
        }
        for (const [currency, nanos] of bucket.cost)
          addMoney(aggregate.cost, currency, nanos.toString());
      }
      return {
        ...cached.series.summary,
        models: cached.series.summary.models.map((model) => ({
          ...model,
          currentPricing: resolveBillingPrice(
            settings,
            model.provider,
            model.model,
            at,
          ),
          officialPricing: resolveOfficialBillingPrice(
            settings,
            model.provider,
            model.model,
            at,
          ),
        })),
      };
    });
    const totals = new Map<string, bigint>();
    let requests = 0,
      inputTokens = 0,
      cacheReadTokens = 0,
      cacheWriteTokens = 0,
      outputTokens = 0,
      unpricedRequests = 0,
      latestTime = 0;
    for (const session of sessions) {
      requests += session.requests;
      inputTokens += session.inputTokens;
      cacheReadTokens += session.cacheReadTokens;
      cacheWriteTokens += session.cacheWriteTokens;
      outputTokens += session.outputTokens;
      unpricedRequests += session.unpricedRequests;
      if (session.lastUsageAt)
        latestTime = Math.max(latestTime, Date.parse(session.lastUsageAt));
      for (const total of session.totals)
        addMoney(totals, total.currency, total.nanos);
    }
    const series: BillingUsageSeriesBucket[] = [...aggregates.entries()]
      .sort(([left], [right]) => left - right)
      .map(([hourStart, aggregate]) => ({
        hourStart,
        requests: aggregate.requests,
        models: Object.fromEntries(
          [...aggregate.models.entries()].map(([key, bucket]) => [
            key,
            { ...bucket },
          ]),
        ),
        cost: Object.fromEntries(
          [...aggregate.cost.entries()].map(([currency, nanos]) => [
            currency,
            nanos.toString(),
          ]),
        ),
      }));
    return {
      syncedAt,
      collectedAt: index.collectedAt,
      lastUsageAt: latestTime ? new Date(latestTime).toISOString() : null,
      requests,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      unpricedRequests,
      totals: moneyList(totals),
      sessions,
      series,
      sessionHours,
      currentTarget: currentTarget
        ? {
            ...currentTarget,
            pricing: resolveBillingPrice(
              settings,
              currentTarget.provider,
              currentTarget.model,
              at,
            ),
            officialPricing: resolveOfficialBillingPrice(
              settings,
              currentTarget.provider,
              currentTarget.model,
              at,
            ),
          }
        : null,
      warnings: [...warnings],
    };
  }

  cacheStats(): { hits: number; misses: number; sessions: number } {
    return {
      hits: this.hits,
      misses: this.misses,
      sessions: this.sessionCache.size,
    };
  }
}

export function summarizeBillingUsage(
  settings: BillingSettings,
  index: BillingUsageIndex,
  syncedAt: string,
  currentTarget?: { provider: string; model: string },
  warnings: string[] = [],
  at = Date.now(),
): BillingUsageReport {
  return new BillingUsageSummarizer().summarize(
    settings,
    index,
    syncedAt,
    currentTarget,
    warnings,
    at,
  );
}
