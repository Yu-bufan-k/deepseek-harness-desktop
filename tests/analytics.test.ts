import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AnalyticsService,
  analyticsRangeBounds,
  readLogEvents,
} from "../src/main/analytics.js";
import type { BillingUsageReport } from "../src/shared/billing.js";

const directories: string[] = [];
afterEach(() =>
  Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-analytics-"));
  directories.push(directory);
  return directory;
}

const dayStamp = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

function reportFixture(): BillingUsageReport {
  return {
    syncedAt: new Date().toISOString(),
    collectedAt: new Date().toISOString(),
    lastUsageAt: null,
    requests: 4,
    inputTokens: 800,
    cacheReadTokens: 100,
    cacheWriteTokens: 50,
    outputTokens: 300,
    unpricedRequests: 0,
    totals: [
      { currency: "CNY", nanos: "1250000000", display: "¥1.2500" },
    ],
    sessions: [
      {
        sessionId: "s1",
        title: "测试对话",
        requests: 4,
        inputTokens: 800,
        cacheReadTokens: 100,
        cacheWriteTokens: 50,
        outputTokens: 300,
        unpricedRequests: 0,
        lastUsageAt: new Date().toISOString(),
        totals: [{ currency: "CNY", nanos: "1250000000", display: "¥1.2500" }],
        models: [
          {
            provider: "deepseek",
            model: "deepseek-chat",
            requests: 4,
            inputTokens: 800,
            cacheReadTokens: 100,
            cacheWriteTokens: 50,
            outputTokens: 300,
            unpricedRequests: 0,
            totals: [
              { currency: "CNY", nanos: "1250000000", display: "¥1.2500" },
            ],
            currentPricing: null,
            officialPricing: null,
          },
        ],
        tools: {
          tools: { vision_understand: 3 },
          mcp: { "db-mcp": 2 },
          skills: {},
        },
      },
    ],
    series: [
      {
        hourStart: Date.now() - 3_600_000,
        requests: 2,
        models: {},
        cost: { CNY: "500000000" },
      },
      {
        hourStart: Date.now() - 7_200_000,
        requests: 2,
        models: {},
        cost: { CNY: "750000000" },
      },
    ],
    sessionHours: { s1: [Date.now() - 3_600_000] },
    currentTarget: null,
    warnings: [],
  };
}

describe("AnalyticsService", () => {
  it("aggregates billing report and event logs into an analytics report", async () => {
    const logDirectory = await fixture();
    const now = new Date();
    await writeFile(
      path.join(logDirectory, `events-${dayStamp(now)}.jsonl`),
      [
        JSON.stringify({
          ts: now.toISOString(),
          seq: 1,
          area: "vision-analyze",
          type: "request",
          backendName: "智谱",
          model: "glm-4v-flash",
          cached: false,
          durationMs: 800,
        }),
        JSON.stringify({
          ts: new Date(now.getTime() - 60_000).toISOString(),
          seq: 2,
          area: "vision-analyze",
          type: "request",
          backendName: "智谱",
          model: "glm-4v-flash",
          cached: true,
          durationMs: 400,
        }),
        JSON.stringify({
          ts: now.toISOString(),
          seq: 3,
          area: "error",
          type: "vision-analyze",
          backendName: "智谱",
          message: "视觉 API 请求失败（HTTP 404）",
        }),
        "损坏的行\n",
      ].join("\n"),
      "utf8",
    );
    const service = new AnalyticsService({
      report: reportFixture,
      logDirectory: () => logDirectory,
    });
    const result = await service.getReport("7d");
    expect(result.kpi.costDisplay).toBe("¥1.2500");
    expect(result.kpi.requests).toBe(4);
    expect(result.kpi.tokens).toBe(1250);
    expect(result.kpi.errors).toBe(1);
    expect(result.vision.requests).toBe(2);
    expect(result.vision.cached).toBe(1);
    expect(result.vision.cacheRate).toBeCloseTo(0.5);
    expect(result.vision.avgDurationMs).toBe(600);
    expect(result.vision.errors).toBe(1);
    expect(result.vision.backends).toEqual([
      { name: "智谱", requests: 2, errors: 1 },
    ]);
    expect(result.models[0]?.label).toBe("deepseek-chat");
    expect(result.models[0]?.costDisplay).toBe("¥1.2500");
    expect(result.tools).toContainEqual({
      name: "vision_understand",
      kind: "tools",
      count: 3,
    });
    expect(result.tools).toContainEqual({ name: "db-mcp", kind: "mcp", count: 2 });
    expect(result.errors[0]?.message).toContain("404");
    expect(result.series.length).toBeGreaterThan(0);
  });

  it("filters event logs by range bounds", async () => {
    const logDirectory = await fixture();
    const now = new Date();
    await writeFile(
      path.join(logDirectory, `events-${dayStamp(now)}.jsonl`),
      JSON.stringify({
        ts: now.toISOString(),
        seq: 1,
        area: "ipc",
        type: "save-vision-image",
        imageId: "abc",
      }) + "\n",
      "utf8",
    );
    const bounds = analyticsRangeBounds("today");
    const events = await readLogEvents(logDirectory, bounds);
    expect(events).toHaveLength(1);
    const oldBounds = { start: 0, end: Date.now() - 86_400_000 * 2 };
    const oldEvents = await readLogEvents(logDirectory, oldBounds);
    expect(oldEvents).toHaveLength(0);
  });
});
