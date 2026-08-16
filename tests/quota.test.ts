import { describe, expect, it, vi } from "vitest";
import {
  KimiQuotaSource,
  parseKimiUsages,
} from "../src/main/quota-source.js";

const kimiBody = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    usage: {
      limit: "100",
      used: "48",
      remaining: "52",
      resetTime: "2026-05-19T04:12:48Z",
    },
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        limit: "50",
        used: "7",
        remaining: "43",
      },
      {
        window: { duration: 1, timeUnit: "TIME_UNIT_DAY" },
        limit: "999",
        used: "1",
        remaining: "998",
      },
    ],
    totalQuota: "99",
    ...overrides,
  });

const fixture = (overrides: Record<string, unknown> = {}): unknown =>
  JSON.parse(kimiBody(overrides));

describe("parseKimiUsages", () => {
  it("parses the weekly quota and rolling throughput windows", () => {
    const plan = parseKimiUsages(fixture(), "2026-05-18T12:00:00Z");
    expect(plan.provider).toBe("kimi");
    expect(plan.planName).toBe("Kimi 套餐 · 99");
    expect(plan.windows).toEqual([
      {
        id: "weekly",
        label: "本周",
        kind: "weekly",
        unit: "次",
        used: 48,
        limit: 100,
        remaining: 52,
        resetTime: "2026-05-19T04:12:48.000Z",
        asOf: "2026-05-18T12:00:00Z",
      },
      {
        id: "rolling-0",
        label: "近5小时",
        kind: "rolling",
        unit: "次",
        used: 7,
        limit: 50,
        remaining: 43,
        resetTime: null,
        asOf: "2026-05-18T12:00:00Z",
      },
    ]);
  });

  it("clamps remaining at zero and leaves resetTime null when absent", () => {
    const plan = parseKimiUsages(
      fixture({ usage: { limit: "10", used: "15", remaining: "-5" } }),
      "2026-05-18T12:00:00Z",
    );
    expect(plan.windows[0]!.remaining).toBe(0);
    expect(plan.windows[0]!.resetTime).toBeNull();
  });

  it("drops to a bare plan name when totalQuota is missing", () => {
    const plan = parseKimiUsages(
      fixture({ totalQuota: undefined }),
      "2026-05-18T12:00:00Z",
    );
    expect(plan.planName).toBe("Kimi 套餐");
  });

  it("throws on missing or malformed usage fields", () => {
    expect(() => parseKimiUsages({}, "t")).toThrow("缺少 usage");
    expect(() => parseKimiUsages(fixture({ usage: { limit: "x" } }), "t")).toThrow(
      "usage 字段无效",
    );
    expect(() => parseKimiUsages(null, "t")).toThrow("格式无效");
  });
});

describe("KimiQuotaSource", () => {
  it("returns null without a key and never fetches", async () => {
    const fetcher = vi.fn();
    const source = new KimiQuotaSource({
      credential: async () => null,
      fetcher,
    });
    expect(await source.poll()).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fetches, caches within the window, and re-fetches after fingerprint change", async () => {
    let now = Date.parse("2026-05-18T12:00:00Z");
    let key = "first-key";
    const fetcher = vi.fn().mockImplementation(
      async () => new Response(kimiBody(), { status: 200 }),
    );
    const source = new KimiQuotaSource({
      credential: async () => key,
      fetcher,
      now: () => now,
    });
    const plan = await source.poll();
    expect(plan?.windows).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.kimi.com/coding/v1/usages",
    );
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer first-key",
    });

    now += 60_000;
    await source.poll();
    expect(fetcher).toHaveBeenCalledTimes(1); // cached

    now += 5 * 60_000;
    await source.poll();
    expect(fetcher).toHaveBeenCalledTimes(2); // cache expired

    key = "second-key";
    await source.poll();
    expect(fetcher).toHaveBeenCalledTimes(3); // credential fingerprint invalidated
    expect((fetcher.mock.calls[2]?.[1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer second-key",
    });
  });

  it("surfaces 401 as an invalid-key error", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const source = new KimiQuotaSource({
      credential: async () => "secret",
      fetcher,
    });
    await expect(source.poll()).rejects.toThrow("Kimi API Key 无效或已失效");
  });

  it("surfaces non-OK statuses and malformed bodies as errors", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response("not json", { status: 200 }));
    const source = new KimiQuotaSource({
      credential: async () => "secret",
      fetcher,
    });
    await expect(source.poll()).rejects.toThrow("HTTP 500");
    await expect(source.poll()).rejects.toThrow();
  });
});
