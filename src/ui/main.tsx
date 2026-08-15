import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import type { BillingUsageReport } from "../shared/billing.js";
import { formatBillingMoney } from "../shared/billing.js";
import type {
  ChangeBatch,
  DesktopInfo,
  FileDiff,
  McpVisionBackendConfig,
  VisionBackendConfig,
  VisionResult,
  VisionSettings,
} from "../shared/contracts.js";
import type { EChartsType } from "echarts/core";
import { editor } from "./monaco.js";
import {
  bucketLabel,
  compactTokens,
  DAY_MS,
  dayStart,
  HOUR_MS,
  modelLabel,
  rangeBounds,
  rollupSeries,
  sumModelTokens,
  toDateStr,
  type ChartBucket,
  type Metric,
  type RangeKey,
} from "./usage-series.js";
import "./styles.css";

type View = "changes" | "billing" | "vision" | "settings";
const WORKBENCH_VIEWS = new Set<View>(["changes", "vision"]);
const POPUP_VIEWS = new Set<View>(["billing", "settings"]);
const NAV_VIEWS: Array<{
  id: "changes" | "vision";
  label: string;
  glyph: string;
}> = [
  { id: "changes", label: "变更", glyph: "±" },
  { id: "vision", label: "视觉", glyph: "◎" },
];

const RANGE_PRESETS: Array<{ key: RangeKey; label: string }> = [
  { key: "today", label: "今日" },
  { key: "7d", label: "近7天" },
  { key: "30d", label: "近30天" },
  { key: "all", label: "全部" },
  { key: "custom", label: "自定义" },
];
const METRICS: Array<{ key: Metric; label: string }> = [
  { key: "cost", label: "费用" },
  { key: "tokens", label: "Token" },
  { key: "requests", label: "请求" },
];

const cssVar = (name: string, fallback: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
  fallback;

function chartColors(): string[] {
  return [
    cssVar("--wb-accent", "#4d6bfe"),
    cssVar("--wb-green", "#22a06b"),
    cssVar("--wb-amber", "#d99000"),
    cssVar("--wb-red", "#ec1313"),
    "#7a5af8",
    "#0aa5c3",
    "#d65c94",
    "#8a8f98",
  ];
}

type ChartOption = Parameters<EChartsType["setOption"]>[0];

function buildChartOption(
  buckets: ChartBucket[],
  granularity: "hour" | "day",
  metric: Metric,
  selection: { start: number; end: number } | null,
): ChartOption {
  const colors = chartColors();
  const axis = cssVar("--wb-faint", "#6d717c");
  const line = cssVar("--wb-line", "rgba(0,0,0,.1)");
  const split = cssVar("--wb-line-soft", "rgba(0,0,0,.04)");
  const labels = buckets.map((bucket) => bucketLabel(bucket.key, granularity));
  const compactMoney = (value: number): string => {
    if (value === 0) return "0";
    const abs = Math.abs(value);
    if (abs >= 1e4) return `${(value / 1e4).toFixed(1)}万`;
    if (abs >= 1) return String(Math.round(value * 100) / 100);
    if (value > 0.001) return value.toFixed(3);
    return value.toFixed(6);
  };
  const tooltip = (render: (bucket: ChartBucket) => string) => ({
    trigger: "axis" as const,
    confine: true,
    backgroundColor: cssVar("--wb-panel", "#fff"),
    borderColor: cssVar("--wb-line", "rgba(0,0,0,.1)"),
    textStyle: { color: cssVar("--wb-text", "#171719"), fontSize: 12 },
    formatter: (params: unknown) => {
      const index = Number(
        Array.isArray(params)
          ? (params[0] as { dataIndex?: number })?.dataIndex
          : (params as { dataIndex?: number }).dataIndex,
      );
      const bucket = buckets[index];
      return bucket
        ? `<div style="font-weight:600;margin-bottom:4px">${bucketLabel(bucket.key, granularity, true)}</div>${render(bucket)}`
        : "";
    },
  });
  const markArea = (() => {
    if (!selection) return undefined;
    const hits = buckets
      .map((bucket, index) =>
        bucket.key >= selection.start && bucket.key < selection.end
          ? index
          : -1,
      )
      .filter((index) => index >= 0);
    if (!hits.length) return undefined;
    return {
      silent: true,
      itemStyle: { color: cssVar("--wb-accent-soft", "rgba(77,107,254,.10)") },
      data: [
        { xAxis: labels[hits[0]!] },
        { xAxis: labels[hits[hits.length - 1]!] },
      ],
    };
  })();
  const base = {
    animation: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    color: colors,
    grid: { left: 8, right: 10, top: 34, bottom: 6, containLabel: true },
    xAxis: {
      type: "category" as const,
      data: labels,
      boundaryGap: metric !== "cost",
      axisLine: { lineStyle: { color: line } },
      axisTick: { show: false },
      axisLabel: { color: axis, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: "value" as const,
      axisLabel: {
        color: axis,
        fontSize: 11,
        formatter: (value: number) =>
          metric === "cost" ? compactMoney(value) : compactTokens(value),
      },
      splitLine: { lineStyle: { color: split } },
    },
  };
  if (metric === "cost") {
    const currencies = [
      ...new Set(buckets.flatMap((bucket) => Object.keys(bucket.cost))),
    ].sort();
    return {
      ...base,
      tooltip: tooltip((bucket) => {
        const entries = Object.entries(bucket.cost);
        return entries.length
          ? entries
              .map(
                ([currency, nanos]) =>
                  `<div style="display:flex;justify-content:space-between;gap:16px"><span>${currency}</span><b>${formatBillingMoney(currency, nanos.toString())}</b></div>`,
              )
              .join("")
          : `<span style="opacity:.6">无计价数据</span>`;
      }),
      series: currencies.map((currency, index) => ({
        name: currency,
        type: "line" as const,
        smooth: true,
        symbol: "circle",
        symbolSize: 5,
        emphasis: { focus: "series" as const },
        markArea: index === 0 ? markArea : undefined,
        data: buckets.map(
          (bucket) => Number(bucket.cost[currency] ?? 0n) / 1e9,
        ),
      })),
    };
  }
  if (metric === "tokens") {
    const modelKeys = [
      ...new Set(buckets.flatMap((bucket) => Object.keys(bucket.models))),
    ];
    modelKeys.sort(
      (left, right) =>
        buckets.reduce(
          (sum, bucket) => sum + sumModelTokens(bucket.models[right]),
          0,
        ) -
        buckets.reduce(
          (sum, bucket) => sum + sumModelTokens(bucket.models[left]),
          0,
        ),
    );
    return {
      ...base,
      tooltip: tooltip((bucket) => {
        const rows = Object.entries(bucket.models).map(([modelKey, part]) => {
          const total = sumModelTokens(part);
          return `<div style="display:flex;justify-content:space-between;gap:16px"><span>${modelLabel(modelKey)}</span><b>${compactTokens(total)}</b></div><div style="opacity:.6;font-size:11px;margin:-1px 0 3px">输入 ${compactTokens(part.input)} · 缓存读 ${compactTokens(part.cacheRead)} · 缓存写 ${compactTokens(part.cacheWrite)} · 输出 ${compactTokens(part.output)}</div>`;
        });
        const costLine = Object.entries(bucket.cost).length
          ? `<div style="margin-top:4px;opacity:.75">${Object.entries(
              bucket.cost,
            )
              .map(([currency, nanos]) =>
                formatBillingMoney(currency, nanos.toString()),
              )
              .join(" + ")}</div>`
          : "";
        return `${rows.join("")}${costLine}`;
      }),
      series: modelKeys.map((modelKey, index) => ({
        name: modelLabel(modelKey),
        type: "bar" as const,
        stack: "tokens",
        barMaxWidth: 26,
        emphasis: { focus: "series" as const },
        markArea: index === 0 ? markArea : undefined,
        data: buckets.map((bucket) => sumModelTokens(bucket.models[modelKey])),
      })),
    };
  }
  return {
    ...base,
    tooltip: tooltip((bucket) => `<div>${bucket.requests} 次请求</div>`),
    series: [
      {
        name: "请求数",
        type: "bar" as const,
        barMaxWidth: 26,
        itemStyle: { color: cssVar("--wb-accent", "#4d6bfe") },
        markArea,
        data: buckets.map((bucket) => bucket.requests),
      },
    ],
  };
}

function UsageChart({
  buckets,
  granularity,
  metric,
  selection,
  onSelect,
}: {
  buckets: ChartBucket[];
  granularity: "hour" | "day";
  metric: Metric;
  selection: { start: number; end: number; label: string } | null;
  onSelect: (
    value: { start: number; end: number; label: string } | null,
  ) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const bucketsRef = useRef(buckets);
  bucketsRef.current = buckets;
  const granularityRef = useRef(granularity);
  granularityRef.current = granularity;
  const metricRef = useRef(metric);
  metricRef.current = metric;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;
    let chart: EChartsType | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let themeObserver: MutationObserver | null = null;
    void import("./echarts.js").then(({ default: echarts }) => {
      if (disposed) return;
      chart = echarts.init(el);
      chartRef.current = chart;
      chart.setOption(
        buildChartOption(
          bucketsRef.current,
          granularityRef.current,
          metricRef.current,
          selectionRef.current,
        ),
      );
      resizeObserver = new ResizeObserver(() => chart!.resize());
      resizeObserver.observe(el);
      themeObserver = new MutationObserver(() =>
        chart!.setOption(
          buildChartOption(
            bucketsRef.current,
            granularityRef.current,
            metricRef.current,
            selectionRef.current,
          ),
          true,
        ),
      );
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ["data-ds-dark-theme"],
      });
      chart.on("click", (params: unknown) => {
        const index = (params as { dataIndex?: number }).dataIndex;
        const bucket = bucketsRef.current[Number(index)];
        if (!bucket) return;
        const start = bucket.key;
        const end =
          start + (granularityRef.current === "hour" ? HOUR_MS : DAY_MS);
        onSelectRef.current({
          start,
          end,
          label: bucketLabel(bucket.key, granularityRef.current, true),
        });
      });
    });
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);
  useEffect(() => {
    chartRef.current?.setOption(
      buildChartOption(buckets, granularity, metric, selection),
      true,
    );
  }, [buckets, granularity, metric, selection]);
  return <div className="usage-chart" ref={containerRef} />;
}

function useTheme(info: DesktopInfo | null) {
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark =
        info?.themePreference === "dark" ||
        (info?.themePreference !== "light" && query.matches);
      document.body.toggleAttribute("data-ds-dark-theme", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [info?.themePreference]);
}

function DiffEditor({
  value,
  inline,
  ignoreWhitespace,
}: {
  value: FileDiff;
  inline: boolean;
  ignoreWhitespace: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const original = editor.createModel(value.original, value.language);
    const modified = editor.createModel(value.modified, value.language);
    const instance = editor.createDiffEditor(ref.current, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: !inline,
      ignoreTrimWhitespace: ignoreWhitespace,
      renderOverviewRuler: true,
      minimap: { enabled: false },
      fontFamily:
        getComputedStyle(document.documentElement)
          .getPropertyValue("--ds-font-family-code")
          .trim() || "Consolas, 'Microsoft YaHei', monospace",
      fontSize: 12.5,
      lineHeight: 20,
      scrollBeyondLastLine: false,
      folding: true,
      renderIndicators: true,
    });
    instance.setModel({ original, modified });
    return () => {
      instance.dispose();
      original.dispose();
      modified.dispose();
    };
  }, [value, inline, ignoreWhitespace]);
  return <div className="diff-editor" ref={ref} />;
}

function ChangesView({
  notify,
  workspacePath,
}: {
  notify: (message: string, error?: boolean) => void;
  workspacePath: string | null;
}) {
  const [batches, setBatches] = useState<ChangeBatch[]>([]);
  const [batchId, setBatchId] = useState("");
  const [filePath, setFilePath] = useState("");
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [title, setTitle] = useState("");
  const [inline, setInline] = useState(false);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const batch = batches.find((entry) => entry.id === batchId) ?? batches[0];
  const refresh = async () => {
    const next = await window.desktop.listChangeBatches();
    setBatches(next);
    if (!batchId && next[0]) setBatchId(next[0].id);
  };
  useEffect(() => {
    // 挂载时加载一次并订阅变更。refresh 依赖 batchId，直接放进依赖数组会让
    // 每次 batchId 变化都重新拉取；这里内联首拉逻辑，语义与 refresh 相同。
    void window.desktop.listChangeBatches().then((next) => {
      setBatches(next);
      const first = next[0];
      if (first) setBatchId((current) => current || first.id);
    });
    return window.desktop.onChangeBatchesChanged(setBatches);
  }, []);
  useEffect(() => {
    if (!batch?.files?.some((file) => file.path === filePath)) {
      setFilePath(batch?.files[0]?.path ?? "");
      setDiff(null);
    }
  }, [batch?.files, filePath]);
  useEffect(() => {
    if (!batch || !filePath) {
      setDiff(null);
      return;
    }
    window.desktop
      .getFileDiff(batch.id, filePath)
      .then(setDiff)
      .catch((error) => {
        setDiff(null);
        notify(String(error), true);
      });
  }, [batch, filePath, notify]);
  const act = async (task: () => Promise<unknown>, message: string) => {
    try {
      await task();
      await refresh();
      notify(message);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    }
  };
  return (
    <div className="feature-layout changes-feature">
      <aside className="context-panel">
        <div className="panel-title">
          <div>
            <h2>本次任务</h2>
            <small title={workspacePath ?? undefined}>
              {workspacePath ?? "请先在 Harness 打开对话"}
            </small>
          </div>
          <span className="count">{batches.length}</span>
        </div>
        <form
          className="batch-create"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              const created = await window.desktop.createChangeBatch(
                title || "新任务",
              );
              setTitle("");
              setBatchId(created.id);
            }, "已捕获任务基线");
          }}
        >
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="任务标题"
            aria-label="任务标题"
            disabled={!workspacePath}
          />
          <button
            className="primary"
            disabled={!workspacePath}
            title={
              workspacePath
                ? "捕获当前对话工作区基线"
                : "请先在 Harness 打开一个工作区对话"
            }
          >
            开始
          </button>
        </form>
        <select
          className="batch-select"
          value={batch?.id ?? ""}
          onChange={(event) => {
            setBatchId(event.target.value);
            setFilePath("");
          }}
          aria-label="变更批次"
        >
          {!batches.length && <option value="">暂无变更批次</option>}
          {batches.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.state === "capturing" ? "● " : ""}
              {entry.title}
            </option>
          ))}
        </select>
        {batch?.state === "capturing" && (
          <button
            className="wide-button"
            onClick={() =>
              void act(
                () => window.desktop.closeChangeBatch(batch.id),
                "已生成本次任务 Diff",
              )
            }
          >
            结束并生成 Diff
          </button>
        )}
        {batch && (
          <div className="batch-meta">
            <span>{new Date(batch.createdAt).toLocaleString()}</span>
            <span>{batch.preexistingDirtyPaths.length} 个任务前变更已隔离</span>
          </div>
        )}
        <div className="section-label">文件</div>
        <div className="file-list">
          {batch?.files.map((file) => (
            <button
              key={file.path}
              className={`file-row ${file.path === filePath ? "active" : ""}`}
              onClick={() => setFilePath(file.path)}
            >
              <span className={`change-kind kind-${file.kind}`}>
                {file.kind[0]!.toUpperCase()}
              </span>
              <span className="file-name">{file.path}</span>
              <span className="delta">
                <i>+{file.additions}</i> <b>-{file.deletions}</b>
              </span>
            </button>
          ))}
          {batch?.state === "ready" && !batch.files.length && (
            <div className="empty-small">这个任务没有文件修改。</div>
          )}
        </div>
        {!!batch?.preexistingDirtyPaths.length && (
          <details className="preexisting">
            <summary>任务前已有变更</summary>
            {batch.preexistingDirtyPaths.map((item) => (
              <div key={item}>{item}</div>
            ))}
          </details>
        )}
      </aside>
      <main className="stage">
        <div className="editor-toolbar">
          <span className="breadcrumb">
            {diff?.path ?? "选择一个文件查看变更"}
          </span>
          <div className="toolbar-actions">
            <button
              className={inline ? "" : "active"}
              onClick={() => setInline(false)}
            >
              并排
            </button>
            <button
              className={inline ? "active" : ""}
              onClick={() => setInline(true)}
            >
              行内
            </button>
            <label>
              <input
                type="checkbox"
                checked={ignoreWhitespace}
                onChange={(event) => setIgnoreWhitespace(event.target.checked)}
              />
              忽略空白
            </label>
          </div>
        </div>
        {diff ? (
          diff.change.binary ? (
            <Empty
              title="二进制文件"
              detail="此文件只显示变更状态，不生成文本 Diff。"
            />
          ) : (
            <DiffEditor
              value={diff}
              inline={inline}
              ignoreWhitespace={ignoreWhitespace}
            />
          )
        ) : (
          <Empty
            title="等待审阅"
            detail="开始任务时捕获基线，任务完成后生成与任务前状态的精确对比。"
          />
        )}
      </main>
      <aside className="inspector">
        <span className="eyebrow">REVIEW</span>
        <h3>审阅与撤销</h3>
        {diff ? (
          <>
            <div className="metric-strip">
              <span>
                <b>{diff.change.additions}</b> 新增
              </span>
              <span>
                <b>{diff.change.deletions}</b> 删除
              </span>
            </div>
            <button
              className="wide-button"
              onClick={() =>
                void act(
                  () =>
                    window.desktop.markChangeReviewed(diff.batchId, diff.path),
                  "文件已标记为审阅",
                )
              }
            >
              标记文件已审阅
            </button>
            <button
              className="wide-button danger"
              onClick={() =>
                confirm(`撤销 ${diff.path} 的全部本次修改？`) &&
                void act(
                  () =>
                    window.desktop.revertChangeFile(diff.batchId, diff.path),
                  "文件修改已撤销",
                )
              }
            >
              撤销文件
            </button>
            <div className="section-label">代码块</div>
            {diff.change.hunks.map((hunk, index) => (
              <div className="hunk" key={hunk.id}>
                <div>
                  <b>变更 {index + 1}</b>
                  <code>{hunk.header}</code>
                </div>
                <div>
                  <button
                    onClick={() =>
                      void act(
                        () =>
                          window.desktop.markChangeReviewed(
                            diff.batchId,
                            diff.path,
                            hunk.id,
                          ),
                        "代码块已审阅",
                      )
                    }
                  >
                    已审阅
                  </button>
                  <button
                    onClick={() =>
                      confirm("只撤销这个代码块？") &&
                      void act(
                        () =>
                          window.desktop.revertChangeHunk(
                            diff.batchId,
                            diff.path,
                            hunk.id,
                          ),
                        "代码块已撤销",
                      )
                    }
                  >
                    撤销此处
                  </button>
                </div>
              </div>
            ))}
          </>
        ) : (
          <p className="muted">
            选择文件后，可逐块审阅或安全撤销。文件哈希不一致时撤销会自动停止。
          </p>
        )}
      </aside>
    </div>
  );
}

function BillingView() {
  const [report, setReport] = useState<BillingUsageReport | null>(null);
  const [range, setRange] = useState<RangeKey>("7d");
  const [metric, setMetric] = useState<Metric>("cost");
  const [customOpen, setCustomOpen] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [selection, setSelection] = useState<{
    start: number;
    end: number;
    label: string;
  } | null>(null);
  useEffect(() => {
    window.desktop.getBillingUsage().then(setReport);
    return window.desktop.onBillingUsageChanged(setReport);
  }, []);
  const openCustom = () => {
    const today = dayStart(Date.now());
    setCustomStart(toDateStr(today - 6 * DAY_MS));
    setCustomEnd(toDateStr(today));
    setRange("custom");
    setCustomOpen(true);
  };
  const bounds = rangeBounds(range, customStart, customEnd);
  const boundsStart = bounds?.start;
  const boundsEnd = bounds?.end;
  const buckets = useMemo(
    () =>
      report && boundsStart !== undefined && boundsEnd !== undefined
        ? rollupSeries(report.series, boundsStart, boundsEnd)
        : [],
    [report, boundsStart, boundsEnd],
  );
  const granularity =
    boundsStart !== undefined &&
    boundsEnd !== undefined &&
    boundsEnd - boundsStart <= DAY_MS
      ? "hour"
      : "day";
  const rangeLabel =
    range === "all"
      ? "全部时间"
      : range === "custom"
        ? bounds
          ? `${customStart} 至 ${customEnd}`
          : "选择日期范围"
        : (RANGE_PRESETS.find((item) => item.key === range)?.label ?? "");
  const aggregate = useMemo(() => {
    const value = {
      requests: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      cost: new Map<string, bigint>(),
    };
    for (const bucket of buckets) {
      value.requests += bucket.requests;
      for (const part of Object.values(bucket.models)) {
        value.input += part.input;
        value.cacheRead += part.cacheRead;
        value.cacheWrite += part.cacheWrite;
        value.output += part.output;
      }
      for (const [currency, nanos] of Object.entries(bucket.cost))
        value.cost.set(currency, (value.cost.get(currency) ?? 0n) + nanos);
    }
    return value;
  }, [buckets]);
  const sessions = (report?.sessions ?? []).filter(
    (session) => session.requests,
  );
  const filtered = selection
    ? sessions.filter((session) =>
        (report?.sessionHours[session.sessionId] ?? []).some(
          (hour) => hour >= selection.start && hour < selection.end,
        ),
      )
    : sessions;
  const costDisplay =
    [...aggregate.cost.entries()]
      .map(([currency, nanos]) =>
        formatBillingMoney(currency, nanos.toString()),
      )
      .join(" · ") || (report?.unpricedRequests ? "部分未计价" : "—");
  return (
    <div className="single-feature">
      <header className="feature-header">
        <div>
          <span className="eyebrow">USAGE LEDGER</span>
          <h1>用量与费用</h1>
          <p>来自 Harness 会话投影的本地费用估算。</p>
        </div>
        <div className="horizontal-actions">
          <button onClick={() => window.desktop.checkBillingPrices()}>
            更新价格清单
          </button>
          <button
            className="primary"
            onClick={() => window.desktop.openLegacyBilling()}
          >
            管理价格规则
          </button>
        </div>
      </header>
      <div className="summary-grid">
        <Summary label="请求" value={String(aggregate.requests)} />
        <Summary
          label="输入 Token"
          value={compactTokens(
            aggregate.input + aggregate.cacheRead + aggregate.cacheWrite,
          )}
        />
        <Summary label="输出 Token" value={compactTokens(aggregate.output)} />
        <Summary
          label={rangeLabel ? `费用 · ${rangeLabel}` : "累计费用"}
          value={costDisplay}
        />
      </div>
      <section className="data-section usage-chart-section">
        <div className="section-heading">
          <h2>用量趋势</h2>
          <span>{rangeLabel}</span>
        </div>
        <div className="usage-chart-card">
          <div className="chart-toolbar">
            <div className="segmented" role="tablist" aria-label="时间范围">
              {RANGE_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  className={range === preset.key ? "active" : ""}
                  onClick={() => {
                    if (preset.key === "custom") {
                      openCustom();
                    } else {
                      setRange(preset.key);
                      setSelection(null);
                    }
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="segmented" role="tablist" aria-label="指标">
              {METRICS.map((item) => (
                <button
                  key={item.key}
                  className={metric === item.key ? "active" : ""}
                  onClick={() => setMetric(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          {customOpen && (
            <div
              className="custom-range-popover"
              role="dialog"
              aria-label="自定义日期范围"
            >
              <label>
                开始
                <input
                  type="date"
                  value={customStart}
                  max={customEnd || undefined}
                  onChange={(event) => setCustomStart(event.target.value)}
                />
              </label>
              <label>
                结束
                <input
                  type="date"
                  value={customEnd}
                  min={customStart || undefined}
                  onChange={(event) => setCustomEnd(event.target.value)}
                />
              </label>
              <div className="popover-actions">
                <button onClick={() => setCustomOpen(false)}>取消</button>
                <button
                  className="primary"
                  onClick={() => {
                    setCustomOpen(false);
                  }}
                >
                  应用
                </button>
              </div>
            </div>
          )}
          {buckets.length ? (
            <UsageChart
              buckets={buckets}
              granularity={granularity}
              metric={metric}
              selection={selection}
              onSelect={setSelection}
            />
          ) : (
            <div className="chart-empty">
              {!report || !report.series.length ? (
                <>
                  <b>还没有可绘制的用量数据</b>
                  <span>打开对话并发送消息后，这里会生成用量趋势图。</span>
                </>
              ) : (
                <>
                  <b>该范围没有用量记录</b>
                  <span>换个时间范围试试。</span>
                </>
              )}
            </div>
          )}
        </div>
      </section>
      <section className="data-section">
        <div className="section-heading">
          <h2>对话明细</h2>
          <div className="heading-actions">
            {selection && (
              <button
                className="filter-chip"
                onClick={() => setSelection(null)}
              >
                已筛 · {selection.label} ✕
              </button>
            )}
            <span>{filtered.length} 个对话</span>
          </div>
        </div>
        <div className="table">
          <div className="table-row table-head">
            <span>对话</span>
            <span>请求</span>
            <span>Token</span>
            <span>费用</span>
          </div>
          {filtered.map((session) => (
            <div className="table-row" key={session.sessionId}>
              <span>
                <b>{session.title}</b>
                <small>
                  {session.models.map((model) => model.model).join(" · ")}
                </small>
              </span>
              <span>{session.requests}</span>
              <span>
                {(
                  session.inputTokens +
                  session.cacheReadTokens +
                  session.cacheWriteTokens +
                  session.outputTokens
                ).toLocaleString()}
              </span>
              <span>
                {session.totals.map((item) => item.display).join(" · ") ||
                  "未定价"}
              </span>
            </div>
          ))}
          {!filtered.length && (
            <div className="table-row table-empty">
              <span>
                {sessions.length
                  ? "当前筛选下没有匹配的对话。"
                  : "还没有可汇总的用量，打开对话并发送消息后这里会按对话持续累计。"}
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

const emptyMapping = {
  imageArgument: "image",
  imageEncoding: "data-url" as const,
  questionArgument: "prompt",
  mimeTypeArgument: "mimeType",
  resultTextPath: null,
};
function directPreset(): VisionBackendConfig {
  return {
    id: crypto.randomUUID(),
    kind: "direct",
    name: "千问视觉",
    enabled: true,
    model: "qwen-vl-max",
    timeoutMs: 60_000,
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    credentialName: "DASHSCOPE_API_KEY",
    headers: {},
    headerCredentialNames: {},
  };
}
function mcpPreset(): McpVisionBackendConfig {
  return {
    id: crypto.randomUUID(),
    kind: "mcp",
    transport: "stdio",
    name: "本地视觉 MCP",
    enabled: true,
    model: "由 MCP 管理",
    timeoutMs: 60_000,
    command: "npx",
    args: [],
    cwd: "",
    env: {},
    envCredentialNames: {},
    allowLocalPath: false,
    toolName: "",
    mapping: emptyMapping,
  };
}

function VisionView({
  notify,
}: {
  notify: (message: string, error?: boolean) => void;
}) {
  const [settings, setSettings] = useState<VisionSettings | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [secret, setSecret] = useState("");
  const [image, setImage] = useState<string>("");
  const [mime, setMime] = useState("image/png");
  const [question, setQuestion] =
    useState("请描述图片中的界面、文字和重要细节。");
  const [result, setResult] = useState<VisionResult | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    window.desktop.getVisionSettings().then((value) => {
      setSettings(value);
      setSelectedId(value.defaultBackendId ?? value.backends[0]?.id ?? "");
    });
  }, []);
  const backend = settings?.backends.find((entry) => entry.id === selectedId);
  const patchBackend = (update: Partial<VisionBackendConfig>) =>
    setSettings((current) =>
      current
        ? {
            ...current,
            backends: current.backends.map((entry) =>
              entry.id === selectedId
                ? ({ ...entry, ...update } as VisionBackendConfig)
                : entry,
            ),
          }
        : current,
    );
  const save = async () => {
    if (!settings) return;
    try {
      const value = await window.desktop.setVisionSettings(settings);
      setSettings(value);
      notify("视觉服务设置已保存");
    } catch (error) {
      notify(String(error), true);
    }
  };
  const add = (value: VisionBackendConfig) => {
    setSettings((current) =>
      current
        ? {
            ...current,
            backends: [...current.backends, value],
            defaultBackendId: current.defaultBackendId ?? value.id,
          }
        : current,
    );
    setSelectedId(value.id);
  };
  const analyze = async () => {
    if (!image || !backend) return;
    const requestId = crypto.randomUUID();
    setBusy(true);
    setResult(null);
    try {
      setResult(
        await window.desktop.analyzeVision({
          requestId,
          backendId: backend.id,
          question,
          imageDataUrl: image,
          mimeType: mime,
        }),
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  };
  if (!settings)
    return <Empty title="正在载入视觉服务" detail="读取加密凭据与后端配置…" />;
  return (
    <div className="feature-layout vision-feature">
      <aside className="context-panel">
        <div className="panel-title">
          <div>
            <span className="eyebrow">VISION BRIDGE</span>
            <h2>视觉服务</h2>
          </div>
          <span className="count">{settings.backends.length}</span>
        </div>
        <div className="stack-actions">
          <button onClick={() => add(directPreset())}>＋ Direct API</button>
          <button onClick={() => add(mcpPreset())}>＋ MCP 服务</button>
        </div>
        <div className="backend-list">
          {settings.backends.map((item) => (
            <button
              key={item.id}
              className={item.id === selectedId ? "active" : ""}
              onClick={() => setSelectedId(item.id)}
            >
              <span className={`status ${item.enabled ? "online" : ""}`} />
              <span>
                <b>{item.name}</b>
                <small>
                  {item.kind === "direct"
                    ? "OpenAI-compatible"
                    : `${item.transport} · ${item.toolName || "未选工具"}`}
                </small>
              </span>
              {item.id === settings.defaultBackendId && <em>默认</em>}
            </button>
          ))}
        </div>
      </aside>
      <main className="stage scroll-stage">
        <div className="feature-header compact">
          <div>
            <span className="eyebrow">CONFIGURATION</span>
            <h1>{backend?.name ?? "添加一个视觉服务"}</h1>
            <p>纯文本主模型只接收视觉服务返回的文字结果。</p>
          </div>
          <div className="horizontal-actions">
            {backend && (
              <>
                <button
                  onClick={async () => {
                    try {
                      const tested =
                        await window.desktop.testVisionBackend(backend);
                      notify(
                        tested.tools
                          ? `连接成功，发现 ${tested.tools.length} 个工具`
                          : "视觉 API 连接成功",
                      );
                    } catch (error) {
                      notify(String(error), true);
                    }
                  }}
                >
                  测试连接
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    setSettings({
                      ...settings,
                      backends: settings.backends.filter(
                        (item) => item.id !== backend.id,
                      ),
                      defaultBackendId:
                        settings.defaultBackendId === backend.id
                          ? null
                          : settings.defaultBackendId,
                    });
                    setSelectedId("");
                  }}
                >
                  删除
                </button>
              </>
            )}
            <button className="primary" onClick={() => void save()}>
              保存设置
            </button>
          </div>
        </div>
        {backend ? (
          <div className="form-sections">
            <section className="form-section">
              <h3>基本信息</h3>
              <div className="form-grid">
                <Field label="名称">
                  <input
                    value={backend.name}
                    onChange={(e) => patchBackend({ name: e.target.value })}
                  />
                </Field>
                <Field label="模型">
                  <input
                    value={backend.model}
                    onChange={(e) => patchBackend({ model: e.target.value })}
                  />
                </Field>
                <Field label="超时（毫秒）">
                  <input
                    type="number"
                    value={backend.timeoutMs}
                    onChange={(e) =>
                      patchBackend({ timeoutMs: Number(e.target.value) })
                    }
                  />
                </Field>
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={backend.enabled}
                    onChange={(e) =>
                      patchBackend({ enabled: e.target.checked })
                    }
                  />
                  启用此服务
                </label>
              </div>
            </section>
            {backend.kind === "direct" ? (
              <section className="form-section">
                <h3>OpenAI-compatible API</h3>
                <div className="form-grid">
                  <Field label="Base URL">
                    <input
                      value={backend.baseUrl}
                      onChange={(e) =>
                        patchBackend({ baseUrl: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="凭据名称">
                    <input
                      value={backend.credentialName}
                      onChange={(e) =>
                        patchBackend({
                          credentialName: e.target.value.toUpperCase(),
                        })
                      }
                    />
                  </Field>
                  <Field label="保存密钥">
                    <div className="inline">
                      <input
                        type="password"
                        value={secret}
                        onChange={(e) => setSecret(e.target.value)}
                        placeholder="不会写入设置文件"
                      />
                      <button
                        onClick={async () => {
                          await window.desktop.setCredential(
                            backend.credentialName,
                            secret,
                          );
                          setSecret("");
                          notify("密钥已加密保存");
                        }}
                      >
                        保存
                      </button>
                    </div>
                  </Field>
                  <JsonRecordField
                    label="普通请求头（JSON）"
                    value={backend.headers}
                    onChange={(headers) => patchBackend({ headers })}
                  />
                  <JsonRecordField
                    label="请求头到凭据名称（JSON）"
                    value={backend.headerCredentialNames}
                    onChange={(headerCredentialNames) =>
                      patchBackend({ headerCredentialNames })
                    }
                  />
                </div>
              </section>
            ) : (
              <McpFields
                backend={backend}
                patchBackend={patchBackend}
                tools={tools}
                discover={async () => {
                  try {
                    const found =
                      await window.desktop.discoverVisionTools(backend);
                    setTools(found.map((item) => item.name));
                    notify(`发现 ${found.length} 个工具`);
                  } catch (error) {
                    notify(String(error), true);
                  }
                }}
              />
            )}
            <section className="form-section">
              <h3>默认策略</h3>
              <div className="form-grid">
                <Field label="桥接模式">
                  <select
                    value={settings.policy}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        policy: e.target.value as VisionSettings["policy"],
                      })
                    }
                  >
                    <option value="auto">自动（仅纯文本模型）</option>
                    <option value="always">总是解析</option>
                    <option value="off">关闭</option>
                  </select>
                </Field>
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={settings.defaultBackendId === backend.id}
                    onChange={() =>
                      setSettings({ ...settings, defaultBackendId: backend.id })
                    }
                  />
                  设为默认服务
                </label>
                <label className="check-field warning-check">
                  <input
                    type="checkbox"
                    checked={settings.remoteDisclosureAccepted}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        remoteDisclosureAccepted: e.target.checked,
                      })
                    }
                  />
                  我了解远程服务会接收所选图片
                </label>
              </div>
            </section>
          </div>
        ) : (
          <Empty
            title="还没有视觉服务"
            detail="添加 Direct API 或任意兼容的 MCP 服务。千问只是可选预设。"
          />
        )}
      </main>
      <aside className="inspector vision-test">
        <span className="eyebrow">LIVE TEST</span>
        <h3>发送前测试</h3>
        <p className="muted">图片解析失败时不会继续发送给主模型。</p>
        <label className="image-drop">
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setMime(file.type);
              const reader = new FileReader();
              reader.onload = () => setImage(String(reader.result));
              reader.readAsDataURL(file);
            }}
          />
          {image ? (
            <img src={image} />
          ) : (
            <span>
              选择测试图片
              <br />
              <small>最大 20 MB</small>
            </span>
          )}
        </label>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button
          className="primary wide-button"
          disabled={!image || !backend || busy}
          onClick={() => void analyze()}
        >
          {busy ? "正在解析…" : "使用当前服务解析"}
        </button>
        {result && (
          <div className="vision-result">
            <b>
              {result.backendName} · {result.durationMs} ms
              {result.cached ? " · 缓存" : ""}
            </b>
            <p>{result.text}</p>
          </div>
        )}
      </aside>
    </div>
  );
}

function McpFields({
  backend,
  patchBackend,
  tools,
  discover,
}: {
  backend: McpVisionBackendConfig;
  patchBackend: (value: Partial<VisionBackendConfig>) => void;
  tools: string[];
  discover: () => void;
}) {
  const patch = (value: Partial<McpVisionBackendConfig>) =>
    patchBackend(value as Partial<VisionBackendConfig>);
  return (
    <section className="form-section">
      <div className="section-heading">
        <h3>MCP 连接与映射</h3>
        <button onClick={discover}>发现工具</button>
      </div>
      <div className="form-grid">
        <Field label="传输">
          <select
            value={backend.transport}
            onChange={(e) =>
              patch(
                e.target.value === "stdio"
                  ? {
                      transport: "stdio",
                      command: "npx",
                      args: [],
                      cwd: "",
                      env: {},
                      envCredentialNames: {},
                      allowLocalPath: false,
                    }
                  : {
                      transport: "streamable-http",
                      url: "http://127.0.0.1:3000/mcp",
                      headers: {},
                      headerCredentialNames: {},
                    },
              )
            }
          >
            <option value="stdio">stdio</option>
            <option value="streamable-http">Streamable HTTP</option>
          </select>
        </Field>
        {backend.transport === "stdio" ? (
          <>
            <Field label="命令">
              <input
                value={backend.command}
                onChange={(e) => patch({ command: e.target.value })}
              />
            </Field>
            <Field label="参数（每行一个）">
              <textarea
                value={backend.args.join("\n")}
                onChange={(e) =>
                  patch({ args: e.target.value.split("\n").filter(Boolean) })
                }
              />
            </Field>
            <Field label="工作目录">
              <input
                value={backend.cwd}
                onChange={(e) => patch({ cwd: e.target.value })}
              />
            </Field>
            <JsonRecordField
              label="环境变量（JSON）"
              value={backend.env}
              onChange={(env) => patch({ env })}
            />
            <JsonRecordField
              label="环境变量到凭据名称（JSON）"
              value={backend.envCredentialNames}
              onChange={(envCredentialNames) => patch({ envCredentialNames })}
            />
          </>
        ) : (
          <>
            <Field label="MCP URL">
              <input
                value={backend.url}
                onChange={(e) => patch({ url: e.target.value })}
              />
            </Field>
            <JsonRecordField
              label="普通请求头（JSON）"
              value={backend.headers}
              onChange={(headers) => patch({ headers })}
            />
            <JsonRecordField
              label="请求头到凭据名称（JSON）"
              value={backend.headerCredentialNames}
              onChange={(headerCredentialNames) =>
                patch({ headerCredentialNames })
              }
            />
          </>
        )}
        <Field label="工具名称">
          <input
            list="mcp-tools"
            value={backend.toolName}
            onChange={(e) => patch({ toolName: e.target.value })}
          />
          <datalist id="mcp-tools">
            {tools.map((tool) => (
              <option key={tool}>{tool}</option>
            ))}
          </datalist>
        </Field>
        <Field label="图片参数">
          <input
            value={backend.mapping.imageArgument}
            onChange={(e) =>
              patch({
                mapping: { ...backend.mapping, imageArgument: e.target.value },
              })
            }
          />
        </Field>
        <Field label="图片格式">
          <select
            value={backend.mapping.imageEncoding}
            onChange={(e) =>
              patch({
                mapping: {
                  ...backend.mapping,
                  imageEncoding: e.target.value as
                    "data-url" | "base64" | "path",
                },
              })
            }
          >
            <option value="data-url">Data URL</option>
            <option value="base64">Base64</option>
            {backend.transport === "stdio" && (
              <option value="path">本机路径（需授权）</option>
            )}
          </select>
        </Field>
        <Field label="问题参数">
          <input
            value={backend.mapping.questionArgument ?? ""}
            onChange={(e) =>
              patch({
                mapping: {
                  ...backend.mapping,
                  questionArgument: e.target.value || null,
                },
              })
            }
          />
        </Field>
        <Field label="结果文字路径">
          <input
            value={backend.mapping.resultTextPath ?? ""}
            onChange={(e) =>
              patch({
                mapping: {
                  ...backend.mapping,
                  resultTextPath: e.target.value || null,
                },
              })
            }
            placeholder="例如 structuredContent.description"
          />
        </Field>
        {backend.transport === "stdio" &&
          backend.mapping.imageEncoding === "path" && (
            <label className="check-field warning-check">
              <input
                type="checkbox"
                checked={backend.allowLocalPath}
                onChange={(e) => patch({ allowLocalPath: e.target.checked })}
              />
              允许此本地进程读取图片绝对路径
            </label>
          )}
      </div>
    </section>
  );
}

function SettingsView({
  info,
  setInfo,
}: {
  info: DesktopInfo | null;
  setInfo: (info: DesktopInfo) => void;
}) {
  const [credentialName, setCredentialName] = useState("DEEPSEEK_API_KEY");
  const [credentialValue, setCredentialValue] = useState("");
  const [message, setMessage] = useState("");
  const act = async (task: () => Promise<unknown>, success: string) => {
    try {
      setMessage("处理中…");
      await task();
      setInfo(await window.desktop.getInfo());
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const themeLabel: Record<"light" | "dark" | "system", string> = {
    light: "浅色",
    dark: "深色",
    system: "跟随系统",
  };
  return (
    <div className="settings-page">
      <div className="settings-inner">
        <header className="settings-header">
          <h1>桌面设置</h1>
          <p>{info?.unofficialNotice}</p>
        </header>
        <section className="settings-group">
          <div className="settings-group-heading">
            <h2>外观</h2>
            <p>与 DeepSeek Harness 共用外观设置。</p>
          </div>
          <div className="appearance-grid" role="group" aria-label="外观">
            {(
              Object.keys(themeLabel) as Array<"light" | "dark" | "system">
            ).map((theme) => (
              <button
                className="theme-card"
                aria-pressed={info?.themePreference === theme}
                key={theme}
                onClick={() =>
                  void act(
                    () => window.desktop.setThemePreference(theme),
                    "外观已更新",
                  )
                }
              >
                <span className={`theme-preview preview-${theme}`}></span>
                <span className="theme-label">
                  <span>{themeLabel[theme]}</span>
                  <span className="selected-mark">✓</span>
                </span>
              </button>
            ))}
          </div>
        </section>
        <section className="settings-group">
          <div className="settings-group-heading">
            <h2>运行状态</h2>
          </div>
          <dl className="info-list">
            <div className="info-row">
              <dt>桌面版本</dt>
              <dd>{info?.appVersion ?? "—"}</dd>
            </div>
            <div className="info-row">
              <dt>Harness</dt>
              <dd>{`${info?.harness.version ?? "—"} · ${info?.harness.status ?? "—"}`}</dd>
            </div>
            <div className="info-row">
              <dt>当前对话工作区</dt>
              <dd>{info?.activeWorkspacePath ?? "未打开工作区对话"}</dd>
            </div>
            <div className="info-row">
              <dt>数据目录</dt>
              <dd className="mono">{info?.userDataPath ?? "—"}</dd>
            </div>
          </dl>
          <div className="settings-actions">
            <button
              onClick={() =>
                void act(
                  () => window.desktop.restartHarness(),
                  "Harness 已重启",
                )
              }
            >
              重启 Harness
            </button>
            <button
              onClick={() =>
                void act(() => window.desktop.openLogs(), "日志目录已打开")
              }
            >
              打开日志
            </button>
          </div>
        </section>
        <section className="settings-group">
          <div className="settings-group-heading">
            <h2>更新</h2>
            <p>桌面应用和经过兼容性验证的 Harness 运行时会作为整包发布。</p>
          </div>
          <div className="update-block">
            <h3>桌面应用</h3>
            <div className="settings-actions">
              <select
                value={info?.updateChannel ?? "stable"}
                onChange={(event) =>
                  void act(
                    () =>
                      window.desktop.setUpdateChannel(
                        event.target.value as "stable" | "beta",
                      ),
                    "更新通道已修改",
                  )
                }
                aria-label="更新通道"
              >
                <option value="stable">Stable</option>
                <option value="beta">Beta</option>
              </select>
              <button
                disabled={
                  !info?.update.configured || info.update.phase === "checking"
                }
                onClick={() =>
                  void act(
                    () => window.desktop.checkUpdate(),
                    "桌面更新检查完成",
                  )
                }
              >
                检查桌面更新
              </button>
              {info?.update.phase === "available" && (
                <button
                  onClick={() =>
                    void act(
                      () => window.desktop.downloadUpdate(),
                      "更新已下载",
                    )
                  }
                >
                  下载更新
                </button>
              )}
              {info?.update.phase === "ready" && (
                <button
                  className="primary"
                  onClick={() =>
                    void act(
                      () => window.desktop.installUpdate(),
                      "正在重启安装",
                    )
                  }
                >
                  安装更新
                </button>
              )}
            </div>
            <p className="update-note">
              桌面：
              {info?.update.configured
                ? info.update.phase
                : "开发构建未配置更新源"}
            </p>
          </div>
          <div className="update-block">
            <h3>DeepSeek Harness 运行时</h3>
            <div className="settings-actions">
              <button
                onClick={() =>
                  void act(
                    () => window.desktop.checkHarnessUpdate(),
                    "Harness 版本检查完成",
                  )
                }
              >
                检查 Harness 新版
              </button>
            </div>
            <p className="update-note">
              Harness：{info?.harnessUpdate.phase}
              {info?.harnessUpdate.latestVersion
                ? ` · 最新 ${info.harnessUpdate.latestVersion}`
                : ""}
            </p>
          </div>
        </section>
        <section className="settings-group">
          <div className="settings-group-heading">
            <h2>系统凭据</h2>
            <p>凭据由操作系统加密保存，不会回显或写入日志。</p>
          </div>
          <div className="settings-actions credential-line">
            <input
              value={credentialName}
              onChange={(event) =>
                setCredentialName(event.target.value.toUpperCase())
              }
              placeholder="VISION_API_KEY"
              aria-label="凭据名称"
            />
            <input
              type="password"
              value={credentialValue}
              onChange={(event) => setCredentialValue(event.target.value)}
              placeholder="API Key"
              aria-label="凭据值"
            />
            <button
              className="primary"
              onClick={() =>
                void act(async () => {
                  await window.desktop.setCredential(
                    credentialName,
                    credentialValue,
                  );
                  setCredentialValue("");
                }, "凭据已加密保存")
              }
            >
              保存
            </button>
            <button
              onClick={() =>
                void act(
                  () => window.desktop.removeCredential(credentialName),
                  "凭据已移除",
                )
              }
            >
              移除
            </button>
          </div>
        </section>
        <div className="settings-message" role="status" aria-live="polite">
          {message}
        </div>
      </div>
    </div>
  );
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty">
      <span>⌁</span>
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}
function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="summary">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function Field({
  label,
  children,
}: React.PropsWithChildren<{ label: string }>) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function JsonRecordField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
}) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setText(JSON.stringify(value, null, 2)), [value]);
  return (
    <Field label={label}>
      <textarea
        className={invalid ? "invalid" : ""}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          try {
            const parsed = JSON.parse(text) as unknown;
            if (
              !parsed ||
              Array.isArray(parsed) ||
              typeof parsed !== "object" ||
              Object.values(parsed).some((item) => typeof item !== "string")
            )
              throw new Error();
            onChange(parsed as Record<string, string>);
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
      />
    </Field>
  );
}

function App() {
  const query = new URLSearchParams(location.search);
  const popup = query.get("mode") === "popup";
  const initial = query.get("view") as View;
  const [view, setView] = useState<View>(() =>
    popup
      ? POPUP_VIEWS.has(initial)
        ? initial
        : "settings"
      : WORKBENCH_VIEWS.has(initial)
        ? initial
        : "changes",
  );
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  useTheme(info);
  useEffect(() => {
    window.desktop.getInfo().then(setInfo);
    const offInfo = window.desktop.onInfoChanged(setInfo);
    const offNav = popup
      ? undefined
      : window.desktop.onWorkbenchNavigate((next) => {
          if (WORKBENCH_VIEWS.has(next as View)) setView(next as View);
        });
    return () => {
      offInfo();
      offNav?.();
    };
  }, [popup]);
  const notify = useCallback((message: string, error = false) => {
    setToast({ message, error });
    setTimeout(() => setToast(null), 4200);
  }, []);
  const content = useMemo(
    () =>
      view === "changes" ? (
        <ChangesView
          notify={notify}
          workspacePath={info?.activeWorkspacePath ?? null}
        />
      ) : view === "billing" ? (
        <BillingView />
      ) : view === "vision" ? (
        <VisionView notify={notify} />
      ) : (
        <SettingsView info={info} setInfo={setInfo} />
      ),
    [view, info, notify],
  );
  const rail = (
    <nav className="activity-rail" aria-label="审阅与工具">
      {NAV_VIEWS.map((item) => (
        <button
          key={item.id}
          className={view === item.id ? "active" : ""}
          onClick={() => setView(item.id)}
          title={item.label}
          aria-label={item.label}
        >
          <span>{item.glyph}</span>
          <small>{item.label}</small>
        </button>
      ))}
      <div className="rail-spacer" />
      <button
        className="rail-action"
        onClick={() => void window.desktop.openBilling()}
        title="用量与费用"
        aria-label="用量与费用"
      >
        <span>¥</span>
        <small>用量</small>
      </button>
      <button
        className="rail-action"
        onClick={() => void window.desktop.openSettings()}
        title="桌面设置"
        aria-label="桌面设置"
      >
        <span>⚙</span>
        <small>设置</small>
      </button>
      <span
        className={`harness-led ${info?.harness.status === "ready" ? "ready" : ""}`}
        title={`Harness ${info?.harness.status ?? "starting"}`}
      />
    </nav>
  );
  return (
    <div className={`app-shell${popup ? " popup-shell" : ""}`}>
      {popup ? null : rail}
      <section className="workbench">{content}</section>
      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`} role="status">
          {toast.message}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
