import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingUsageSeriesBucket } from "../src/shared/billing.js";
import {
  bucketLabel,
  DAY_MS,
  dayStart,
  HOUR_MS,
  rangeBounds,
  rollupSeries,
} from "../src/ui/usage-series.js";

const bucket = (
  hourStart: number,
  overrides: Partial<BillingUsageSeriesBucket> = {},
): BillingUsageSeriesBucket => ({
  hourStart,
  requests: 0,
  models: {},
  cost: {},
  ...overrides,
});

describe("usage series: rangeBounds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 15, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps today / 7d / 30d / all to local-day-aligned bounds", () => {
    const today = dayStart(Date.now());
    expect(rangeBounds("today", "", "")).toEqual({
      start: today,
      end: today + DAY_MS,
    });
    expect(rangeBounds("7d", "", "")).toEqual({
      start: today - 6 * DAY_MS,
      end: today + DAY_MS,
    });
    expect(rangeBounds("30d", "", "")).toEqual({
      start: today - 29 * DAY_MS,
      end: today + DAY_MS,
    });
    expect(rangeBounds("all", "", "")).toEqual({
      start: 0,
      end: Number.MAX_SAFE_INTEGER,
    });
  });

  it("maps custom dates to inclusive whole days in local time", () => {
    const start = new Date(2026, 6, 10).getTime();
    const end = new Date(2026, 6, 12).getTime() + DAY_MS;
    expect(rangeBounds("custom", "2026-07-10", "2026-07-12")).toEqual({
      start,
      end,
    });
  });

  it("rejects malformed or reversed custom ranges", () => {
    expect(rangeBounds("custom", "bad", "2026-07-10")).toBeNull();
    expect(rangeBounds("custom", "2026-07-12", "2026-07-10")).toBeNull();
  });
});

describe("usage series: rollupSeries", () => {
  it("keeps hour granularity when the range spans at most a day and drops out-of-range buckets", () => {
    const today = dayStart(Date.now());
    const h9 = today + 9 * HOUR_MS;
    const h10 = today + 10 * HOUR_MS;
    const outside = today - DAY_MS + 5 * HOUR_MS;
    const result = rollupSeries(
      [
        bucket(h9, { requests: 2 }),
        bucket(outside, { requests: 9 }),
        bucket(h10, { requests: 1 }),
      ],
      today,
      today + DAY_MS,
    );
    expect(result.map((entry) => entry.key)).toEqual([h9, h10]);
    expect(result.map((entry) => entry.requests)).toEqual([2, 1]);
  });

  it("rolls hours up to days beyond a day span, merging models and cost", () => {
    const today = dayStart(Date.now());
    const yesterday = today - DAY_MS;
    const series = [
      bucket(yesterday + 8 * HOUR_MS, {
        requests: 1,
        cost: { CNY: "100" },
        models: { m: { input: 10, cacheRead: 2, cacheWrite: 0, output: 4 } },
      }),
      bucket(yesterday + 20 * HOUR_MS, {
        requests: 2,
        cost: { CNY: "200" },
        models: { m: { input: 20, cacheRead: 0, cacheWrite: 1, output: 0 } },
      }),
      bucket(today + 8 * HOUR_MS, { requests: 4 }),
    ];
    const result = rollupSeries(series, yesterday, today + DAY_MS);
    expect(result.map((entry) => entry.key)).toEqual([yesterday, today]);
    expect(result[0]!.requests).toBe(3);
    expect(result[0]!.cost.CNY).toBe(300n);
    expect(result[0]!.models.m).toEqual({
      input: 30,
      cacheRead: 2,
      cacheWrite: 1,
      output: 4,
    });
    expect(result[1]!.requests).toBe(4);
    expect(result[1]!.cost).toEqual({});
  });

  it("returns buckets sorted ascending by key", () => {
    const today = dayStart(Date.now());
    const result = rollupSeries(
      [bucket(today + 3 * HOUR_MS), bucket(today), bucket(today + 2 * HOUR_MS)],
      today,
      today + DAY_MS,
    );
    expect(result.map((entry) => entry.key)).toEqual([
      today,
      today + 2 * HOUR_MS,
      today + 3 * HOUR_MS,
    ]);
  });
});

describe("usage series: bucketLabel", () => {
  it("formats hour and day labels with and without the full date", () => {
    const hourKey = new Date(2026, 7, 12, 9).getTime();
    expect(bucketLabel(hourKey, "hour")).toBe("09时");
    expect(bucketLabel(hourKey, "hour", true)).toBe("8月12日 09时");
    const dayKey = new Date(2026, 7, 12).getTime();
    expect(bucketLabel(dayKey, "day")).toBe("8/12");
    expect(bucketLabel(dayKey, "day", true)).toBe("2026年8月12日");
  });
});
