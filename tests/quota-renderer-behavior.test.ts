import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// main.tsx 依赖 monaco/echarts，happy-dom 无法挂载整个 React 树；沿用
// renderer-pages.test.ts 的约定，对源码做行为面断言（UI 标记 + 交互连线）。
function flat(source: string): string {
  return source.replace(/\s+/g, " ");
}

async function workbench(): Promise<string> {
  return flat(
    await readFile(new URL("../src/ui/main.tsx", import.meta.url), "utf8"),
  );
}

async function sidecar(): Promise<string> {
  return flat(
    await readFile(
      new URL("../src/sidecar/electron-directory-picker.ts", import.meta.url),
      "utf8",
    ),
  );
}

describe("quota renderer behavior", () => {
  it("renders the quota card with gauges, reset countdown, and empty states", async () => {
    const source = await workbench();
    expect(source).toContain("配额监控");
    expect(source).toContain("套餐限额，与费用独立");
    expect(source).toContain("quota-gauge state-");
    expect(source).toContain("quota-gauge-fill");
    expect(source).toContain("距重置");
    expect(source).toContain("滚动吞吐窗口，随请求推进自动恢复");
    expect(source).toContain("refreshQuotaUsage");
    expect(source).toContain("aria-label=\"配额厂商\"");
  });

  it("guides toward the credential when no key is configured", async () => {
    const source = await workbench();
    expect(source).toContain("needsKey");
    expect(source).toContain("KIMI_API_KEY");
    expect(source).toContain("已启用");
    expect(source).toContain("系统凭据");
  });

  it("filters the billing view by provider through rollupSeries", async () => {
    const source = await workbench();
    expect(source).toContain("routeFilter");
    expect(source).toContain("rollupSeries(report.series, boundsStart, boundsEnd, route)");
    expect(source).toContain("aria-label=\"厂商\"");
    expect(source).toContain("全部");
    expect(source).toContain("providerOptions(report?.sessions ?? [])");
  });

  it("exposes quota settings controls on the settings page", async () => {
    const source = await workbench();
    expect(source).toContain("getQuotaSettings");
    expect(source).toContain("setQuotaSettings");
    expect(source).toContain("轮询间隔");
    expect(source).toContain("预警阈值");
    expect(source).toContain("pollIntervalMinutes");
    expect(source).toContain("warningThreshold");
    expect(source).toContain("KIMI_API_KEY");
  });

  it("warns the Harness client once per quota window transition", async () => {
    const source = await sidecar();
    expect(source).toContain("onQuotaUsageChanged");
    expect(source).toContain("warnedQuotaRef");
    expect(source).toContain("配额即将用尽");
    expect(source).toContain("配额已用尽");
    expect(source).toContain("desktopNotify(");
  });
});
