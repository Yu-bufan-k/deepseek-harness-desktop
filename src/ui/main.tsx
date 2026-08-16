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
  AnalyticsRange,
  AnalyticsReport,
  ChangeBatch,
  DesktopInfo,
  FileDiff,
} from "../shared/contracts.js";
import type {
  QuotaPlan,
  QuotaSettings,
  QuotaSnapshot,
  QuotaWindow,
} from "../shared/quota.js";
import { DEFAULT_QUOTA_SETTINGS } from "../shared/quota.js";
import type { EChartsType } from "echarts/core";
import { editor } from "./monaco.js";
import {
  bucketLabel,
  compactTokens,
  DAY_MS,
  dayStart,
  HOUR_MS,
  modelLabel,
  providerOptions,
  rangeBounds,
  rollupSeries,
  sumModelTokens,
  toDateStr,
  type ChartBucket,
  type Metric,
  type RangeKey,
} from "./usage-series.js";
import "./styles.css";

type View = "changes" | "billing" | "settings" | "analytics";
const WORKBENCH_VIEWS = new Set<View>(["changes"]);
const POPUP_VIEWS = new Set<View>(["billing", "settings", "analytics"]);
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
            <div className="segmented" data-inline={inline ? "1" : "0"}>
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
              <span className="segmented-thumb" aria-hidden="true" />
            </div>
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

const quotaCountdown = (resetTime: string, now = Date.now()): string => {
  const diff = Date.parse(resetTime) - now;
  if (diff <= 0) return "即将重置";
  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${minutes}分`;
  if (minutes > 0) return `${minutes}分 ${seconds}秒`;
  return `${seconds}秒`;
};

function QuotaGauge({
  window,
  threshold,
  now,
}: {
  window: QuotaWindow;
  threshold: number;
  now: number;
}) {
  const usedPct =
    window.limit > 0
      ? Math.min(100, Math.round((window.used / window.limit) * 100))
      : 0;
  const state =
    window.remaining <= 0
      ? "exhausted"
      : window.limit > 0 && window.remaining / window.limit <= threshold
        ? "near-limit"
        : "ok";
  const foot =
    window.kind === "weekly" && window.resetTime
      ? `距重置 ${quotaCountdown(window.resetTime, now)}`
      : window.kind === "rolling"
        ? "滚动吞吐窗口，随请求推进自动恢复"
        : null;
  return (
    <div className={`quota-gauge state-${state}`}>
      <div className="quota-gauge-head">
        <span className="quota-gauge-label">{window.label}</span>
        <span className="quota-gauge-meta">
          {window.remaining > 0
            ? `剩 ${window.remaining} / ${window.limit} ${window.unit}`
            : `已用尽（${window.limit} ${window.unit}）`}
        </span>
      </div>
      <div
        className="quota-gauge-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usedPct}
        aria-label={`${window.label} 已用 ${usedPct}%`}
      >
        <div className="quota-gauge-fill" style={{ width: `${usedPct}%` }} />
      </div>
      <div className="quota-gauge-foot">{foot}</div>
    </div>
  );
}

function QuotaCard({
  plan,
  threshold,
  now,
}: {
  plan: QuotaPlan;
  threshold: number;
  now: number;
}) {
  return (
    <div className="quota-card">
      <div className="quota-card-head">
        <span className="quota-plan-name">{plan.planName ?? plan.provider}</span>
        <span className="quota-provider-tag">{plan.provider}</span>
      </div>
      <div className="quota-card-windows">
        {plan.windows.map((window) => (
          <QuotaGauge
            key={window.id}
            window={window}
            threshold={threshold}
            now={now}
          />
        ))}
      </div>
    </div>
  );
}

function QuotaSection() {
  const [snapshot, setSnapshot] = useState<QuotaSnapshot | null>(null);
  const [settings, setSettings] = useState<QuotaSettings | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const resetTriggeredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    window.desktop.getQuotaUsage().then(setSnapshot).catch(() => {});
    window.desktop.getQuotaSettings().then(setSettings).catch(() => {});
    return window.desktop.onQuotaUsageChanged((value) => {
      setSnapshot(value);
      setSelected((current) => {
        if (current && value.plans.some((plan) => plan.provider === current))
          return current;
        return value.plans[0]?.provider ?? null;
      });
    });
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      const timestamp = Date.now();
      setNow(timestamp);
      let crossed = false;
      for (const plan of snapshot?.plans ?? [])
        for (const window of plan.windows) {
          if (!window.resetTime) continue;
          const id = `${plan.provider}:${window.id}`;
          if (
            Date.parse(window.resetTime) <= timestamp &&
            !resetTriggeredRef.current.has(id)
          ) {
            resetTriggeredRef.current.add(id);
            crossed = true;
          }
        }
      if (crossed) void window.desktop.refreshQuotaUsage().catch(() => {});
    }, 1_000);
    return () => clearInterval(timer);
  }, [snapshot]);
  if (!snapshot) return null;
  const threshold = settings?.warningThreshold ?? 0.2;
  if (snapshot.plans.length) {
    const plan =
      snapshot.plans.find((item) => item.provider === selected) ??
      snapshot.plans[0]!;
    return (
      <section className="data-section quota-section">
        <div className="section-heading">
          <h2>配额监控</h2>
          <span>套餐限额，与费用独立</span>
        </div>
        <div className="segmented" role="tablist" aria-label="配额厂商">
          {snapshot.plans.map((item) => (
            <button
              key={item.provider}
              className={plan.provider === item.provider ? "active" : ""}
              onClick={() => setSelected(item.provider)}
            >
              {item.provider}
            </button>
          ))}
        </div>
        <QuotaCard plan={plan} threshold={threshold} now={now} />
      </section>
    );
  }
  if (snapshot.needsKey.length) {
    return (
      <section className="data-section quota-section">
        <div className="section-heading">
          <h2>配额监控</h2>
          <span>套餐限额，与费用独立</span>
        </div>
        <div className="quota-empty">
          <b>已启用 {snapshot.needsKey.join("、")} 配额监控，但未配置 API Key</b>
          <span>
            请在「设置 → 系统凭据」填入{" "}
            {snapshot.needsKey
              .map((provider) => `${provider.toUpperCase()}_API_KEY`)
              .join("、")}
            。
          </span>
        </div>
      </section>
    );
  }
  const errorEntries = Object.entries(snapshot.errors);
  if (errorEntries.length) {
    return (
      <section className="data-section quota-section">
        <div className="section-heading">
          <h2>配额监控</h2>
        </div>
        <div className="quota-empty">
          {errorEntries.map(([provider, message]) => (
            <span key={provider}>
              {provider}：{message}
            </span>
          ))}
        </div>
      </section>
    );
  }
  return null;
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
  const [routeFilter, setRouteFilter] = useState<string | null>(null);
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
  const providers = useMemo(
    () => providerOptions(report?.sessions ?? []),
    [report],
  );
  const route =
    routeFilter && providers.includes(routeFilter) ? routeFilter : null;
  const buckets = useMemo(
    () =>
      report && boundsStart !== undefined && boundsEnd !== undefined
        ? rollupSeries(report.series, boundsStart, boundsEnd, route)
        : [],
    [report, boundsStart, boundsEnd, route],
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
  const routeSessions = route
    ? sessions.filter((session) =>
        session.models.some((model) => model.provider === route),
      )
    : sessions;
  const filtered = selection
    ? routeSessions.filter((session) =>
        (report?.sessionHours[session.sessionId] ?? []).some(
          (hour) => hour >= selection.start && hour < selection.end,
        ),
      )
    : routeSessions;
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
      <QuotaSection />
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
            {providers.length > 1 && (
              <div className="segmented" role="tablist" aria-label="厂商">
                <button
                  className={route === null ? "active" : ""}
                  onClick={() => {
                    setRouteFilter(null);
                    setSelection(null);
                  }}
                >
                  全部
                </button>
                {providers.map((provider) => (
                  <button
                    key={provider}
                    className={route === provider ? "active" : ""}
                    onClick={() => {
                      setRouteFilter(provider);
                      setSelection(null);
                    }}
                  >
                    {provider}
                  </button>
                ))}
              </div>
            )}
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


const ANALYTICS_RANGES: Array<{ key: AnalyticsRange; label: string }> = [
  { key: "today", label: "今日" },
  { key: "7d", label: "近7天" },
  { key: "30d", label: "近30天" },
  { key: "all", label: "全部" },
];

function buildAnalyticsOption(raw: AnalyticsReport["series"]): ChartOption {
  const byDay = raw.length > 240;
  const map = new Map<number, { tokens: number; cost: number }>();
  for (const point of raw) {
    const key = byDay ? dayStart(point.time) : point.time;
    const row = map.get(key) ?? { tokens: 0, cost: 0 };
    row.tokens += point.tokens;
    row.cost += point.cost;
    map.set(key, row);
  }
  const points = [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, ...value }));
  const label = (time: number) =>
    byDay
      ? toDateStr(time).slice(5)
      : new Date(time).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
  return {
    grid: { left: 46, right: 54, top: 16, bottom: 26 },
    tooltip: { trigger: "axis" },
    xAxis: {
      type: "category",
      data: points.map((point) => label(point.time)),
      axisLine: { lineStyle: { color: cssVar("--wb-line", "#d9dde3") } },
      axisLabel: { color: cssVar("--wb-faint", "#889096"), fontSize: 10 },
    },
    yAxis: [
      {
        type: "value",
        name: "Token",
        axisLabel: { color: cssVar("--wb-faint", "#889096"), fontSize: 10 },
        splitLine: {
          lineStyle: { color: cssVar("--wb-line-soft", "#eceef1") },
        },
      },
      {
        type: "value",
        name: "¥",
        axisLabel: { color: "#9A8B63", fontSize: 10 },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: "Token",
        type: "line",
        smooth: true,
        symbol: "none",
        data: points.map((point) => point.tokens),
        lineStyle: { width: 1.5, color: "#6B7C8F" },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(107,124,143,0.22)" },
              { offset: 1, color: "rgba(107,124,143,0.02)" },
            ],
          },
        },
      },
      {
        name: "费用",
        type: "line",
        smooth: true,
        symbol: "none",
        yAxisIndex: 1,
        data: points.map((point) => point.cost / 1e9),
        lineStyle: { width: 1.5, color: "#9A8B63" },
      },
    ],
  };
}

function AnalyticsChart({ series }: { series: AnalyticsReport["series"] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const seriesRef = useRef(series);
  seriesRef.current = series;
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
      chart.setOption(buildAnalyticsOption(seriesRef.current));
      resizeObserver = new ResizeObserver(() => chart!.resize());
      resizeObserver.observe(el);
      themeObserver = new MutationObserver(() =>
        chart!.setOption(buildAnalyticsOption(seriesRef.current), true),
      );
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ["data-ds-dark-theme"],
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
    chartRef.current?.setOption(buildAnalyticsOption(series), true);
  }, [series]);
  return <div className="analytics-chart" ref={containerRef} />;
}

function AnalyticsView() {
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [range, setRange] = useState<AnalyticsRange>("7d");
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async (next: AnalyticsRange) => {
    setRefreshing(true);
    try {
      setReport(await window.desktop.getAnalytics(next));
    } catch {
      setReport(null);
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    void load(range);
  }, [range, load]);
  const vision = report?.vision;
  const errorCount = report?.kpi.errors ?? 0;
  return (
    <div className="analytics-shell">
      <header className="analytics-header">
        <h1>用量分析</h1>
        <div className="analytics-header-actions">
          <div className="analytics-range" data-range={range}>
            {ANALYTICS_RANGES.map((item) => (
              <button
                key={item.key}
                className={range === item.key ? "active" : ""}
                onClick={() => setRange(item.key)}
              >
                {item.label}
              </button>
            ))}
            <span className="analytics-range-thumb" aria-hidden="true" />
          </div>
          <button
            className="analytics-refresh"
            disabled={refreshing}
            onClick={() => void load(range)}
          >
            {refreshing ? "刷新中…" : "刷新"}
          </button>
        </div>
      </header>
      {!report ? (
        <div className="analytics-empty-state">正在聚合本地用量数据…</div>
      ) : (
        <>
          <div className="analytics-kpis">
            <div className="analytics-kpi is-money">
              <span>总费用</span>
              <strong>{report.kpi.costDisplay}</strong>
            </div>
            <div className="analytics-kpi">
              <span>Token 总计</span>
              <strong>{compactTokens(report.kpi.tokens)}</strong>
            </div>
            <div className="analytics-kpi">
              <span>请求次数</span>
              <strong>{report.kpi.requests}</strong>
            </div>
            <div
              className={`analytics-kpi ${
                errorCount > 0 ? "is-error" : "is-ok"
              }`}
            >
              <span>错误记录</span>
              <strong>{errorCount}</strong>
            </div>
          </div>
          <div className="analytics-body">
            <div className="analytics-main">
              <section className="analytics-section">
                <div className="analytics-section-title">Token 与费用趋势</div>
                <AnalyticsChart series={report.series} />
              </section>
              <section className="analytics-section">
                <div className="analytics-section-title">模型用量排行</div>
                <div className="analytics-model-list">
                  {report.models.length === 0 && (
                    <p className="analytics-empty">还没有模型用量记录。</p>
                  )}
                  {report.models.map((model) => (
                    <div className="analytics-model-row" key={model.key}>
                      <span
                        className="analytics-model-name"
                        title={`${model.provider} / ${model.label}`}
                      >
                        {model.label}
                      </span>
                      <span className="analytics-model-provider">
                        {model.provider}
                      </span>
                      <b>{compactTokens(model.tokens)}</b>
                      <strong>{model.costDisplay}</strong>
                    </div>
                  ))}
                </div>
              </section>
            </div>
            <div className="analytics-sub">
              <section className="analytics-section">
                <div className="analytics-section-title">视觉解析健康度</div>
                {vision && vision.requests > 0 ? (
                  <div className="analytics-vision">
                    <div className="analytics-vision-kpis">
                      <span>
                        <b>{vision.requests}</b> 请求
                      </span>
                      <span>
                        <b>{Math.round(vision.cacheRate * 100)}%</b> 缓存命中
                      </span>
                      <span>
                        <b>{Math.round(vision.avgDurationMs)}ms</b> 平均耗时
                      </span>
                      <span className={vision.errors > 0 ? "is-error" : ""}>
                        <b>{vision.errors}</b> 失败
                      </span>
                    </div>
                    <div className="analytics-backends">
                      {vision.backends.map((backend) => (
                        <div className="analytics-backend" key={backend.name}>
                          <i
                            className={
                              backend.errors > 0 ? "is-error" : "is-ok"
                            }
                            aria-hidden="true"
                          />
                          <span>{backend.name}</span>
                          <b>{backend.requests} 次</b>
                          {backend.errors > 0 && (
                            <small>{backend.errors} 失败</small>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="analytics-empty">没有视觉解析请求。</p>
                )}
              </section>
              <section className="analytics-section">
                <div className="analytics-section-title">工具使用 Top</div>
                <div className="analytics-tools">
                  {report.tools.length === 0 && (
                    <p className="analytics-empty">还没有工具调用记录。</p>
                  )}
                  {report.tools.map((tool) => (
                    <span
                      className={`analytics-toolchip kind-${tool.kind}`}
                      key={tool.kind + ":" + tool.name}
                    >
                      {tool.name}
                      <b>{tool.count}</b>
                    </span>
                  ))}
                </div>
              </section>
              <section className="analytics-section">
                <div className="analytics-section-title">错误记录</div>
                <div className="analytics-errors">
                  {report.errors.length === 0 && (
                    <p className="analytics-empty">这段时间没有错误。</p>
                  )}
                  {report.errors.map((error, index) => (
                    <div className="analytics-error" key={index}>
                      <span className="analytics-error-ts">
                        {new Date(error.ts).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <span className="analytics-error-type">{error.type}</span>
                      <small title={error.message}>{error.message}</small>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
        </>
      )}
    </div>
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
  const [quotaSettings, setQuotaSettings] = useState<QuotaSettings>(
    DEFAULT_QUOTA_SETTINGS,
  );
  useEffect(() => {
    window.desktop.getQuotaSettings().then(setQuotaSettings).catch(() => {});
  }, []);
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
  const persistQuota = (settings: QuotaSettings, success: string) =>
    void act(async () => {
      const updated = await window.desktop.setQuotaSettings(settings);
      setQuotaSettings(updated);
    }, success);
  return (
    <div className="settings-page">
      <div className="settings-inner">
        <header className="settings-header">
          <h1>桌面设置</h1>
          <p>{info?.unofficialNotice}</p>
        </header>
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
        <section className="settings-group">
          <div className="settings-group-heading">
            <h2>配额监控</h2>
            <p>
              套餐厂商限额提醒，与费用独立。Kimi 的 key 在下方「系统凭据」填{" "}
              KIMI_API_KEY。
            </p>
          </div>
          <div className="quota-settings-row">
            <span>启用配额监控</span>
            <button
              className={quotaSettings.enabled ? "switch-on" : ""}
              aria-pressed={quotaSettings.enabled}
              onClick={() =>
                persistQuota(
                  { ...quotaSettings, enabled: !quotaSettings.enabled },
                  quotaSettings.enabled ? "配额监控已停用" : "配额监控已启用",
                )
              }
            >
              {quotaSettings.enabled ? "已开启" : "已关闭"}
            </button>
          </div>
          <div className="quota-settings-grid">
            <label className="field">
              <span>轮询间隔</span>
              <select
                value={quotaSettings.pollIntervalMinutes}
                onChange={(event) =>
                  persistQuota(
                    {
                      ...quotaSettings,
                      pollIntervalMinutes: Number(event.target.value),
                    },
                    "轮询间隔已更新",
                  )
                }
              >
                <option value={15}>15 分钟</option>
                <option value={30}>30 分钟</option>
                <option value={60}>60 分钟</option>
              </select>
            </label>
            <label className="field">
              <span>预警阈值</span>
              <select
                value={quotaSettings.warningThreshold}
                onChange={(event) =>
                  persistQuota(
                    {
                      ...quotaSettings,
                      warningThreshold: Number(event.target.value),
                    },
                    "预警阈值已更新",
                  )
                }
              >
                <option value={0.2}>用到 80%</option>
                <option value={0.1}>用到 90%</option>
                <option value={0.05}>用到 95%</option>
              </select>
            </label>
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
  useEffect(() => {
    const titles: Record<View, string> = {
      changes: "代码变更",
      billing: "用量与费用",
      analytics: "用量分析",
      settings: "桌面设置",
    };
    document.title = `${titles[view]} · DeepSeek Harness Desktop`;
  }, [view]);
  const content = useMemo(
    () =>
      view === "changes" ? (
        <ChangesView
          notify={notify}
          workspacePath={info?.activeWorkspacePath ?? null}
        />
      ) : view === "billing" ? (
        <BillingView />
      ) : view === "analytics" ? (
        <AnalyticsView />
      ) : (
        <SettingsView info={info} setInfo={setInfo} />
      ),
    [view, info, notify],
  );
  return (
    <div className={`app-shell${popup ? " popup-shell" : ""}`}>
      {popup ? null : (
        <header className="workbench-header">
          <div className="workbench-title">
            <strong>代码变更</strong>
            <small title={info?.activeWorkspacePath ?? undefined}>
              {info?.activeWorkspacePath ?? "未打开工作区"}
            </small>
          </div>
          <span
            className={`harness-led ${info?.harness.status === "ready" ? "ready" : ""}`}
            title={`Harness ${info?.harness.status ?? "starting"}`}
          />
        </header>
      )}
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
