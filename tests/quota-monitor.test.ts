import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuotaPlan, QuotaSettings } from "../src/shared/quota.js";
import { QuotaMonitor, computeQuotaWarnings } from "../src/main/quota-monitor.js";
import type { QuotaSource } from "../src/main/quota-source.js";

const plan = (provider: string, windows: QuotaPlan["windows"]): QuotaPlan => ({
  provider,
  planName: null,
  windows,
});
const window = (overrides: Partial<QuotaPlan["windows"][number]> = {}) => ({
  id: "weekly",
  label: "本周",
  kind: "weekly" as const,
  unit: "次",
  used: 0,
  limit: 100,
  remaining: 100,
  resetTime: null,
  asOf: "2026-05-18T12:00:00Z",
  ...overrides,
});

const settings = (overrides: Partial<QuotaSettings> = {}): QuotaSettings => ({
  enabled: true,
  pollIntervalMinutes: 30,
  warningThreshold: 0.2,
  ...overrides,
});

describe("computeQuotaWarnings", () => {
  it("flags exhausted and near-limit windows and skips unlimited ones", () => {
    const warnings = computeQuotaWarnings(
      [
        plan("kimi", [
          window({ id: "w-exhausted", remaining: 0 }),
          window({ id: "w-near", remaining: 10 }),
          window({ id: "w-ok", remaining: 90 }),
          window({ id: "w-unlimited", limit: 0, remaining: 0 }),
        ]),
      ],
      0.2,
    );
    expect(warnings).toEqual([
      {
        provider: "kimi",
        windowId: "w-exhausted",
        kind: "exhausted",
        remaining: 0,
        limit: 100,
        threshold: 0.2,
      },
      {
        provider: "kimi",
        windowId: "w-near",
        kind: "near-limit",
        remaining: 10,
        limit: 100,
        threshold: 0.2,
      },
    ]);
  });
});

describe("QuotaMonitor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const source = (
    provider: string,
    behavior: () => Promise<QuotaPlan | null>,
  ): QuotaSource => ({ provider, poll: behavior });

  it("aggregates plans, needsKey, and errors across sources", async () => {
    const broadcast = vi.fn();
    const monitor = new QuotaMonitor({
      sources: () => [
        source("kimi", async () => plan("kimi", [window()])),
        source("deepseek", async () => null),
        source("fireworks", async () => {
          throw new Error("Kimi 配额接口返回 HTTP 500");
        }),
      ],
      settings: () => settings(),
      broadcast,
      now: () => Date.parse("2026-05-18T12:00:00Z"),
    });
    const snapshot = await monitor.refresh();
    expect(snapshot.plans.map((item) => item.provider)).toEqual(["kimi"]);
    expect(snapshot.needsKey).toEqual(["deepseek"]);
    expect(snapshot.errors.fireworks).toBe("Kimi 配额接口返回 HTTP 500");
    expect(snapshot.warnings).toHaveLength(0);
    expect(snapshot.fetchedAt).toBe("2026-05-18T12:00:00.000Z");
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(monitor.get()).toEqual(snapshot);
  });

  it("warns when a plan crosses the threshold and clears when it recovers", async () => {
    const broadcast = vi.fn();
    const monitor = new QuotaMonitor({
      sources: () => [
        source("kimi", async () =>
          plan("kimi", [window({ remaining: 10, used: 90 })]),
        ),
      ],
      settings: () => settings(),
      broadcast,
    });
    expect((await monitor.refresh()).warnings).toEqual([
      {
        provider: "kimi",
        windowId: "weekly",
        kind: "near-limit",
        remaining: 10,
        limit: 100,
        threshold: 0.2,
      },
    ]);
  });

  it("returns an empty snapshot when disabled without polling sources", async () => {
    const poll = vi.fn(async () => null);
    const broadcast = vi.fn();
    const monitor = new QuotaMonitor({
      sources: () => [source("kimi", poll)],
      settings: () => settings({ enabled: false }),
      broadcast,
    });
    const snapshot = await monitor.refresh(true);
    expect(snapshot).toEqual({
      fetchedAt: "",
      plans: [],
      warnings: [],
      errors: {},
      needsKey: [],
    });
    expect(poll).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("invalidates the cached snapshot on credential change", async () => {
    const monitor = new QuotaMonitor({
      sources: () => [
        source("kimi", async () => plan("kimi", [window()])),
      ],
      settings: () => settings(),
      broadcast: () => {},
    });
    await monitor.refresh();
    expect(monitor.get().plans).toHaveLength(1);
    monitor.invalidate();
    expect(monitor.get()).toEqual({
      fetchedAt: "",
      plans: [],
      warnings: [],
      errors: {},
      needsKey: [],
    });
  });

  it("starts and stops a periodic poll and restarts on new settings", async () => {
    vi.useFakeTimers();
    const broadcast = vi.fn();
    let minutes = 30;
    const monitor = new QuotaMonitor({
      sources: () => [
        source("kimi", async () => plan("kimi", [window()])),
      ],
      settings: () => settings({ pollIntervalMinutes: minutes }),
      broadcast,
    });
    monitor.start();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(broadcast).toHaveBeenCalledTimes(1);
    minutes = 15;
    monitor.start(); // restart with new interval
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(broadcast).toHaveBeenCalledTimes(3); // 15min → 2 ticks + initial
    monitor.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(broadcast).toHaveBeenCalledTimes(3);
  });
});
