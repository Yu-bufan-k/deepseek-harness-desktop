import { describe, expect, it } from "vitest";
import {
  BillingUsageSummarizer,
  localHourStart,
  summarizeBillingUsage,
  type BillingSettings,
  type BillingUsageIndex,
  type BillingUsageSample,
} from "../src/shared/billing.js";

const rates = (
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
) => ({ input, cacheRead, cacheWrite, output });
const settings: BillingSettings = {
  autoUpdate: true,
  checkIntervalHours: 24,
  lastCheckedAt: null,
  catalog: {
    schemaVersion: 2,
    publishedAt: "2026-08-14T00:00:00Z",
    source: "test",
    peakSchedules: [
      {
        id: "cn",
        label: "CN",
        timezone: "Asia/Shanghai",
        windows: [
          { startMinute: 540, endMinute: 720 },
          { startMinute: 1320, endMinute: 120 },
        ],
      },
    ],
    rules: [
      {
        id: "official",
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        label: "official",
        currency: "CNY",
        mode: "official",
        effectiveFrom: "2026-08-17T00:00:00+08:00",
        effectiveTo: "2027-01-01T00:00:00+08:00",
        rates: rates(1.5, 0.05, 0.2, 4.5),
        peakRates: rates(3, 0.1, 0.4, 9),
        peakScheduleId: "cn",
      },
    ],
  },
  customRules: [],
  providerBindings: [],
  balanceWarning: { enabled: false, thresholds: { CNY: "10", USD: "2" } },
};
const sample = (
  iso: string,
  overrides: Partial<BillingUsageSample> = {},
): BillingUsageSample => ({
  provider: "deepseek-official",
  model: "deepseek-v4-flash",
  time: Date.parse(iso),
  uncachedInputTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 1_000_000,
  outputTokens: 1_000_000,
  ...overrides,
});
const index = (sessions: BillingUsageIndex["sessions"]): BillingUsageIndex => ({
  collectedAt: "2026-08-18T00:00:00Z",
  sessions,
});

describe("billing usage series", () => {
  it("buckets samples by local hour and stacks models within a bucket", () => {
    const report = summarizeBillingUsage(
      settings,
      index([
        {
          sessionId: "a",
          title: "A",
          revision: "1",
          samples: [
            sample("2026-08-18T08:10:00+08:00"),
            sample("2026-08-18T08:50:00+08:00"),
            sample("2026-08-18T09:00:00+08:00"),
            {
              ...sample("2026-08-18T08:30:00+08:00"),
              model: "deepseek-reasoner",
            },
          ],
        },
        {
          sessionId: "b",
          title: "B",
          revision: "1",
          samples: [sample("2026-08-18T08:20:00+08:00")],
        },
      ]),
      "2026-08-18T00:00:00Z",
    );
    const hour8 = localHourStart(Date.parse("2026-08-18T08:00:00+08:00"));
    const hour9 = localHourStart(Date.parse("2026-08-18T09:00:00+08:00"));
    expect(report.series.map((bucket) => bucket.hourStart)).toEqual([
      hour8,
      hour9,
    ]);
    const first = report.series[0]!;
    const second = report.series[1]!;
    expect(first.requests).toBe(4); // a(08:10) + a(08:50) + a(08:30, reasoner) + b(08:20)
    expect(first.models).toEqual({
      [JSON.stringify(["deepseek-official", "deepseek-v4-flash"])]: {
        input: 3_000_000,
        cacheRead: 3_000_000,
        cacheWrite: 3_000_000,
        output: 3_000_000,
      },
      [JSON.stringify(["deepseek-official", "deepseek-reasoner"])]: {
        input: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
        output: 1_000_000,
      },
    });
    expect(second.requests).toBe(1);
    expect(
      second.models[JSON.stringify(["deepseek-official", "deepseek-v4-flash"])]
        ?.input,
    ).toBe(1_000_000);
  });

  it("attributes peak and off-peak costs to the correct hour buckets", () => {
    const report = summarizeBillingUsage(
      settings,
      index([
        {
          sessionId: "s",
          title: "S",
          revision: "1",
          samples: [
            sample("2026-08-17T08:00:00+08:00"),
            sample("2026-08-17T09:30:00+08:00"),
          ],
        },
      ]),
      "2026-08-18T00:00:00Z",
    );
    const hour8 = localHourStart(Date.parse("2026-08-17T08:00:00+08:00"));
    const hour9 = localHourStart(Date.parse("2026-08-17T09:30:00+08:00"));
    expect(report.series).toHaveLength(2);
    const offPeak = report.series.find((bucket) => bucket.hourStart === hour8)!;
    const peak = report.series.find((bucket) => bucket.hourStart === hour9)!;
    expect(offPeak.cost.CNY).toBe(String(6.25e9)); // 1.5 + 0.05 + 0.2 + 4.5 元
    expect(peak.cost.CNY).toBe(String(12.5e9)); // 3 + 0.1 + 0.4 + 9 元
  });

  it("keeps the sparse series compact and omits empty hours", () => {
    const report = summarizeBillingUsage(
      settings,
      index([
        {
          sessionId: "s",
          title: "S",
          revision: "1",
          samples: [
            sample("2026-08-17T08:00:00+08:00"),
            sample("2026-08-18T20:00:00+08:00"),
          ],
        },
      ]),
      "2026-08-18T00:00:00Z",
    );
    expect(report.series).toHaveLength(2);
    expect(report.series.map((bucket) => bucket.requests)).toEqual([1, 1]);
  });

  it("counts unpriced requests but leaves cost empty", () => {
    const report = summarizeBillingUsage(
      settings,
      index([
        {
          sessionId: "s",
          title: "S",
          revision: "1",
          samples: [
            { ...sample("2026-08-17T08:00:00+08:00"), provider: "fireworks" },
          ],
        },
      ]),
      "2026-08-18T00:00:00Z",
    );
    const bucket = report.series[0]!;
    expect(bucket.requests).toBe(1);
    expect(bucket.cost).toEqual({});
    expect(bucket.models).toHaveProperty(
      JSON.stringify(["fireworks", "deepseek-v4-flash"]),
    );
  });

  it("maps sessions to their hour buckets and rebuilds series on settings change", () => {
    const summarizer = new BillingUsageSummarizer();
    const usage = index([
      {
        sessionId: "a",
        title: "A",
        revision: "1",
        samples: [
          sample("2026-08-18T08:00:00+08:00"),
          sample("2026-08-18T09:00:00+08:00"),
        ],
      },
      {
        sessionId: "b",
        title: "B",
        revision: "1",
        samples: [sample("2026-08-18T08:00:00+08:00")],
      },
    ]);
    const hour8 = localHourStart(Date.parse("2026-08-18T08:00:00+08:00"));
    const hour9 = localHourStart(Date.parse("2026-08-18T09:00:00+08:00"));
    const first = summarizer.summarize(settings, usage, "2026-08-18T00:00:00Z");
    expect(first.sessionHours).toEqual({ a: [hour8, hour9], b: [hour8] });
    expect(first.series.map((bucket) => bucket.hourStart)).toEqual([
      hour8,
      hour9,
    ]);
    expect(first.series[0]!.requests).toBe(2);
    expect(first.series[1]!.requests).toBe(1);

    const second = summarizer.summarize(
      settings,
      { ...usage, collectedAt: "2026-08-18T00:01:00Z" },
      "2026-08-18T00:01:00Z",
    );
    expect(summarizer.cacheStats()).toEqual({
      hits: 2,
      misses: 2,
      sessions: 2,
    });
    expect(second.series).toEqual(first.series);

    const free = {
      ...settings,
      customRules: [
        {
          ...settings.catalog.rules[0]!,
          id: "free",
          mode: "free" as const,
          peakRates: undefined,
          peakScheduleId: undefined,
        },
      ],
    };
    const third = summarizer.summarize(free, usage, "2026-08-18T00:02:00Z");
    expect(summarizer.cacheStats()).toEqual({
      hits: 2,
      misses: 4,
      sessions: 2,
    });
    expect(third.series[0]!.cost).toEqual({ CNY: "0" });
    expect(
      third.series.map((bucket) => ({ ...bucket, cost: { CNY: "0" } })),
    ).toEqual(
      first.series.map((bucket) => ({ ...bucket, cost: { CNY: "0" } })),
    );
  });
});
