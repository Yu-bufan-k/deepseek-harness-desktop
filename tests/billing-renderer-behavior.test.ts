// @vitest-environment happy-dom
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BillingSettingsSnapshot } from "../src/shared/billing.js";

const rule = {
  id: "official",
  provider: "deepseek-official",
  model: "deepseek-v4-flash",
  label: "DeepSeek V4 Flash",
  currency: "CNY",
  mode: "official" as const,
  effectiveFrom: "2026-08-17T00:00:00+08:00",
  rates: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 2 },
};
const settings: BillingSettingsSnapshot = {
  autoUpdate: true,
  checkIntervalHours: 24,
  lastCheckedAt: null,
  catalog: {
    schemaVersion: 2,
    publishedAt: "2026-08-15T00:00:00Z",
    source: "test",
    peakSchedules: [],
    rules: [rule],
  },
  customRules: [],
  providerBindings: [],
  balanceWarning: { enabled: false, thresholds: { CNY: "10", USD: "2" } },
  ruleStatuses: { official: "active" },
};

afterEach(() => {
  document.documentElement.innerHTML = "";
  vi.restoreAllMocks();
});

describe("billing renderer behavior", () => {
  it("renders prices, exact preformatted money, and the balance ledger", async () => {
    const html = await readFile(
      path.join(process.cwd(), "src", "renderer", "billing.html"),
      "utf8",
    );
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error("billing page script not found");
    document.documentElement.innerHTML =
      html.match(/<body>([\s\S]*?)<script>/)?.[1] ?? "";
    let billingListener: ((value: BillingSettingsSnapshot) => void) | undefined;
    const desktop = {
      getInfo: vi.fn().mockResolvedValue({ themePreference: "light" }),
      getBillingSettings: vi.fn().mockResolvedValue(settings),
      getDeepSeekBalance: vi.fn().mockResolvedValue({
        configured: true,
        isAvailable: true,
        balances: [
          {
            currency: "CNY",
            totalBalance: "110.00",
            grantedBalance: "10.00",
            toppedUpBalance: "100.00",
            totalDisplay: "¥110.00",
            grantedDisplay: "¥10.00",
            toppedUpDisplay: "¥100.00",
            warning: false,
            warningThreshold: null,
            warningThresholdDisplay: null,
          },
        ],
        checkedAt: "2026-08-18T00:00:00Z",
        stale: false,
        errorSummary: null,
      }),
      refreshDeepSeekBalance: vi.fn(),
      useOfficialBilling: vi.fn(),
      onBillingChanged: vi.fn((listener) => {
        billingListener = listener;
        return () => {};
      }),
      onBillingEditRequested: vi.fn(() => () => {}),
      onInfoChanged: vi.fn(() => () => {}),
    };
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktop,
    });
    vi.spyOn(globalThis, "setInterval").mockImplementation(
      () => 1 as unknown as ReturnType<typeof setInterval>,
    );
    Function(script)();
    await vi.waitFor(() =>
      expect(document.getElementById("officialList")?.textContent).toContain(
        "当前生效",
      ),
    );
    expect(document.getElementById("balanceBody")?.textContent).toContain(
      "¥110.00",
    );
    expect(document.getElementById("balanceBody")?.textContent).toContain(
      "¥100.00",
    );
    document.getElementById("openAdd")?.click();
    const dateTrigger = document.querySelector<HTMLButtonElement>(
      "#priceEffectivePicker .date-trigger",
    );
    dateTrigger?.click();
    expect(
      document.querySelector<HTMLElement>("#priceEffectivePicker .date-popover")
        ?.hidden,
    ).toBe(false);
    expect(
      document.querySelector("#priceEffectivePicker .calendar-days")?.children
        .length,
    ).toBeGreaterThan(27);

    billingListener?.({
      ...settings,
      ruleStatuses: { official: "overridden" },
    });
    expect(document.getElementById("officialList")?.textContent).toContain(
      "已被自定义规则覆盖",
    );
  });
});
