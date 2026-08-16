// 本地用量分析：聚合 billing 用量数据与事件日志，供「用量分析」弹窗展示。
// 数据全部来自本地（BillingUsageReport + events-*.jsonl），不产生网络请求。
// 时间范围：today / 7d / 30d / all（与 usage-series 的 RangeKey 对齐，不含 custom）。
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { BillingUsageReport } from "../shared/billing.js";
import type {
  AnalyticsBackendRow,
  AnalyticsErrorRow,
  AnalyticsModelRow,
  AnalyticsRange,
  AnalyticsReport,
  AnalyticsToolRow,
} from "../shared/contracts.js";

const DAY_MS = 86_400_000;

function dayStart(time: number): number {
  const d = new Date(time);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function analyticsRangeBounds(
  range: AnalyticsRange,
  at = Date.now(),
): { start: number; end: number } {
  const today = dayStart(at);
  if (range === "today") return { start: today, end: today + DAY_MS };
  if (range === "7d") return { start: today - 6 * DAY_MS, end: today + DAY_MS };
  if (range === "30d")
    return { start: today - 29 * DAY_MS, end: today + DAY_MS };
  return { start: 0, end: Number.MAX_SAFE_INTEGER };
}

interface LogEvent {
  ts: string;
  area: string;
  type: string;
  [key: string]: unknown;
}

/** 解析日志目录里的 JSONL 事件（按文件名日期过滤 + 时间戳范围过滤）。 */
export async function readLogEvents(
  directory: string,
  bounds: { start: number; end: number },
): Promise<LogEvent[]> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return [];
  }
  const events: LogEvent[] = [];
  for (const entry of files) {
    const match = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(entry);
    if (!match) continue;
    const fileDay = Date.parse(match[1]! + "T00:00:00");
    if (Number.isNaN(fileDay)) continue;
    if (bounds.start > 0 && fileDay + DAY_MS <= bounds.start) continue;
    if (fileDay > bounds.end) continue;
    let content: string;
    try {
      content = await readFile(path.join(directory, entry), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as LogEvent;
        if (typeof event.ts !== "string" || typeof event.area !== "string") continue;
        const ts = Date.parse(event.ts);
        if (Number.isNaN(ts) || ts < bounds.start || ts > bounds.end) continue;
        events.push(event);
      } catch {
        // 单行损坏跳过
      }
    }
  }
  return events.sort((a, b) => a.ts.localeCompare(b.ts));
}

function bucketCostNanos(bucket: { cost?: Record<string, string> }): number {
  for (const value of Object.values(bucket.cost ?? {})) {
    const nanos = Number(value);
    if (Number.isFinite(nanos)) return nanos;
  }
  return 0;
}

function tokensOf(bucket: {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
}): number {
  return (
    (bucket.inputTokens ?? 0) +
    (bucket.cacheReadTokens ?? 0) +
    (bucket.cacheWriteTokens ?? 0) +
    (bucket.outputTokens ?? 0)
  );
}

function moneyNanos(money: { nanos: string } | undefined): number {
  const nanos = Number(money?.nanos);
  return Number.isFinite(nanos) ? nanos : 0;
}

export class AnalyticsService {
  constructor(private readonly options: {
    report: () => BillingUsageReport;
    logDirectory: () => string;
  }) {}

  async getReport(range: AnalyticsRange): Promise<AnalyticsReport> {
    const bounds = analyticsRangeBounds(range);
    const report = this.options.report();
    const events = await readLogEvents(this.options.logDirectory(), bounds);

    // 事件日志维度：视觉解析健康度 + 错误记录
    const visionEvents = events.filter(
      (event) => event.area === "vision-analyze" && event.type === "request",
    );
    const errorEvents = events.filter((event) => event.area === "error");
    const visionBackends = new Map<string, AnalyticsBackendRow>();
    let cachedCount = 0;
    let durationSum = 0;
    for (const event of visionEvents) {
      if (event.cached === true) cachedCount += 1;
      if (typeof event.durationMs === "number") durationSum += event.durationMs;
      const name =
        typeof event.backendName === "string" && event.backendName
          ? event.backendName
          : "未命名";
      const row = visionBackends.get(name) ?? { name, requests: 0, errors: 0 };
      row.requests += 1;
      visionBackends.set(name, row);
    }
    for (const event of errorEvents) {
      if (event.type !== "vision-analyze") continue;
      const name =
        typeof event.backendName === "string" && event.backendName
          ? event.backendName
          : "未命名";
      const row = visionBackends.get(name) ?? { name, requests: 0, errors: 0 };
      row.errors += 1;
      visionBackends.set(name, row);
    }

    const errors: AnalyticsErrorRow[] = errorEvents
      .slice(-20)
      .reverse()
      .map((event) => ({
        ts: event.ts,
        area: event.area,
        type: event.type,
        message:
          typeof event.message === "string" ? event.message : String(event.message ?? ""),
      }));

    // billing 维度：KPI + 时间序列 + 模型排行 + 工具 Top
    const totalTokens = tokensOf(report);
    const requests = report.requests;

    const series: AnalyticsReport["series"] = report.series.map((bucket) => ({
      time: bucket.hourStart,
      tokens: Object.values(bucket.models).reduce(
        (sum, model) =>
          sum + model.input + model.cacheRead + model.cacheWrite + model.output,
        0,
      ),
      cost: bucketCostNanos(bucket),
    }));

    const modelMap = new Map<
      string,
      { key: string; label: string; provider: string; requests: number; tokens: number; cost: number; costDisplay: string }
    >();
    for (const session of report.sessions) {
      for (const model of session.models ?? []) {
        const key = JSON.stringify([model.provider, model.model]);
        const cost = moneyNanos(model.totals?.[0]);
        const row = modelMap.get(key) ?? {
          key,
          label: model.model,
          provider: model.provider,
          requests: 0,
          tokens: 0,
          cost: 0,
          costDisplay: model.totals?.[0]?.display ?? "¥0.0000",
        };
        row.requests += model.requests ?? 0;
        row.tokens += tokensOf(model);
        row.cost += cost;
        modelMap.set(key, row);
      }
    }
    const models: AnalyticsModelRow[] = [...modelMap.values()]
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens)
      .slice(0, 8)
      .map((row) => ({
        key: row.key,
        label: row.label,
        provider: row.provider,
        requests: row.requests,
        tokens: row.tokens,
        costDisplay: row.costDisplay,
      }));

    const tools: AnalyticsToolRow[] = [];
    const collectTools = (
      record: Record<string, number> | undefined,
      kind: AnalyticsToolRow["kind"],
    ) => {
      for (const [name, count] of Object.entries(record ?? {}))
        tools.push({ name, kind, count });
    };
    for (const session of report.sessions) {
      collectTools(session.tools?.tools, "tools");
      collectTools(session.tools?.mcp, "mcp");
      collectTools(session.tools?.skills, "skills");
    }
    const toolMap = new Map<string, AnalyticsToolRow>();
    for (const tool of tools) {
      const key = tool.kind + ":" + tool.name;
      const row = toolMap.get(key) ?? { name: tool.name, kind: tool.kind, count: 0 };
      row.count += tool.count;
      toolMap.set(key, row);
    }
    const sortedTools = [...toolMap.values()].sort((a, b) => b.count - a.count).slice(0, 12);

    const vision = {
      requests: visionEvents.length,
      cached: cachedCount,
      cacheRate: visionEvents.length > 0 ? cachedCount / visionEvents.length : 0,
      avgDurationMs: visionEvents.length > 0 ? durationSum / visionEvents.length : 0,
      errors: errorEvents.filter((event) => event.type === "vision-analyze").length,
      backends: [...visionBackends.values()].sort((a, b) => b.requests - a.requests),
    };

    return {
      range,
      kpi: {
        costDisplay: report.totals?.[0]?.display ?? "¥0.0000",
        tokens: totalTokens,
        requests,
        errors: errorEvents.length,
      },
      series,
      models,
      tools: sortedTools,
      vision,
      errors,
    };
  }
}
