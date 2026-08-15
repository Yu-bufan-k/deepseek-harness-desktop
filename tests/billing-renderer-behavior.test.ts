// @vitest-environment happy-dom
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BillingSettingsSnapshot, BillingUsageReport } from "../src/shared/billing.js";

const rule = {
  id: "official", provider: "deepseek-official", model: "deepseek-v4-flash", label: "DeepSeek V4 Flash", currency: "CNY", mode: "official" as const,
  effectiveFrom: "2026-08-17T00:00:00+08:00", rates: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 2 }
};
const settings: BillingSettingsSnapshot = {
  autoUpdate: true, checkIntervalHours: 24, lastCheckedAt: null,
  catalog: { schemaVersion: 2, publishedAt: "2026-08-15T00:00:00Z", source: "test", peakSchedules: [], rules: [rule] },
  customRules: [], ruleStatuses: { official: "active" }
};
const report: BillingUsageReport = {
  syncedAt: "2026-08-18T00:00:00Z", collectedAt: "2026-08-18T00:00:00Z", lastUsageAt: "2026-08-18T00:00:00Z",
  requests: 1, inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4, unpricedRequests: 0,
  totals: [{ currency: "CNY", nanos: "9007199254740993", display: "¥9,007,199.254741" }],
  sessions: [{
    sessionId: "s", title: "计费行为测试", requests: 1, inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4,
    unpricedRequests: 0, lastUsageAt: "2026-08-18T00:00:00Z", totals: [{ currency: "CNY", nanos: "9007199254740993", display: "¥9,007,199.254741" }],
    models: [{ provider: rule.provider, model: rule.model, requests: 1, inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4, unpricedRequests: 0, totals: [{ currency: "CNY", nanos: "9007199254740993", display: "¥9,007,199.254741" }], currentPricing: null }]
  }],
  currentTarget: null, warnings: []
};

afterEach(() => { document.documentElement.innerHTML = ""; vi.restoreAllMocks(); });

describe("billing renderer behavior", () => {
  it("renders main-process status and exact preformatted money", async () => {
    const html = await readFile(path.join(process.cwd(), "src", "renderer", "billing.html"), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error("billing page script not found");
    document.documentElement.innerHTML = html.match(/<body>([\s\S]*?)<script>/)?.[1] ?? "";
    let billingListener: ((value: BillingSettingsSnapshot) => void) | undefined;
    let usageListener: ((value: BillingUsageReport) => void) | undefined;
    const desktop = {
      getInfo: vi.fn().mockResolvedValue({ themePreference: "light" }),
      getBillingSettings: vi.fn().mockResolvedValue(settings),
      getBillingUsage: vi.fn().mockResolvedValue(report),
      onBillingChanged: vi.fn((listener) => { billingListener = listener; return () => {}; }),
      onBillingUsageChanged: vi.fn((listener) => { usageListener = listener; return () => {}; }),
      onBillingEditRequested: vi.fn(() => () => {}), onInfoChanged: vi.fn(() => () => {})
    };
    Object.defineProperty(window, "desktop", { configurable: true, value: desktop });
    vi.spyOn(globalThis, "setInterval").mockImplementation(() => 1 as unknown as ReturnType<typeof setInterval>);
    Function(script)();
    await vi.waitFor(() => expect(document.getElementById("usageTotal")?.textContent).toBe("¥9,007,199.254741"));
    expect(document.getElementById("officialList")?.textContent).toContain("当前生效");
    expect(document.getElementById("sessionUsageList")?.textContent).toContain("计费行为测试");
    expect(document.getElementById("sessionUsageList")?.textContent).toContain("¥9,007,199.254741");

    billingListener?.({ ...settings, ruleStatuses: { official: "overridden" } });
    expect(document.getElementById("officialList")?.textContent).toContain("已被自定义规则覆盖");
    usageListener?.({ ...report, totals: [{ currency: "CNY", nanos: "5000000", display: "¥0.0050" }] });
    expect(document.getElementById("usageTotal")?.textContent).toBe("¥0.0050");
  });
});
