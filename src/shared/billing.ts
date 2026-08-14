export type BillingPriceMode = "official" | "custom" | "free";

export interface BillingRates {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface BillingPriceRule {
  id: string;
  provider: string;
  model: string;
  label: string;
  currency: string;
  mode: BillingPriceMode;
  effectiveFrom: string;
  rates: BillingRates;
  peakRates?: BillingRates;
  peakWindows?: Array<{ start: string; end: string }>;
  source?: string;
}

export interface BillingCatalog {
  schemaVersion: 1;
  publishedAt: string;
  source: string;
  rules: BillingPriceRule[];
}

export interface BillingSettings {
  autoUpdate: boolean;
  checkIntervalHours: number;
  lastCheckedAt: string | null;
  catalog: BillingCatalog;
  customRules: BillingPriceRule[];
}

export interface BillingUpdateResult {
  updated: boolean;
  checkedAt: string;
  settings: BillingSettings;
  message: string;
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

export interface BillingSessionUsage {
  sessionId: string;
  title: string;
  samples: BillingUsageSample[];
}

export interface BillingUsageIndex {
  updatedAt: string;
  sessions: BillingSessionUsage[];
}

export interface BillingCostLine extends BillingUsageSample {
  ruleId: string | null;
  currency: string | null;
  amount: number | null;
}

const normalize = (value: string): string => value.trim().toLowerCase();

export function isBillingPeakWindow(clock: string, start: string, end: string): boolean {
  return start < end ? clock >= start && clock < end : clock >= start || clock < end;
}

export function selectBillingRule(settings: BillingSettings, sample: BillingUsageSample): BillingPriceRule | null {
  const provider = normalize(sample.provider);
  const model = normalize(sample.model);
  const candidates = [...settings.catalog.rules, ...settings.customRules]
    .filter((rule) => normalize(rule.provider) === provider && normalize(rule.model) === model)
    .filter((rule) => Date.parse(rule.effectiveFrom) <= sample.time)
    .sort((left, right) => {
      const customDifference = Number(right.mode === "custom" || right.mode === "free") - Number(left.mode === "custom" || left.mode === "free");
      if (customDifference !== 0) return customDifference;
      return Date.parse(right.effectiveFrom) - Date.parse(left.effectiveFrom);
    });
  return candidates[0] ?? null;
}

export function calculateBillingCost(settings: BillingSettings, sample: BillingUsageSample): BillingCostLine {
  const rule = selectBillingRule(settings, sample);
  if (!rule) return { ...sample, ruleId: null, currency: null, amount: null };
  const chinaTime = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(sample.time);
  const rates = rule.peakRates && rule.peakWindows?.some(({ start, end }) => isBillingPeakWindow(chinaTime, start, end))
    ? rule.peakRates
    : rule.rates;
  const amount = rule.mode === "free" ? 0 : (
    sample.uncachedInputTokens * rates.input
    + sample.cacheReadTokens * rates.cacheRead
    + sample.cacheWriteTokens * rates.cacheWrite
    + sample.outputTokens * rates.output
  ) / 1_000_000;
  return { ...sample, ruleId: rule.id, currency: rule.currency, amount };
}
