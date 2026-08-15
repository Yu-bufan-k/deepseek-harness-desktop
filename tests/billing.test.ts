import { describe, expect, it, vi } from "vitest";
import {
  billingMinuteAt, calculateBillingCost, isBillingPeakWindow, selectBillingRule, summarizeBillingUsage,
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
  }, customRules: []
};
const sample = (iso: string): BillingUsageSample => ({ provider: "deepseek-official", model: "deepseek-v4-flash", time: Date.parse(iso), uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000 });
const amount = (line: ReturnType<typeof calculateBillingCost>) => Number(BigInt(line.amountNanos!)) / 1e9;

describe("billing engine", () => {
  it("compares numeric peak windows, including midnight", () => {
    expect(isBillingPeakWindow(23 * 60 + 30, 22 * 60, 2 * 60)).toBe(true);
    expect(isBillingPeakWindow(90, 22 * 60, 2 * 60)).toBe(true);
    expect(isBillingPeakWindow(12 * 60, 22 * 60, 2 * 60)).toBe(false);
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

  it("adds many tiny costs as integer nanounits", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-18T00:00:00+08:00"));
    const tiny = { ...sample("2026-08-18T08:00:00+08:00"), uncachedInputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 0 };
    const report = summarizeBillingUsage(settings, { collectedAt: new Date().toISOString(), sessions: [{ sessionId: "s", title: "tiny", samples: Array.from({ length: 100_000 }, () => tiny) }] }, new Date().toISOString());
    expect(report.totals).toEqual([{ currency: "CNY", nanos: "5000000" }]);
    expect(report.sessions[0]?.models[0]?.cacheReadTokens).toBe(100_000);
    vi.useRealTimers();
  });
});
