import { describe, expect, it } from "vitest";
import { calculateBillingCost, selectBillingRule, type BillingSettings, type BillingUsageSample } from "../src/shared/billing.js";

const rates = (input: number, cacheRead: number, output: number) => ({ input, cacheRead, cacheWrite: input, output });
const settings: BillingSettings = {
  autoUpdate: true,
  checkIntervalHours: 24,
  lastCheckedAt: null,
  catalog: {
    schemaVersion: 1,
    publishedAt: "2026-08-14T00:00:00Z",
    source: "test",
    rules: [{
      id: "official", provider: "deepseek-official", model: "deepseek-v4-flash", label: "official",
      currency: "CNY", mode: "official", effectiveFrom: "2026-08-17T00:00:00+08:00",
      rates: rates(1.5, 0.05, 4.5), peakRates: rates(3, 0.1, 9),
      peakWindows: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }]
    }]
  },
  customRules: []
};
const sample = (iso: string): BillingUsageSample => ({
  provider: "deepseek-official", model: "deepseek-v4-flash", time: Date.parse(iso),
  uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000
});

describe("billing", () => {
  it("uses off-peak and peak rates in Asia/Shanghai", () => {
    expect(calculateBillingCost(settings, sample("2026-08-17T08:00:00+08:00")).amount).toBeCloseTo(6.05);
    expect(calculateBillingCost(settings, sample("2026-08-17T09:30:00+08:00")).amount).toBeCloseTo(12.1);
  });

  it("does not price a third-party route with the official rule", () => {
    expect(selectBillingRule(settings, { ...sample("2026-08-17T09:30:00+08:00"), provider: "fireworks" })).toBeNull();
  });

  it("lets a custom rule override a later official version", () => {
    const custom = { ...settings.catalog.rules[0]!, id: "custom", mode: "custom" as const, effectiveFrom: "2026-08-16T00:00:00+08:00", rates: rates(1, 0, 1), peakRates: undefined, peakWindows: undefined };
    expect(selectBillingRule({ ...settings, customRules: [custom] }, sample("2026-08-18T10:00:00+08:00"))?.id).toBe("custom");
  });
});
