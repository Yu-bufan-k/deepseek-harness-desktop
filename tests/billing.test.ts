import { describe, expect, it, vi } from "vitest";
import {
  billingMinuteAt, billingRuleStatus, BillingUsageSummarizer, calculateBillingCost, formatBillingMoney, isBillingPeakWindow, restoreOfficialBilling, selectBillingRule, summarizeBillingUsage,
  type BillingSettings, type BillingUsageSample
} from "../src/shared/billing.js";

const rates = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({ input, cacheRead, cacheWrite, output });
const settings: BillingSettings = {
  autoUpdate: true, checkIntervalHours: 24, lastCheckedAt: null,
  catalog: {
    schemaVersion: 2, publishedAt: "2026-08-14T00:00:00Z", source: "test",
    peakSchedules: [{ id: "cn", label: "CN", timezone: "Asia/Shanghai", windows: [{ startMinute: 540, endMinute: 720 }, { startMinute: 1320, endMinute: 120 }] }],
    rules: [{
      id: "official", provider: "deepseek-official", model: "deepseek-v4-flash", label: "official", currency: "CNY", mode: "official",
      effectiveFrom: "2026-08-17T00:00:00+08:00", effectiveTo: "2027-01-01T00:00:00+08:00",
      rates: rates(1.5, 0.05, 0.2, 4.5), peakRates: rates(3, 0.1, 0.4, 9), peakScheduleId: "cn"
    }]
  }, customRules: [], providerBindings: [], balanceWarning: { enabled: false, thresholds: { CNY: "10", USD: "2" } }
};
const sample = (iso: string): BillingUsageSample => ({ provider: "deepseek-official", model: "deepseek-v4-flash", time: Date.parse(iso), uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000 });
const amount = (line: ReturnType<typeof calculateBillingCost>) => Number(BigInt(line.amountNanos!)) / 1e9;

describe("billing engine", () => {
  it("compares numeric peak windows, including midnight", () => {
    expect(isBillingPeakWindow(23 * 60 + 30, 22 * 60, 2 * 60)).toBe(true);
    expect(isBillingPeakWindow(90, 22 * 60, 2 * 60)).toBe(true);
    expect(isBillingPeakWindow(12 * 60, 22 * 60, 2 * 60)).toBe(false);
    expect(isBillingPeakWindow(120, 120, 120)).toBe(false);
  });

  it("resolves named timezones with numeric parts", () => {
    expect(billingMinuteAt(Date.parse("2026-08-17T01:30:00Z"), "Asia/Shanghai")).toBe(570);
    expect(billingMinuteAt(Date.parse("2026-08-17T01:30:00Z"), "UTC")).toBe(90);
  });

  it("uses all four off-peak and peak rates", () => {
    expect(amount(calculateBillingCost(settings, sample("2026-08-17T08:00:00+08:00")))).toBe(6.25);
    expect(amount(calculateBillingCost(settings, sample("2026-08-17T09:30:00+08:00")))).toBe(12.5);
  });

  it("does not price third-party routes or requests after effectiveTo", () => {
    expect(selectBillingRule(settings, { ...sample("2026-08-17T09:30:00+08:00"), provider: "fireworks" })).toBeNull();
    expect(selectBillingRule(settings, sample("2027-01-01T00:00:00+08:00"))).toBeNull();
  });

  it("lets an active custom rule override an official version", () => {
    const custom = { ...settings.catalog.rules[0]!, id: "custom", mode: "custom" as const, effectiveFrom: "2026-08-16T00:00:00+08:00", effectiveTo: "2026-08-20T00:00:00+08:00", rates: rates(1, 0, 2, 1), peakRates: undefined, peakScheduleId: undefined };
    expect(selectBillingRule({ ...settings, customRules: [custom] }, sample("2026-08-18T10:00:00+08:00"))?.id).toBe("custom");
    expect(selectBillingRule({ ...settings, customRules: [custom] }, sample("2026-08-21T10:00:00+08:00"))?.id).toBe("official");
  });

  it("binds a custom route to official pricing and restores without rewriting history", () => {
    const bound = { ...settings, providerBindings: [{ provider: "my-deepseek", catalogProvider: "deepseek-official" }] };
    const routed = { ...sample("2026-08-18T10:00:00+08:00"), provider: "my-deepseek" };
    expect(selectBillingRule(bound, routed)?.mode).toBe("official");
    const custom = { ...settings.catalog.rules[0]!, id: "custom-route", provider: "my-deepseek", mode: "custom" as const, effectiveFrom: "2026-08-18T00:00:00+08:00", effectiveTo: undefined, peakRates: undefined, peakScheduleId: undefined };
    const restored = restoreOfficialBilling({ ...bound, customRules: [custom] }, "my-deepseek", custom.model, Date.parse("2026-08-19T00:00:00+08:00"));
    expect(restored.customRules[0]?.effectiveTo).toBe("2026-08-18T16:00:00.000Z");
    expect(selectBillingRule(restored, { ...routed, time: Date.parse("2026-08-18T12:00:00+08:00") })?.id).toBe("custom-route");
    expect(selectBillingRule(restored, { ...routed, time: Date.parse("2026-08-19T00:01:00+08:00") })?.mode).toBe("official");
  });

  it("derives rule status from the same selector used for pricing", () => {
    const custom = { ...settings.catalog.rules[0]!, id: "custom", mode: "custom" as const, effectiveFrom: "2026-08-16T00:00:00+08:00", effectiveTo: "2026-08-20T00:00:00+08:00", peakRates: undefined, peakScheduleId: undefined };
    const overridden = { ...settings, customRules: [custom] };
    expect(billingRuleStatus(settings, settings.catalog.rules[0]!, Date.parse("2026-08-16T00:00:00+08:00"))).toBe("future");
    expect(billingRuleStatus(overridden, settings.catalog.rules[0]!, Date.parse("2026-08-18T00:00:00+08:00"))).toBe("overridden");
    expect(billingRuleStatus(overridden, custom, Date.parse("2026-08-18T00:00:00+08:00"))).toBe("active");
    expect(billingRuleStatus(overridden, custom, Date.parse("2026-08-21T00:00:00+08:00"))).toBe("expired");
    expect(billingRuleStatus(settings, settings.catalog.rules[0]!, Date.parse("2027-01-01T00:00:00+08:00"))).toBe("expired");
    const historical = { ...settings.catalog.rules[0]!, id: "historical", effectiveFrom: "2026-01-01T00:00:00+08:00", effectiveTo: undefined };
    expect(billingRuleStatus({ ...settings, catalog: { ...settings.catalog, rules: [historical, settings.catalog.rules[0]!] } }, historical, Date.parse("2026-08-18T00:00:00+08:00"))).toBe("historical");
  });

  it("formats amounts above Number.MAX_SAFE_INTEGER without floating-point conversion", () => {
    expect(formatBillingMoney("CNY", "9007199254740993")).toBe("¥9,007,199.254741");
    expect(formatBillingMoney("CNY", "5000000")).toBe("¥0.0050");
  });

  it("adds many tiny costs as integer nanounits", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-18T00:00:00+08:00"));
    const tiny = { ...sample("2026-08-18T08:00:00+08:00"), uncachedInputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 0 };
    const report = summarizeBillingUsage(settings, { collectedAt: new Date().toISOString(), sessions: [{ sessionId: "s", title: "tiny", revision: "1", samples: Array.from({ length: 100_000 }, () => tiny) }] }, new Date().toISOString());
    expect(report.totals).toEqual([{ currency: "CNY", nanos: "5000000", display: "¥0.0050" }]);
    expect(report.sessions[0]?.models[0]?.cacheReadTokens).toBe(100_000);
    vi.useRealTimers();
  });

  it("reuses unchanged session summaries and invalidates only changed sessions", () => {
    const summarizer = new BillingUsageSummarizer();
    const first = { sessionId: "one", title: "One", revision: "1", samples: [sample("2026-08-18T08:00:00+08:00")] };
    const second = { sessionId: "two", title: "Two", revision: "1", samples: [sample("2026-08-18T08:00:00+08:00")] };
    const index = { collectedAt: "2026-08-18T00:00:00Z", sessions: [first, second] };
    summarizer.summarize(settings, index, "2026-08-18T00:00:00Z");
    expect(summarizer.cacheStats()).toEqual({ hits: 0, misses: 2, sessions: 2 });
    summarizer.summarize(settings, { ...index, collectedAt: "2026-08-18T00:01:00Z" }, "2026-08-18T00:01:00Z");
    expect(summarizer.cacheStats()).toEqual({ hits: 2, misses: 2, sessions: 2 });
    summarizer.summarize(settings, { ...index, sessions: [{ ...first, revision: "2", samples: [...first.samples, sample("2026-08-18T08:01:00+08:00")] }, second] }, "2026-08-18T00:02:00Z");
    expect(summarizer.cacheStats()).toEqual({ hits: 3, misses: 3, sessions: 2 });
    summarizer.summarize({ ...settings, customRules: [{ ...settings.catalog.rules[0]!, id: "free", mode: "free", peakRates: undefined, peakScheduleId: undefined }] }, index, "2026-08-18T00:03:00Z");
    expect(summarizer.cacheStats()).toEqual({ hits: 3, misses: 5, sessions: 2 });
  });
});
