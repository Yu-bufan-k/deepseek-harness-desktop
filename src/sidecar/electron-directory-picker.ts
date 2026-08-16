import { DirectoryPicker } from "@deepseek-ai/dsh-host-directory-picker";

const CLIENT_PLUGIN_ID = "deepseek-harness-desktop-integration";
const CLIENT_PLUGIN_PATH = "/desktop-integration/client.js";
const CLIENT_PLUGIN_SOURCE = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(CLIENT_PLUGIN_ID)},
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const READY = "desktop:harness-integration-ready";
    const OPEN = "desktop:open-workspace";
    const RESULT = "desktop:open-workspace-result";
    const React = require("react");
    const inject = ["workspaces", "sessions", "slots", "modelDirectories"];
    const projectionOf = (value) => {
      if (value && Array.isArray(value.samples) && typeof value.revision === "string") return value;
      const samples = Array.isArray(value) ? value : [];
      const last = samples[samples.length - 1];
      return { revision: "legacy:" + samples.length + ":" + (last ? JSON.stringify(last) : "empty"), samples };
    };
    const compactTokens = (value) => value >= 1e6 ? (value / 1e6).toFixed(1) + "M" : value >= 1e3 ? (value / 1e3).toFixed(value >= 1e4 ? 0 : 1) + "K" : String(value);
    const findComposerInput = () => [...document.querySelectorAll("textarea,[contenteditable='true']")]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width >= 240 && rect.height > 0 && rect.bottom > window.innerHeight * .62)
      .sort((left, right) => right.rect.width - left.rect.width)[0]?.element ?? null;
    const composerText = (element) => element ? ("value" in element ? element.value : element.textContent || "") : "";
    const setComposerText = (element, value) => {
      if (!element) return false;
      if ("value" in element) {
        const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        setter ? setter.call(element, value) : element.value = value;
      } else element.textContent = value;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      element.focus();
      return true;
    };
    // 在光标处插入文本（不清空已有内容）：textarea/input 用 selectionStart，contenteditable 用当前选区。
    const insertComposerText = (element, text) => {
      if (!element) return false;
      if ("value" in element) {
        const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        const start = element.selectionStart ?? element.value.length;
        const end = element.selectionEnd ?? element.value.length;
        const value = element.value.slice(0, start) + text + element.value.slice(end);
        setter ? setter.call(element, value) : element.value = value;
        element.setSelectionRange(start + text.length, start + text.length);
      } else {
        const selection = document.getSelection();
        const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
        if (range) {
          range.deleteContents();
          range.insertNode(document.createTextNode(text));
          range.collapse(false);
        } else element.textContent = (element.textContent || "") + text;
      }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      element.focus();
      return true;
    };
    // 视觉策略内存缓存：图片粘贴/拖放需在事件派发内同步判定并 preventDefault，
    // 异步 IPC 判定会错过 preventDefault 时机，导致图片仍被浏览器默认行为插入。
    // 初始保守取 "auto"（拦截优先）；apply 后立即刷新，VisionCard 保存设置也会更新。
    let visionPolicy = "auto";
    const refreshVisionPolicy = () => {
      window.desktop?.getVisionSettings?.().then((value) => { if (value) visionPolicy = value.policy; }).catch(() => {});
    };
    refreshVisionPolicy();
    // 当前模型能力缓存：auto 模式只在「主模型不支持图片」时拦截（纯文本模型的
    // 兜底方案）；主模型支持图片时放行，走宿主原生附件路径（预览、删除、发送带
    // 图，模型直接看图）。capable 三态：true=支持图片 / false=不支持 / null=未知。
    // provider/model 由 UsageMeter 组件上报（当前会话模型），capable 经宿主的
    // llm 服务 resolveModelInfo 查询 inputModalities。llm 不可用时保持 null，
    // 拦截判定按「未知即拦截」处理（纯文本优先，保证核心场景稳定）。
    const currentModelRef = { provider: null, model: null, capable: null };
    const refreshModelCapability = async () => {
      const { provider, model } = currentModelRef;
      if (!provider || !model) return;
      try {
        const llm = ctx.get?.("llm");
        if (!llm || typeof llm.resolveModelInfo !== "function") { currentModelRef.capable = null; return; }
        const active = await llm.resolveModelInfo(provider, model, undefined);
        currentModelRef.capable = Array.isArray(active?.inputModalities) && active.inputModalities.includes("image");
      } catch { currentModelRef.capable = null; }
    };
    let noticeTimer = 0;
    const desktopNotify = (message, phase = "info", persistent = false) => {
      let node = document.getElementById("dsh-desktop-notice");
      if (!node) { node = document.createElement("div"); node.id = "dsh-desktop-notice"; node.className = "dsh-desktop-notice"; node.setAttribute("role", "status"); node.setAttribute("aria-live", "polite"); document.body.appendChild(node); }
      clearTimeout(noticeTimer); node.textContent = message; node.dataset.phase = phase; node.classList.add("show");
      if (!persistent) noticeTimer = window.setTimeout(() => node.classList.remove("show"), phase === "error" ? 4200 : 2600);
    };
    // 会话状态红绿灯（渲染在会话信息面板 header 下方）：三盏灯常驻（红黄绿），
    // 当前状态亮对应灯。判定：working —— 会话容器内持续有 DOM 变化（agent 流式
    // 生成必然渲染消息，排除我们自己的 dsh-* 节点防自触发），2 秒无变化即空闲；
    // failed —— 主进程内存错误缓存（getRecentErrors，60s 内）。状态机：
    // working(黄·处理中) > failed(红·需要关注) > idle(绿·状态良好)。
    function UsageMeter({ useProjection, modelDirectory, sessionsList, workspacesList, sessionId }) {
      const currentProjection = projectionOf(useProjection("billingUsage"));
      const usage = currentProjection.samples;
      const modelState = React.useSyncExternalStore(
        (listener) => modelDirectory.subscribe(listener),
        () => modelDirectory.getSnapshot()
      );
      const sessionsState = React.useSyncExternalStore(
        (listener) => sessionsList.subscribe(listener),
        () => sessionsList.getSnapshot()
      );
      const workspacesState = React.useSyncExternalStore(
        (listener) => workspacesList.subscribe(listener),
        () => workspacesList.getSnapshot()
      );
      const [report, setReport] = React.useState(null);
      const [balance, setBalance] = React.useState(null);
      const [billingRevision, setBillingRevision] = React.useState(0);
      const [clockRevision, setClockRevision] = React.useState(0);
      const [wide, setWide] = React.useState(false);
      const [open, setOpen] = React.useState(false);
      const [detail, setDetail] = React.useState(null);
      const rootRef = React.useRef(null);
      const sentRevisionsRef = React.useRef(new Map());
      const warnedBalanceRef = React.useRef("");
      const warnedQuotaRef = React.useRef(new Set());
      const activeBatchRef = React.useRef(null);
      const creatingBatchRef = React.useRef(false);
      const closeBatchTimerRef = React.useRef(0);
      const selected = modelState?.current ?? usage[usage.length - 1] ?? null;
      const activeWorkspace = workspacesState.items?.find((workspace) => workspace.sessionIds?.includes(sessionId)) ?? null;
      React.useEffect(() => {
        window.desktop?.setActiveWorkspaceContext?.(sessionId, activeWorkspace?.path ?? null).catch(() => {});
      }, [sessionId, activeWorkspace?.path]);
      React.useEffect(() => {
        if (!selected?.provider || !selected?.model) return;
        currentModelRef.provider = selected.provider;
        currentModelRef.model = selected.model;
        void refreshModelCapability();
      }, [selected?.provider, selected?.model]);
      React.useEffect(() => window.desktop?.onBillingChanged(() => setBillingRevision((value) => value + 1)), []);
      React.useEffect(() => { const timer = setInterval(() => setClockRevision((value) => value + 1), 60_000); return () => clearInterval(timer); }, []);
      React.useEffect(() => {
        const begin = () => {
          if (activeBatchRef.current || creatingBatchRef.current || !window.desktop?.createChangeBatch) return;
          const input = findComposerInput();
          const title = composerText(input).trim().slice(0, 80);
          if (!title) return;
          creatingBatchRef.current = true;
          window.desktop.createChangeBatch(title).then((batch) => { activeBatchRef.current = batch.id; }).catch(() => {}).finally(() => { creatingBatchRef.current = false; });
        };
        const onKeyDown = (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing && findComposerInput()?.contains(event.target)) begin(); };
        const onPointerDown = (event) => {
          const input = findComposerInput(); if (!input) return;
          const button = event.target?.closest?.("button");
          const label = (button?.getAttribute("aria-label") || button?.title || button?.textContent || "").toLowerCase();
          if (button && button.getBoundingClientRect().bottom > window.innerHeight * .62 && (button.type === "submit" || /send|发送|提交/.test(label))) begin();
        };
        document.addEventListener("keydown", onKeyDown, true); document.addEventListener("pointerdown", onPointerDown, true);
        return () => { document.removeEventListener("keydown", onKeyDown, true); document.removeEventListener("pointerdown", onPointerDown, true); };
      }, []);
      React.useEffect(() => {
        if (!activeBatchRef.current || currentProjection.revision.startsWith("legacy:0:")) return;
        clearTimeout(closeBatchTimerRef.current);
        closeBatchTimerRef.current = window.setTimeout(() => {
          const id = activeBatchRef.current; if (!id) return;
          window.desktop.closeChangeBatch(id).then(() => { if (activeBatchRef.current === id) activeBatchRef.current = null; }).catch(() => {});
        }, 6000);
        return () => clearTimeout(closeBatchTimerRef.current);
      }, [currentProjection.revision]);
      React.useEffect(() => {
        let alive = true;
        window.desktop?.getDeepSeekBalance().then((value) => {
          if (!alive) return;
          setBalance(value);
          const warnings = value.balances.filter((entry) => entry.warning);
          const signature = warnings.map((entry) => entry.currency + ":" + entry.totalBalance + ":" + entry.warningThreshold).join("|");
          if (signature && signature !== warnedBalanceRef.current) desktopNotify(warnings.map((entry) => entry.currency + " 余额 " + entry.totalDisplay + "，已达到预警值").join("；"), "warning");
          warnedBalanceRef.current = signature;
        }).catch(() => {});
        return () => { alive = false; };
      }, [billingRevision, clockRevision]);
      React.useEffect(() => {
        if (!window.desktop?.onQuotaUsageChanged) return;
        return window.desktop.onQuotaUsageChanged((value) => {
          const active = new Set();
          for (const warning of value.warnings ?? []) {
            const key = warning.provider + ":" + warning.windowId + ":" + warning.kind;
            active.add(key);
            if (warnedQuotaRef.current.has(key)) continue;
            warnedQuotaRef.current.add(key);
            const plan = value.plans?.find((item) => item.provider === warning.provider);
            const windowLabel = plan?.windows?.find((item) => item.id === warning.windowId)?.label ?? warning.windowId;
            desktopNotify(
              warning.kind === "exhausted"
                ? warning.provider + "「" + windowLabel + "」配额已用尽"
                : warning.provider + "「" + windowLabel + "」配额即将用尽（剩 " + warning.remaining + "/" + warning.limit + "）",
              "warning",
            );
          }
          for (const key of warnedQuotaRef.current) if (!active.has(key)) warnedQuotaRef.current.delete(key);
        });
      }, []);
      React.useEffect(() => {
        const allSessions = (sessionsState.ids ?? []).map((id) => {
          const summary = sessionsState.byId?.[id] ?? {};
          const projected = id === sessionId ? currentProjection : projectionOf(summary.projectionValues?.billingUsage);
          return {
            sessionId: id,
            title: summary.displayTitle || summary.title || "未命名对话",
            revision: projected.revision,
            samples: projected.samples,
            tools: projected.tools
          };
        });
        if (sessionId && !allSessions.some((session) => session.sessionId === sessionId)) {
          allSessions.push({ sessionId, title: "当前对话", revision: currentProjection.revision, samples: usage, tools: currentProjection.tools });
        }
        const droppedSessions = Math.max(0, allSessions.length - 10_000);
        const sessions = allSessions.slice(-10_000);
        const sessionIds = sessions.map((session) => session.sessionId);
        const changed = sessions.filter((session) => sentRevisionsRef.current.get(session.sessionId) !== session.revision + "\u0000" + session.title);
        let alive = true;
        const target = selected?.provider && selected?.model ? { provider: selected.provider, model: selected.model } : undefined;
        const timer = setTimeout(() => window.desktop?.reportBillingUsage({ collectedAt: new Date().toISOString(), sessionIds, sessions: changed, droppedSessions }, target)
          .then((value) => {
            if (!alive) return;
            const active = new Set(sessionIds);
            for (const id of sentRevisionsRef.current.keys()) if (!active.has(id)) sentRevisionsRef.current.delete(id);
            for (const session of changed) sentRevisionsRef.current.set(session.sessionId, session.revision + "\u0000" + session.title);
            setReport(value);
          })
          .catch((error) => { if (alive) setReport({ error: error instanceof Error ? error.message : String(error) }); }), 75);
        return () => { alive = false; clearTimeout(timer); };
      }, [sessionsState, sessionId, currentProjection.revision, selected?.provider, selected?.model, billingRevision, clockRevision]);
      React.useEffect(() => {
        let frame = 0;
        let lastFit = null;
        const findComposerBoundary = () => {
          const candidates = [...document.querySelectorAll("textarea,[contenteditable='true'],input[placeholder]")]
            .map((element) => ({ element, rect: element.getBoundingClientRect() }))
            .filter(({ rect }) => rect.width >= 240 && rect.height > 0 && rect.bottom > window.innerHeight * .62 && rect.top < window.innerHeight)
            .sort((left, right) => right.rect.width - left.rect.width);
          if (!candidates[0]) return null;
          let boundary = candidates[0].element;
          let node = boundary.parentElement;
          for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
            const rect = node.getBoundingClientRect();
            if (rect.width > 1000 || rect.width < 240 || rect.bottom < window.innerHeight * .62) break;
            boundary = node;
          }
          return boundary.getBoundingClientRect();
        };
        const measure = () => {
          frame = 0;
          const composer = findComposerBoundary();
          const available = composer ? window.innerWidth - composer.right : 0;
          const fits = composer ? window.innerWidth >= 1100 && available >= 352 : window.innerWidth >= 1560;
          if (fits === lastFit) return;
          lastFit = fits;
          setWide(fits);
          setOpen(fits);
          setDetail(null);
        };
        const schedule = () => { if (!frame) frame = window.requestAnimationFrame(measure); };
        const resize = new ResizeObserver(schedule);
        resize.observe(document.documentElement);
        const mutations = new MutationObserver(schedule);
        mutations.observe(document.body, { childList: true, subtree: true });
        window.addEventListener("resize", schedule);
        schedule();
        return () => { if (frame) window.cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect(); window.removeEventListener("resize", schedule); };
      }, []);
      React.useEffect(() => {
        if (!open) return;
        const close = (event) => { if (!rootRef.current?.contains(event.target)) { setDetail(null); if (!wide) setOpen(false); } };
        const escape = (event) => { if (event.key === "Escape") { if (detail) setDetail(null); else setOpen(false); } };
        document.addEventListener("pointerdown", close);
        document.addEventListener("keydown", escape);
        return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
      }, [open, wide, detail]);
      const h = React.createElement;
      if (!report || report.error) return report?.error ? h("span", { className: "dsh-cost-sync-error", title: report.error }, "费用同步失败") : null;
      const session = report.sessions.find((item) => item.sessionId === sessionId) ?? { requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, unpricedRequests: 0, totals: [], models: [] };
      const sessionTools = (() => {
        const tools = session.tools;
        if (!tools) return { tools: [], mcp: [], skills: [] };
        const collect = (record) => Object.keys(record)
          .map((name) => ({ key: name, label: name, count: record[name] ?? 0 }))
          .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
        return { tools: collect(tools.tools), mcp: collect(tools.mcp), skills: collect(tools.skills) };
      })();
      const toolChip = (chip, tone) => h("span", { className: "dsh-sess-toolchip" + (tone ? " is-" + tone : ""), key: chip.key, title: chip.label + " · " + chip.count + " 次" }, chip.label, h("b", null, chip.count));
      const toolGroup = (kindLabel, chips, tone) => chips.length > 0 && h("div", { className: "dsh-sess-toolgroup" + (tone ? " is-" + tone : "") }, h("div", { className: "dsh-sess-toolgroup-head" }, h("i", { className: "dsh-sess-tool-dot", "aria-hidden": "true" }), h("span", null, kindLabel), h("b", null, chips.length)), h("div", { className: "dsh-sess-toolchips" }, chips.slice(0, 8).map((chip) => toolChip(chip, tone))));
      const totals = session.totals;
      const models = new Map(session.models.map((model) => {
        const key = JSON.stringify([model.provider, model.model]);
        return [key, { ...model, key, input: model.inputTokens + model.cacheReadTokens + model.cacheWriteTokens, cache: model.cacheReadTokens + model.cacheWriteTokens, output: model.outputTokens, unknown: model.unpricedRequests, pricing: model.currentPricing, officialPricing: model.officialPricing, rule: model.currentPricing?.rule ?? null }];
      }));
      const unknown = session.unpricedRequests, inputTokens = session.inputTokens + session.cacheReadTokens + session.cacheWriteTokens, outputTokens = session.outputTokens;
      const summary = totals.map(({ display }) => display).join(" + ");
      const label = summary || (unknown ? "未计价" : "¥0.0000");
      const currentKey = selected?.provider && selected?.model ? JSON.stringify([selected.provider, selected.model]) : null;
      if (currentKey && !models.has(currentKey)) {
        models.set(currentKey, { key: currentKey, provider: selected.provider, model: selected.model, requests: 0, input: 0, cache: 0, output: 0, unknown: 0, totals: [], pricing: report.currentTarget?.pricing ?? null, officialPricing: report.currentTarget?.officialPricing ?? null, rule: report.currentTarget?.pricing?.rule ?? null });
      }
      const current = currentKey ? models.get(currentKey) : null;
      const previous = [...models.values()].filter((model) => model.key !== currentKey).reverse();
      const orderedModels = current ? [current, ...previous] : previous;
      const detailModel = detail ? models.get(detail.key) : null;
      const modelAmount = (model) => model.totals.map(({ display }) => display).join(" + ") || (model.unknown || !model.rule ? "未配置价格" : "¥0.0000");
      const ruleSummary = (pricing) => {
        if (!pricing) return "尚未匹配价格规则";
        const rates = pricing.rates;
        return pricing.rule.currency + "/百万 Token · " + (pricing.scheduleLabel ? (pricing.isPeak ? "当前高峰价 · " : "当前空闲价 · ") : "") + "输入 " + rates.input + " · 缓存读取 " + rates.cacheRead + " · 缓存写入 " + rates.cacheWrite + " · 输出 " + rates.output;
      };
      const balanceRows = balance?.balances?.map((entry) => h("div", { className: "dsh-sess-balance-row" + (entry.warning ? " is-warning" : ""), key: entry.currency },
        h("i", { className: "dsh-sess-dot" + (entry.warning ? " is-warning" : " is-active"), "aria-hidden": "true" }),
        h("span", null, entry.currency + " 账户余额"), h("strong", null, entry.totalDisplay),
        entry.warning && h("small", null, "低于预警值 " + entry.warningThresholdDisplay))) ?? [];
      // Token 累计迷你面积图：取最近样本的累计 token 序列，SVG 手绘（无图表库依赖）。
      const spark = (() => {
        const samples = usage;
        if (!Array.isArray(samples) || samples.length < 2) return null;
        const W = 268, H = 40, P = 3;
        let acc = 0;
        const points = samples.slice(-48).map((sample) => {
          acc += sample.uncachedInputTokens + sample.cacheReadTokens + sample.cacheWriteTokens + sample.outputTokens;
          return { time: sample.time, tokens: acc };
        });
        const t0 = points[0].time, t1 = points[points.length - 1].time;
        const span = Math.max(1, t1 - t0);
        const max = Math.max(1, ...points.map((point) => point.tokens));
        const x = (point) => P + (point.time - t0) / span * (W - P * 2);
        const y = (point) => H - P - point.tokens / max * (H - P * 2);
        const line = points.map((point, index) => (index ? "L" : "M") + x(point).toFixed(1) + " " + y(point).toFixed(1)).join(" ");
        const last = points[points.length - 1];
        const area = line + " L" + x(last).toFixed(1) + " " + (H - P) + " L" + x(points[0]).toFixed(1) + " " + (H - P) + " Z";
        return { line, area, W, H };
      })();
      const openModelDetail = (event, model) => {
        const top = Math.min(Math.max(12, event.currentTarget.getBoundingClientRect().top - 8), Math.max(12, window.innerHeight - 356));
        setDetail(detail?.key === model.key ? null : { key: model.key, top });
      };
      const modelRow = (model) => h("button", {
        type: "button", className: "dsh-sess-model-row" + (model.key === currentKey ? " is-current" : "") + (!model.rule ? " is-unpriced" : ""), key: model.key,
        "aria-expanded": detail?.key === model.key, "aria-label": model.model + " 用量详情", onClick: (event) => openModelDetail(event, model)
      }, h("i", { className: "dsh-sess-row-dot" + (model.key === currentKey ? " is-current" : ""), "aria-hidden": "true" }),
        h("span", { className: "dsh-sess-row-name", title: model.provider + "/" + model.model }, model.model),
        h("strong", null, modelAmount(model)));
      const currentModelLabel = selected?.label || selected?.displayName || selected?.name || selected?.model || "尚未选择";
      return h("div", { className: "dsh-cost-meter", ref: rootRef, "data-open": open ? "true" : "false", "data-wide": wide ? "true" : "false" },
        h("button", { type: "button", className: "dsh-cost-trigger", "aria-expanded": open, "aria-label": "查看会话信息", onClick: () => setOpen(!open) },
          h("span", { className: "dsh-cost-symbol", "aria-hidden": "true" }, "¥"),
          h("span", { className: "dsh-cost-label" }, "本会话 " + label),
          h("span", { className: "dsh-cost-chevron", "aria-hidden": "true" }, open ? "▴" : "▾")),
        open && !wide && h("button", { type: "button", className: "dsh-cost-backdrop", "aria-label": "关闭会话信息", onClick: () => setOpen(false) }),
        open && h("aside", { className: "dsh-cost-panel", "aria-label": "会话信息" },
          h("header", { className: "dsh-sess-head" },
            h("div", null, h("strong", null, "会话信息"), h("small", null, "当前对话 · 本地状态")),
            h("button", { type: "button", className: "dsh-sess-close", "aria-label": "关闭会话信息", onClick: () => { setDetail(null); setOpen(false); } }, "×")),
          h("div", { className: "dsh-sess-status" },
            h("i", { className: "dsh-sess-dot" + (session.requests > 0 ? " is-active" : ""), "aria-hidden": "true" }),
            h("strong", { title: currentModelLabel }, currentModelLabel),
            h("small", null, session.requests > 0 ? session.requests + " 次请求 · 输入 " + compactTokens(inputTokens) + " · 输出 " + compactTokens(outputTokens) : "尚无请求")),
          h("div", { className: "dsh-sess-kpis" },
            h("div", { className: "dsh-sess-kpi is-money" }, h("span", null, "预估费用"), h("strong", null, label)),
            h("div", { className: "dsh-sess-kpi" }, h("span", null, "Token 总计"), h("strong", null, compactTokens(inputTokens + outputTokens))),
            h("div", { className: "dsh-sess-kpi" }, h("span", null, "请求次数"), h("strong", null, session.requests)),
            h("div", { className: "dsh-sess-kpi" }, h("span", null, "模型数量"), h("strong", null, orderedModels.length))),
          spark && h("div", { className: "dsh-sess-section" },
            h("div", { className: "dsh-sess-section-title" }, "Token 消耗"),
            h("figure", { className: "dsh-sess-spark", "aria-label": "Token 消耗趋势" },
              h("svg", { viewBox: "0 0 " + spark.W + " " + spark.H, "aria-hidden": "true" },
                h("path", { className: "dsh-sess-spark-area", d: spark.area }),
                h("path", { className: "dsh-sess-spark-line", d: spark.line })))),
          h("div", { className: "dsh-sess-section" },
            h("div", { className: "dsh-sess-section-title" }, "用量与费用"),
            balanceRows.length > 0 && h("div", { className: "dsh-sess-balances" }, balanceRows),
            orderedModels.length > 0 && h("div", { className: "dsh-sess-model-list" }, orderedModels.map(modelRow)),
            unknown > 0 && h("p", { className: "dsh-sess-warning" }, unknown + " 次请求未配置价格，金额暂未计入。"),
            report.warnings?.map((warning) => h("p", { className: "dsh-sess-warning", key: warning }, warning)),
            usage.length === 0 && h("div", { className: "dsh-sess-empty" }, h("strong", null, "还没有模型用量"), h("span", null, "发送消息后，这里会按模型记录 Token 与预估费用。"))),
          sessionTools.tools.length + sessionTools.mcp.length + sessionTools.skills.length > 0 && h("div", { className: "dsh-sess-section" },
            h("div", { className: "dsh-sess-section-title" }, "工具 · MCP · 技能"),
            h("div", { className: "dsh-sess-tools" },
              toolGroup("工具", sessionTools.tools, "tools"),
              toolGroup("MCP", sessionTools.mcp, "mcp"),
              toolGroup("技能", sessionTools.skills, "skills"))),
          h("div", { className: "dsh-sess-foot" }, h("button", { type: "button", className: "dsh-sess-manage", onClick: () => window.desktop?.openBilling() }, "查看全部用量与价格规则"))),
        detailModel && h("div", { className: "dsh-model-detail", role: "dialog", "aria-label": detailModel.model + " 用量详情", style: { top: detail.top + "px" } },
          h("div", { className: "dsh-model-detail-head" }, h("div", null, h("strong", null, detailModel.model), h("small", null, detailModel.provider)), h("button", { type: "button", "aria-label": "关闭模型详情", onClick: () => setDetail(null) }, "×")),
          h("div", { className: "dsh-model-detail-price" }, h("span", null, "预估费用"), h("strong", null, modelAmount(detailModel))),
          h("div", { className: "dsh-model-rule" }, h("span", null, "当前计价规则"), h("strong", null, detailModel.rule?.label || "未配置价格"), h("small", null, ruleSummary(detailModel.pricing))),
          h("div", { className: "dsh-model-detail-grid" },
            h("div", null, h("span", null, "请求"), h("strong", null, detailModel.requests + " 次")),
            h("div", null, h("span", null, "输入"), h("strong", null, compactTokens(detailModel.input))),
            h("div", null, h("span", null, "缓存"), h("strong", null, compactTokens(detailModel.cache))),
            h("div", null, h("span", null, "输出"), h("strong", null, compactTokens(detailModel.output)))),
          detailModel.unknown > 0 && h("small", { className: "dsh-model-detail-warning" }, detailModel.unknown + " 次请求未计价"),
          detailModel.officialPricing && detailModel.rule && detailModel.rule.mode !== "official" && h("button", { type: "button", className: "dsh-model-fix", onClick: async () => { desktopNotify("正在恢复官方价格…", "loading", true); try { await window.desktop?.useOfficialBilling({ provider: detailModel.provider, model: detailModel.model }, detailModel.officialPricing.rule.provider); setDetail(null); desktopNotify("已恢复官方价格，历史费用保持不变", "success"); } catch (error) { desktopNotify(error instanceof Error ? error.message : String(error), "error"); } } }, "从现在起恢复官方价格"),
          h("button", { type: "button", className: "dsh-model-fix", onClick: () => window.desktop?.openBilling({ provider: detailModel.provider, model: detailModel.model }) }, detailModel.rule ? "价格来源与设置" : "配置此模型价格")));
    }
    function VisionCard() {
      const h = React.createElement;
      const [settings, setSettings] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");
      const [formKind, setFormKind] = React.useState("");
      const [draft, setDraft] = React.useState(null);
      const [apiKey, setApiKey] = React.useState("");
      const [testing, setTesting] = React.useState("");
      const [testResult, setTestResult] = React.useState("");
      React.useEffect(() => {
        let alive = true;
        window.desktop?.getVisionSettings?.().then((value) => { if (alive) setSettings(value); }).catch(() => {});
        return () => { alive = false; };
      }, []);
      const save = async (next) => {
        setBusy(true); setError(""); setTestResult("");
        try {
          const saved = await window.desktop.setVisionSettings(next);
          setSettings(saved);
          visionPolicy = saved.policy;
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setBusy(false); }
      };
      const update = (patch) => save({ ...settings, ...patch });
      const toggleEnabled = () => save({ ...settings, policy: settings.policy === "off" ? "auto" : "off" });
      // 启用为单选语义：勾选启用某服务时其它服务全部停用，该服务同时成为默认
      // （vision_understand 只使用默认服务）。取消勾选后无默认服务。
      const toggleBackend = (id, nextEnabled) => {
        if (nextEnabled) {
          update({
            backends: settings.backends.map((backend) => backend.id === id ? { ...backend, enabled: true } : { ...backend, enabled: false }),
            defaultBackendId: id,
          });
        } else {
          update({ backends: settings.backends.map((backend) => backend.id === id ? { ...backend, enabled: false } : backend), defaultBackendId: null });
        }
      };
      const removeBackend = (id) => {
        const backends = settings.backends.filter((backend) => backend.id !== id);
        const defaultBackendId = settings.defaultBackendId === id ? (backends.find((backend) => backend.enabled)?.id ?? null) : settings.defaultBackendId;
        update({ backends, defaultBackendId });
      };
      const testBackend = async (backend) => {
        setTesting(backend.id); setTestResult("");
        try {
          const result = await window.desktop.testVisionBackend(backend);
          setTestResult(backend.kind === "mcp" ? "连接成功，可用工具：" + (result.tools || []).map((tool) => tool.name).join("、") : "连接成功，已连接模型接口");
        } catch (cause) { setTestResult(cause instanceof Error ? cause.message : String(cause)); }
        finally { setTesting(""); }
      };
      const setField = (key) => (event) => setDraft((value) => ({ ...value, [key]: event.target.value }));
      const input = (value, onChange, props) => h("input", Object.assign({ type: "text", value, onChange: (event) => onChange(event.target.value) }, props || {}));
      const field = (label, control) => h("label", { className: "dsh-vision-field" }, h("span", null, label), control);
      const startDirect = (backend) => {
        setFormKind("direct"); setApiKey("");
        if (backend) { setDraft({ id: backend.id, name: backend.name, baseUrl: backend.baseUrl, model: backend.model, credentialName: backend.credentialName, timeoutMs: String(backend.timeoutMs) }); return; }
        setDraft({ name: "千问视觉", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-vl-max", credentialName: "DASHSCOPE_API_KEY", timeoutMs: "60000" });
      };
      const startMcp = (backend) => {
        setFormKind("mcp");
        if (backend) { setDraft({ id: backend.id, name: backend.name, command: backend.command, args: (backend.args || []).join(","), cwd: backend.cwd || "", toolName: backend.toolName, imageArgument: backend.imageArgument, questionArgument: backend.questionArgument, timeoutMs: String(backend.timeoutMs) }); return; }
        setDraft({ name: "本地视觉 MCP", command: "npx", args: "", cwd: "", toolName: "", imageArgument: "image", questionArgument: "question", timeoutMs: "60000" });
      };
      // 免费方案预设：智谱 GLM-4V-Flash（open.bigmodel.cn 手机号注册，永久免费），
      // OpenAI 兼容接口。freePreset 仅用于表单提示，提交时不会写入后端配置。
      const startFree = () => {
        setFormKind("direct"); setApiKey("");
        setDraft({ freePreset: "glm", name: "智谱 GLM-4V-Flash（免费）", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4v-flash", credentialName: "ZHIPU_API_KEY", timeoutMs: "60000" });
      };
      const cancelForm = () => { setFormKind(""); setDraft(null); };
      const chooseImageDir = async () => {
        try {
          const picked = await window.desktop.pickVisionImageDirectory();
          if (picked) await save({ ...settings, imageDirectory: picked });
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      };
      const clearImages = async () => {
        try {
          const count = await window.desktop.clearVisionImages();
          desktopNotify(count > 0 ? "已清理 " + count + " 张已保存图片" : "没有可清理的图片", count > 0 ? "success" : "info");
        } catch (cause) { desktopNotify(cause instanceof Error ? cause.message : String(cause), "error"); }
      };
      // 新建：启用该服务并成为唯一默认；编辑：替换配置并保留原启用状态。
      const commitDirect = async () => {
        if (!draft || !draft.name.trim()) { setError("请填写服务名称"); return; }
        setBusy(true); setError("");
        try {
          const key = apiKey.trim();
          if (key) await window.desktop.setCredential(draft.credentialName.trim(), key);
          const config = { id: draft.id ?? crypto.randomUUID(), kind: "direct", name: draft.name.trim(), enabled: true, model: draft.model.trim(), timeoutMs: Number(draft.timeoutMs) || 60000, baseUrl: draft.baseUrl.trim(), credentialName: draft.credentialName.trim() };
          const next = draft.id
            ? { ...settings, backends: settings.backends.map((backend) => backend.id === draft.id ? { ...config, enabled: backend.enabled } : backend) }
            : { ...settings, backends: settings.backends.map((backend) => ({ ...backend, enabled: false })).concat([config]), defaultBackendId: config.id };
          const saved = await window.desktop.setVisionSettings(next);
          setSettings(saved); cancelForm(); setApiKey("");
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setBusy(false); }
      };
      const commitMcp = async () => {
        if (!draft || !draft.name.trim()) { setError("请填写服务名称"); return; }
        setBusy(true); setError("");
        try {
          const config = { id: draft.id ?? crypto.randomUUID(), kind: "mcp", name: draft.name.trim(), enabled: true, model: draft.model.trim(), timeoutMs: Number(draft.timeoutMs) || 60000, command: draft.command.trim(), args: String(draft.args || "").split(",").map((item) => item.trim()).filter(Boolean), cwd: draft.cwd.trim(), toolName: draft.toolName.trim(), imageArgument: draft.imageArgument.trim() || "image", questionArgument: draft.questionArgument.trim() || "question" };
          const next = draft.id
            ? { ...settings, backends: settings.backends.map((backend) => backend.id === draft.id ? { ...config, enabled: backend.enabled } : backend) }
            : { ...settings, backends: settings.backends.map((backend) => ({ ...backend, enabled: false })).concat([config]), defaultBackendId: config.id };
          const saved = await window.desktop.setVisionSettings(next);
          setSettings(saved); cancelForm();
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setBusy(false); }
      };
      if (!settings) return h("p", { className: "dsh-vision-hint" }, "正在加载视觉设置…");
      const enabled = settings.policy !== "off";
      const form = formKind === "direct"
        ? h("div", { className: "dsh-vision-form" },
            draft.freePreset === "glm" && h("p", { className: "dsh-vision-hint" }, "免费方案：在 open.bigmodel.cn 用手机号注册（无需充值）→ API Keys 创建密钥，glm-4v-flash 永久免费。填好名称与 API Key 保存即可。"),
            field("名称", input(draft.name, setField("name"))),
            field("Base URL", input(draft.baseUrl, setField("baseUrl"))),
            field("模型", input(draft.model, setField("model"))),
            field("凭据名", input(draft.credentialName, setField("credentialName"))),
            field("API Key", h("input", { type: "password", value: apiKey, onChange: (event) => setApiKey(event.target.value), placeholder: "仅写入加密凭据库，不落配置" })),
            field("超时（毫秒）", input(draft.timeoutMs, setField("timeoutMs"))),
            h("div", { className: "dsh-vision-form-actions" }, h("button", { type: "button", className: "dsh-vision-save", disabled: busy, onClick: () => void commitDirect() }, draft.id ? "保存" : "添加"), h("button", { type: "button", className: "dsh-vision-link", onClick: cancelForm }, "取消")))
        : formKind === "mcp"
          ? h("div", { className: "dsh-vision-form" },
              field("名称", input(draft.name, setField("name"))),
              field("命令", input(draft.command, setField("command"))),
              field("参数（逗号分隔）", input(draft.args, setField("args"))),
              field("工作目录", input(draft.cwd, setField("cwd"))),
              field("工具名", input(draft.toolName, setField("toolName"))),
              field("图片参数名", input(draft.imageArgument, setField("imageArgument"))),
              field("问题参数名", input(draft.questionArgument, setField("questionArgument"))),
              field("超时（毫秒）", input(draft.timeoutMs, setField("timeoutMs"))),
              h("div", { className: "dsh-vision-form-actions" }, h("button", { type: "button", className: "dsh-vision-save", disabled: busy, onClick: () => void commitMcp() }, draft.id ? "保存" : "添加"), h("button", { type: "button", className: "dsh-vision-link", onClick: cancelForm }, "取消")))
          : null;
      return h("div", { className: "dsh-vision-card" },
        h("div", { className: "dsh-vision-toggle" },
          h("div", { className: "dsh-vision-toggle-text" },
            h("strong", null, "视觉解析"),
            h("small", null, "把粘贴或拖入的图片保存为占位，模型用 vision_understand 工具经视觉服务解析成文字；多模态模型自动走原生 read_image。")),
          h("button", { type: "button", role: "switch", "aria-checked": enabled ? "true" : "false", className: "dsh-switch" + (enabled ? " is-on" : ""), "aria-label": "启用视觉解析", onClick: () => void toggleEnabled() }, h("span", { className: "dsh-switch-knob", "aria-hidden": "true" }))),
        !enabled
          ? h("p", { className: "dsh-vision-hint" }, "已关闭：粘贴/拖放图片不会被保存，纯文本模型无法读取图片。")
          : h("div", { className: "dsh-vision-body" },
              h("div", { className: "dsh-vision-scope" },
                h("span", { className: "dsh-vision-label" }, "适用范围"),
                h("label", null, h("input", { type: "radio", name: "dsh-vision-policy", checked: settings.policy === "auto", onChange: () => void update({ policy: "auto" }) }), "自动（仅纯文本模型解析）"),
                h("label", null, h("input", { type: "radio", name: "dsh-vision-policy", checked: settings.policy === "always", onChange: () => void update({ policy: "always" }) }), "总是解析")),
              settings.backends.length > 0 && h("div", { className: "dsh-vision-list" },
                settings.backends.map((backend) =>
                  h("div", { key: backend.id, className: "dsh-vision-backend" + (backend.enabled ? "" : " is-disabled") },
                    h("div", { className: "dsh-vision-backend-main" }, h("strong", null, backend.name), h("span", null, (backend.kind === "direct" ? "Direct API" : "MCP stdio") + " · " + backend.model)),
                    h("div", { className: "dsh-vision-backend-meta" },
                      backend.enabled && h("span", { className: "dsh-vision-tag" }, "默认"),
                      !backend.enabled && h("span", { className: "dsh-vision-tag" }, "已停用"),
                      h("button", { type: "button", className: "dsh-vision-link", disabled: testing === backend.id, onClick: () => void testBackend(backend) }, testing === backend.id ? "测试中…" : "测试连接"),
                      h("button", { type: "button", className: "dsh-vision-link", onClick: () => (backend.kind === "direct" ? startDirect(backend) : startMcp(backend)) }, "编辑"),
                      h("label", { className: "dsh-vision-check", title: "勾选启用该服务并设为默认，同时停用其它服务" }, h("input", { type: "checkbox", checked: backend.enabled, onChange: (event) => void toggleBackend(backend.id, event.target.checked) }), "使用"),
                      h("button", { type: "button", className: "dsh-vision-link dsh-vision-danger", onClick: () => void removeBackend(backend.id) }, "删除"))))),
              testResult && h("p", { className: "dsh-vision-test" }, testResult),
              h("div", { className: "dsh-vision-actions" },
                h("button", { type: "button", className: "dsh-vision-add", onClick: () => void startFree() }, "+ 免费方案（智谱 GLM-4V）"),
                h("button", { type: "button", className: "dsh-vision-add", onClick: () => void startDirect() }, "+ Direct API"),
                h("button", { type: "button", className: "dsh-vision-add", onClick: () => void startMcp() }, "+ MCP 服务")),
              form,
              h("div", { className: "dsh-vision-row" },
                h("span", { className: "dsh-vision-label" }, "图片存放目录"),
                h("p", { className: "dsh-vision-test" }, settings.imageDirectory || "默认（用户数据目录/vision）"),
                h("div", { className: "dsh-vision-actions" },
                  h("button", { type: "button", className: "dsh-vision-add", onClick: () => void chooseImageDir() }, "选择目录"),
                  settings.imageDirectory && h("button", { type: "button", className: "dsh-vision-add", onClick: () => void save({ ...settings, imageDirectory: null }) }, "恢复默认"),
                  h("button", { type: "button", className: "dsh-vision-add", onClick: () => void clearImages() }, "清理图片"))),
              h("label", { className: "dsh-vision-disclosure" }, h("input", { type: "checkbox", checked: settings.remoteDisclosureAccepted, onChange: (event) => void update({ remoteDisclosureAccepted: event.target.checked }) }), "我已了解：Direct 服务会把图片内容发送到所配置的远程接口"),
              error && h("p", { className: "dsh-vision-error" }, error)),
        busy && h("p", { className: "dsh-vision-hint" }, "正在保存…"));
    }
    function ImageCard() {
      const h = React.createElement;
      const [settings, setSettings] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");
      const [formKind, setFormKind] = React.useState("");
      const [draft, setDraft] = React.useState(null);
      const [apiKey, setApiKey] = React.useState("");
      React.useEffect(() => {
        let alive = true;
        window.desktop?.getImageSettings?.().then((value) => { if (alive) setSettings(value); }).catch(() => {});
        return () => { alive = false; };
      }, []);
      const save = async (next) => {
        setBusy(true); setError("");
        try { setSettings(await window.desktop.setImageSettings(next)); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setBusy(false); }
      };
      const cancelForm = () => { setFormKind(""); setDraft(null); };
      // 免费方案：智谱 CogView3-Flash（同视觉免费方案的 ZHIPU_API_KEY，永久免费）
      const startFree = () => {
        setFormKind("direct"); setApiKey("");
        setDraft({ freePreset: "cogview", name: "智谱 CogView3-Flash（免费）", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "cogview-3-flash", credentialName: "ZHIPU_API_KEY" });
      };
      const startDirect = (backend) => {
        setFormKind("direct"); setApiKey("");
        if (backend) { setDraft({ id: backend.id, name: backend.name, baseUrl: backend.baseUrl, model: backend.model, credentialName: backend.credentialName }); return; }
        setDraft({ name: "生图服务", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "cogview-3-flash", credentialName: "IMAGE_API_KEY" });
      };
      const commit = async () => {
        if (!draft || !draft.name.trim()) { setError("请填写服务名称"); return; }
        setBusy(true); setError("");
        try {
          const key = apiKey.trim();
          if (key) await window.desktop.setCredential(draft.credentialName.trim(), key);
          const config = { id: draft.id ?? crypto.randomUUID(), name: draft.name.trim(), enabled: true, model: draft.model.trim(), baseUrl: draft.baseUrl.trim(), credentialName: draft.credentialName.trim() };
          const next = draft.id
            ? { ...settings, backends: settings.backends.map((backend) => backend.id === draft.id ? { ...config, enabled: backend.enabled } : backend) }
            : { ...settings, backends: settings.backends.map((backend) => ({ ...backend, enabled: false })).concat([config]), defaultBackendId: config.id };
          const saved = await window.desktop.setImageSettings(next);
          setSettings(saved); cancelForm(); setApiKey("");
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setBusy(false); }
      };
      const removeBackend = (id) => {
        const backends = settings.backends.filter((backend) => backend.id !== id);
        const defaultBackendId = settings.defaultBackendId === id ? null : settings.defaultBackendId;
        void save({ backends, defaultBackendId });
      };
      if (!settings) return h("p", { className: "dsh-vision-hint" }, "正在加载生图设置…");
      const chooseDir = async () => {
        try {
          const picked = await window.desktop.pickImageDirectory();
          if (picked) {
            setSettings({ ...settings, imageDirectory: picked });
            desktopNotify("生图目录已更新", "success");
          }
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      };
      const resetDir = () => void save({ ...settings, imageDirectory: null });
      const setField = (key) => (event) => setDraft((value) => ({ ...value, [key]: event.target.value }));
      const input = (value, onChange, props) => h("input", Object.assign({ type: "text", value, onChange: (event) => onChange(event.target.value) }, props || {}));
      const field = (label, control) => h("label", { className: "dsh-vision-field" }, h("span", null, label), control);
      return h("div", { className: "dsh-vision-card" },
        h("div", { className: "dsh-vision-toggle" },
          h("div", { className: "dsh-vision-toggle-text" },
            h("strong", null, "生图服务"),
            h("small", null, "agent 用 generate_image 工具按描述生成图片；免费方案为智谱 CogView3-Flash（同视觉免费方案的 API Key，永久免费）。")),
          null),
        h("div", { className: "dsh-vision-body" },
          settings.backends.length > 0 && h("div", { className: "dsh-vision-list" },
            settings.backends.map((backend) =>
              h("div", { key: backend.id, className: "dsh-vision-backend" + (backend.enabled ? "" : " is-disabled") },
                h("div", { className: "dsh-vision-backend-main" }, h("strong", null, backend.name), h("span", null, backend.model)),
                h("div", { className: "dsh-vision-backend-meta" },
                  backend.enabled && h("span", { className: "dsh-vision-tag" }, "默认"),
                  !backend.enabled && h("span", { className: "dsh-vision-tag" }, "已停用"),
                  h("button", { type: "button", className: "dsh-vision-link", onClick: () => startDirect(backend) }, "编辑"),
                  h("label", { className: "dsh-vision-check", title: "勾选启用该服务并设为默认" }, h("input", { type: "checkbox", checked: backend.enabled, onChange: (event) => {
                    if (event.target.checked) {
                      void save({ backends: settings.backends.map((item) => item.id === backend.id ? { ...item, enabled: true } : { ...item, enabled: false }), defaultBackendId: backend.id });
                    } else {
                      void save({ backends: settings.backends.map((item) => item.id === backend.id ? { ...item, enabled: false } : item), defaultBackendId: null });
                    }
                  } }), "使用"),
                  h("button", { type: "button", className: "dsh-vision-link dsh-vision-danger", onClick: () => removeBackend(backend.id) }, "删除"))))),
          formKind === "direct" && h("div", { className: "dsh-vision-form" },
            draft.freePreset === "cogview" && h("p", { className: "dsh-vision-hint" }, "免费方案：CogView3-Flash 永久免费，使用视觉免费方案同一个 ZHIPU_API_KEY，无需额外注册。注意：免费模型生成的图片可能带「AI 生成」水印，可在 bigmodel.cn 控制台的安全管理中关闭；要彻底无水印可改用付费模型（如 cogview-4）。"),
            field("名称", input(draft.name, setField("name"))),
            field("Base URL", input(draft.baseUrl, setField("baseUrl"))),
            field("模型", input(draft.model, setField("model"))),
            field("凭据名", input(draft.credentialName, setField("credentialName"))),
            field("API Key", h("input", { type: "password", value: apiKey, onChange: (event) => setApiKey(event.target.value), placeholder: "仅写入加密凭据库，不落配置" })),
            h("div", { className: "dsh-vision-form-actions" },
              h("button", { type: "button", className: "dsh-vision-save", disabled: busy, onClick: () => void commit() }, draft.id ? "保存" : "添加"),
              h("button", { type: "button", className: "dsh-vision-link", onClick: cancelForm }, "取消"))),
          h("div", { className: "dsh-vision-actions" },
            h("button", { type: "button", className: "dsh-vision-add", onClick: () => void startFree() }, "+ 免费方案（智谱 CogView3）"),
            h("button", { type: "button", className: "dsh-vision-add", onClick: () => void startDirect() }, "+ Direct API")),
          h("div", { className: "dsh-vision-row" },
            h("span", { className: "dsh-vision-label" }, "图片存放目录"),
            h("p", { className: "dsh-vision-test" }, settings.imageDirectory || "默认（用户数据目录/images）"),
            h("div", { className: "dsh-vision-actions" },
              h("button", { type: "button", className: "dsh-vision-add", onClick: () => void chooseDir() }, "选择目录"),
              settings.imageDirectory && h("button", { type: "button", className: "dsh-vision-add", onClick: () => void resetDir() }, "恢复默认"))),
          h("p", { className: "dsh-vision-hint" }, "提示：生图时图片描述（prompt）会发送到所配置的服务。"),
          error && h("p", { className: "dsh-vision-error" }, error)),
        busy && h("p", { className: "dsh-vision-hint" }, "正在保存…"));
    }
    function LogCard() {
      const h = React.createElement;
      const [directory, setDirectory] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");
      React.useEffect(() => {
        let alive = true;
        window.desktop?.getEventLogDirectory?.().then((value) => { if (alive) setDirectory(value); }).catch(() => {});
        return () => { alive = false; };
      }, []);
      const choose = async () => {
        setBusy(true); setError("");
        try {
          const picked = await window.desktop.pickEventLogDirectory();
          if (picked) setDirectory(picked);
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setBusy(false); }
      };
      const reset = async () => {
        setBusy(true); setError("");
        try {
          await window.desktop.resetEventLogDirectory();
          setDirectory(null);
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setBusy(false); }
      };
      const open = () => { window.desktop?.openLogDirectory?.().catch(() => {}); };
      return h("div", { className: "dsh-vision-card" },
        h("div", { className: "dsh-vision-toggle" },
          h("div", { className: "dsh-vision-toggle-text" },
            h("strong", null, "事件日志"),
            h("small", null, "记录用户操作、视觉解析请求、会话用量与错误，用于问题定位与统计分析。按天保存 JSONL 文件，默认保留 30 天。")),
          null),
        h("div", { className: "dsh-vision-body" },
          h("div", { className: "dsh-vision-row" },
            h("span", { className: "dsh-vision-label" }, "日志目录"),
            h("p", { className: "dsh-vision-test" }, directory || "默认（用户数据目录/logs）"),
            h("div", { className: "dsh-vision-actions" },
              h("button", { type: "button", className: "dsh-vision-add", disabled: busy, onClick: () => void choose() }, "选择目录"),
              h("button", { type: "button", className: "dsh-vision-add", onClick: () => void open() }, "打开日志目录"),
              directory && h("button", { type: "button", className: "dsh-vision-add", disabled: busy, onClick: () => void reset() }, "恢复默认"))),
          error && h("p", { className: "dsh-vision-error" }, error)));
    }
    function formatMemoryTime(iso) {
      const then = Date.parse(iso);
      if (Number.isNaN(then)) return "";
      const diff = Date.now() - then;
      if (diff < 60000) return "刚刚";
      if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
      if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
      if (diff < 604800000) return Math.floor(diff / 86400000) + " 天前";
      return new Date(then).toLocaleDateString();
    }
    function MemoryCard() {
      const h = React.createElement;
      const [entries, setEntries] = React.useState([]);
      const [enabled, setEnabled] = React.useState(true);
      const [filter, setFilter] = React.useState("");
      const [loaded, setLoaded] = React.useState(false);
      React.useEffect(() => {
        let alive = true;
        window.desktop?.getMemoryToolsEnabled?.().then((value) => { if (alive) setEnabled(value); }).catch(() => {});
        window.desktop?.getMemoryEntries?.().then((value) => { if (alive) setEntries(value || []); }).catch(() => {}).finally(() => { if (alive) setLoaded(true); });
        return () => { alive = false; };
      }, []);
      const toggle = (next) => {
        setEnabled(next);
        window.desktop?.setMemoryToolsEnabled?.(next).catch(() => setEnabled(!next));
      };
      const query = filter.trim().toLowerCase();
      const visible = query
        ? entries.filter((entry) => (entry.content || "").toLowerCase().includes(query) || (entry.tags || []).some((tag) => String(tag).toLowerCase().includes(query)))
        : entries;
      const remove = (id) => window.desktop?.deleteMemoryEntry?.(id).then(setEntries).catch(() => {});
      return h("div", { className: "dsh-memory-card" },
        h("div", { className: "dsh-memory-toggle" },
          h("div", { className: "dsh-memory-toggle-text" },
            h("strong", null, "记忆工具"),
            h("small", null, "允许 Harness 助手用 memory_write / memory_search 读写跨会话记忆")),
          h("button", { type: "button", role: "switch", "aria-checked": enabled ? "true" : "false", className: "dsh-switch" + (enabled ? " is-on" : ""), "aria-label": "启用记忆工具", onClick: () => toggle(!enabled) },
            h("span", { className: "dsh-switch-knob", "aria-hidden": "true" }))),
        h("div", { className: "dsh-memory-toolbar" },
          h("input", { value: filter, onChange: (event) => setFilter(event.target.value), placeholder: "过滤记忆…", "aria-label": "过滤记忆" }),
          h("span", { className: "dsh-memory-count" }, String(entries.length) + " 条")),
        !loaded
          ? h("p", { className: "dsh-memory-empty" }, "加载中…")
          : entries.length === 0
            ? h("p", { className: "dsh-memory-empty" }, "还没有保存任何记忆。Harness 助手可用 memory_write 记录事实，之后任意会话都能检索到。")
            : visible.length === 0
              ? h("p", { className: "dsh-memory-empty" }, "无匹配记忆。")
              : h("ul", { className: "dsh-memory-list" }, visible.map((entry) =>
                  h("li", { key: entry.id, className: "dsh-memory-entry" },
                    h("div", { className: "dsh-memory-entry-main" },
                      h("span", { className: "dsh-memory-entry-content" }, entry.content),
                      (entry.tags || []).length > 0 && h("span", { className: "dsh-memory-entry-tags" }, (entry.tags || []).map((tag) => h("span", { key: tag, className: "dsh-memory-entry-tag" }, "#" + tag)))),
                    h("div", { className: "dsh-memory-entry-meta" },
                      h("span", { className: "dsh-memory-entry-date" }, formatMemoryTime(entry.updatedAt)),
                      h("button", { type: "button", className: "dsh-memory-entry-delete", onClick: () => remove(entry.id), "aria-label": "删除记忆" }, "删除"))))));
    }
    function apply(ctx) {
      let chain = Promise.resolve();
      const respond = (result) => window.postMessage({ type: RESULT, result }, window.location.origin);
      const onMessage = (event) => {
        if (event.source !== window || event.origin !== window.location.origin || event.data?.type !== OPEN) return;
        const request = event.data.request;
        if (!request || typeof request.requestId !== "string" || typeof request.path !== "string") return;
        chain = chain.then(async () => {
          try {
            const workspace = await ctx.workspaces.create({ path: request.path });
            let sessionId = request.requestId;
            try {
              sessionId = await ctx.sessions.create({ workspaceId: workspace.workspaceId, sessionId });
            } catch (error) {
              // A renderer reload can resend an acknowledged-late request. The
              // caller-provided UUID makes that retry safe and addressable.
              if (!ctx.sessions.binding(sessionId)) throw error;
            }
            ctx.sessions.open(sessionId);
            respond({ requestId: request.requestId, path: request.path, ok: true });
          } catch (error) {
            respond({
              requestId: request.requestId,
              path: request.path,
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        });
      };
      window.addEventListener("message", onMessage);
      ctx.effect(() => () => window.removeEventListener("message", onMessage), "desktop workspace launcher");
      const style = document.createElement("style");
      style.id = "deepseek-desktop-billing-styles";
      style.textContent = ".dsh-cost-meter{position:relative;display:inline-flex;align-items:center}.dsh-cost-trigger{height:32px;display:inline-flex;align-items:center;gap:7px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);padding:0 11px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}.dsh-cost-trigger:hover,.dsh-cost-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dsh-cost-symbol{width:18px;height:18px;display:grid;place-items:center;border-radius:50%;background:var(--dsw-alias-bg-module-platform);font-size:11px;font-weight:650;color:var(--dsw-alias-state-business-primary)}.dsh-cost-chevron{font-size:9px;color:var(--dsw-alias-label-tertiary)}.dsh-cost-backdrop{position:fixed;z-index:998;inset:0;border:0;background:rgba(0,0,0,.08)}.dsh-cost-panel{position:fixed;z-index:999;right:14px;top:76px;bottom:16px;width:306px;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-base);box-shadow:0 12px 36px rgba(0,0,0,.12);color:var(--dsw-alias-label-primary)}.dsh-panel-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 16px 13px;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsh-panel-heading strong{display:block;font-size:14px;font-weight:620}.dsh-panel-heading small{display:block;color:var(--dsw-alias-label-tertiary);font-size:10px;margin-top:3px}.dsh-panel-close{width:26px;height:26px;display:grid;place-items:center;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:20px;line-height:1;cursor:pointer}.dsh-panel-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dsh-cost-totals{display:grid;gap:5px;margin:14px 14px 0;padding:12px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}.dsh-cost-total{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.dsh-cost-total span{color:var(--dsw-alias-label-tertiary);font-size:11px}.dsh-cost-total strong{font-size:18px;font-weight:630;font-variant-numeric:tabular-nums}.dsh-cost-facts{display:grid;grid-template-columns:1fr 1fr;gap:11px 14px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsh-cost-facts div{min-width:0}.dsh-cost-facts span{display:block;color:var(--dsw-alias-label-tertiary);font-size:10px}.dsh-cost-facts strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:560;margin-top:2px;font-variant-numeric:tabular-nums}.dsh-cost-empty{display:flex;flex-direction:column;gap:5px;margin:16px;padding:18px 12px;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}.dsh-cost-empty strong{font-size:12px;font-weight:600}.dsh-cost-empty span{font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary)}.dsh-model-section{padding:14px 14px 0}.dsh-model-section h3{margin:0 2px 8px;color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:560}.dsh-model-list{display:grid;gap:7px}.dsh-model-card{padding:10px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}.dsh-model-card.is-current{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 32%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 5%,var(--dsw-alias-bg-layer-1))}.dsh-model-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.dsh-model-name{min-width:0}.dsh-model-name strong,.dsh-model-name small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-model-name strong{font-size:11px;font-weight:600}.dsh-model-name small{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:9px}.dsh-current-badge{flex:none;padding:2px 6px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-business-primary);font-size:9px}.dsh-model-amount{margin-top:8px;font-size:14px;font-weight:620;font-variant-numeric:tabular-nums}.dsh-model-meta{display:flex;flex-wrap:wrap;gap:3px 10px;margin-top:5px;color:var(--dsw-alias-label-tertiary);font-size:9px}.dsh-model-unknown{display:block;margin-top:5px;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary));font-size:9px}.dsh-cost-warning{margin:12px 16px 0;padding:9px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary));font-size:10px;line-height:16px}.dsh-panel-footer{position:sticky;bottom:0;margin-top:auto;padding:12px 14px 14px;background:linear-gradient(transparent,var(--dsw-alias-bg-base) 18%)}.dsh-cost-manage{width:100%;height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;cursor:pointer}.dsh-cost-manage:hover{background:var(--dsw-alias-interactive-bg-hover)}@media(min-width:1280px){.dsh-cost-meter[data-open=true]>.dsh-cost-trigger{display:none}}@media(max-width:1279px){.dsh-cost-trigger{width:32px;padding:0;justify-content:center}.dsh-cost-label,.dsh-cost-chevron{display:none}.dsh-cost-symbol{background:transparent}.dsh-cost-panel{right:10px;top:58px;bottom:10px;width:min(326px,calc(100vw - 20px));box-shadow:0 18px 54px rgba(0,0,0,.2)}}@media(prefers-reduced-motion:no-preference){.dsh-cost-panel{animation:dsh-panel-in .16s ease-out}@keyframes dsh-panel-in{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:none}}}";
      style.textContent += ".dsh-cost-panel{top:132px;bottom:auto;max-height:min(500px,calc(100vh - 156px));overflow:hidden}.dsh-panel-heading{position:static;padding:14px 15px 11px}.dsh-cost-totals{margin:12px 13px 0;padding:10px 11px}.dsh-session-meta{display:flex;flex-wrap:wrap;gap:4px 12px;padding:9px 15px 11px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:9px}.dsh-model-section{min-height:0;padding:11px 13px 0}.dsh-model-list{display:grid;gap:5px;max-height:190px;overflow-y:auto}.dsh-model-row{width:100%;height:36px;display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;align-items:center;gap:7px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}.dsh-model-row:hover,.dsh-model-row[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}.dsh-model-row.is-current{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 38%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,var(--dsw-alias-bg-layer-1))}.dsh-model-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;font-size:10px;font-weight:560}.dsh-model-row strong{font-size:10px;font-weight:620;font-variant-numeric:tabular-nums}.dsh-current-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}.dsh-model-row-chevron{color:var(--dsw-alias-label-tertiary);font-size:15px}.dsh-cost-warning{margin:8px 14px 0;padding:7px 9px}.dsh-panel-footer{padding:10px 13px 12px}.dsh-model-detail{position:fixed;z-index:1001;right:330px;width:262px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base);box-shadow:0 14px 38px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary)}.dsh-model-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.dsh-model-detail-head strong,.dsh-model-detail-head small{display:block;max-width:205px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-model-detail-head strong{font-size:11px}.dsh-model-detail-head small{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:9px}.dsh-model-detail-head button{width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:16px;cursor:pointer}.dsh-model-detail-head button:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-model-detail-price{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-top:11px;padding:9px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1)}.dsh-model-detail-price span{color:var(--dsw-alias-label-tertiary);font-size:9px}.dsh-model-detail-price strong{font-size:14px;font-variant-numeric:tabular-nums}.dsh-model-detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px 12px;margin-top:11px}.dsh-model-detail-grid span,.dsh-model-detail-grid strong{display:block}.dsh-model-detail-grid span{color:var(--dsw-alias-label-tertiary);font-size:9px}.dsh-model-detail-grid strong{margin-top:2px;font-size:10px;font-weight:580}.dsh-model-detail-warning{display:block;margin-top:9px;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary));font-size:9px}@media(max-width:1279px){.dsh-cost-panel{top:58px;max-height:min(480px,calc(100vh - 72px))}}@media(max-width:700px){.dsh-model-detail{right:12px;width:min(262px,calc(100vw - 24px))}}";
      style.textContent += ".dsh-cost-meter[data-wide=true][data-open=true]>.dsh-cost-trigger{display:none}.dsh-cost-meter[data-wide=true] .dsh-cost-panel{top:132px;max-height:min(500px,calc(100vh - 156px))}@media(min-width:1280px){.dsh-cost-meter[data-wide=false][data-open=true]>.dsh-cost-trigger{display:inline-flex}}";
      style.textContent += ".dsh-cost-panel{width:320px}.dsh-panel-heading strong{font-size:15px}.dsh-panel-heading small,.dsh-cost-total span{font-size:11px}.dsh-session-meta{font-size:11px;gap:5px 14px}.dsh-model-section h3{font-size:11px;line-height:17px}.dsh-model-row{height:42px;grid-template-columns:minmax(0,1fr) 8px auto 14px;gap:8px;padding:0 10px}.dsh-model-row-name,.dsh-model-row strong{font-size:12px;line-height:17px}.dsh-current-dot.is-placeholder{opacity:0}.dsh-model-row-chevron{justify-self:end}.dsh-model-row.is-unpriced strong{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary))}.dsh-cost-warning{font-size:11px;line-height:17px}.dsh-cost-manage{font-size:12px}.dsh-model-detail{right:344px;width:286px;max-height:calc(100vh - 24px);overflow-y:auto;padding:14px}.dsh-model-detail-head strong{font-size:12px}.dsh-model-detail-head small,.dsh-model-detail-price span,.dsh-model-detail-grid span{font-size:11px}.dsh-model-detail-grid strong{font-size:12px}.dsh-model-rule{display:grid;gap:3px;margin-top:10px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}.dsh-model-rule span,.dsh-model-rule small{color:var(--dsw-alias-label-tertiary);font-size:11px}.dsh-model-rule strong{font-size:12px;font-weight:600}.dsh-model-rule small{line-height:17px}.dsh-model-fix{width:100%;height:34px;margin-top:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}.dsh-model-fix:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-cost-meter button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}@media(max-width:700px){.dsh-model-detail{right:12px;width:min(286px,calc(100vw - 24px))}}";
      style.textContent += ".dsh-balance-summary{display:grid;gap:5px;margin:8px 13px 0;padding:8px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}.dsh-balance-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:5px 10px}.dsh-balance-row span{color:var(--dsw-alias-label-tertiary);font-size:10px}.dsh-balance-row strong{font-size:12px;font-weight:620;font-variant-numeric:tabular-nums}.dsh-balance-row small{grid-column:1/-1;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary));font-size:9px}.dsh-balance-row.is-warning strong{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-primary))}.dsh-desktop-notice{position:fixed;z-index:4000;left:50%;top:74px;display:flex;align-items:center;gap:9px;min-height:40px;max-width:min(520px,calc(100vw - 32px));padding:9px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 88%,var(--dsw-alias-bg-base));color:var(--dsw-alias-bg-base);box-shadow:0 10px 32px rgba(0,0,0,.18);font:inherit;font-size:12px;opacity:0;pointer-events:none;transform:translate(-50%,-10px);transition:opacity .16s ease,transform .16s ease}.dsh-desktop-notice::before{content:'';width:8px;height:8px;flex:none;border-radius:50%;background:currentColor;opacity:.8}.dsh-desktop-notice[data-phase=loading]::before{border:2px solid currentColor;border-right-color:transparent;background:transparent;animation:dsh-notice-spin .7s linear infinite}.dsh-desktop-notice[data-phase=success]::before{background:var(--dsw-alias-state-success-primary)}.dsh-desktop-notice[data-phase=warning]::before{background:var(--dsw-alias-state-warning-primary)}.dsh-desktop-notice[data-phase=error]::before{background:var(--dsw-alias-state-error-primary)}.dsh-desktop-notice.show{opacity:1;transform:translate(-50%,0)}@keyframes dsh-notice-spin{to{transform:rotate(360deg)}}";
      style.textContent += ".dsh-vision-card{display:grid;gap:12px;padding:14px 16px}.dsh-vision-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px}.dsh-vision-toggle-text{min-width:0}.dsh-vision-toggle-text strong{display:block;font-size:14px;font-weight:620}.dsh-vision-toggle-text small{display:block;margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.dsh-vision-hint{margin:0;padding:14px 12px;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:9px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}.dsh-vision-body{display:grid;gap:12px}.dsh-vision-scope{display:grid;gap:7px}.dsh-vision-label{color:var(--dsw-alias-label-tertiary);font-size:12px}.dsh-vision-scope label{display:flex;align-items:center;gap:7px;font-size:13px;line-height:20px;cursor:pointer}.dsh-vision-scope input[type=radio]{accent-color:var(--dsw-alias-state-business-primary)}.dsh-vision-row{display:grid;gap:6px}.dsh-vision-field{display:grid;gap:5px}.dsh-vision-field>span{color:var(--dsw-alias-label-tertiary);font-size:12px}.dsh-vision-field input,.dsh-vision-field select{width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}.dsh-vision-field input:focus,.dsh-vision-field select:focus{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.dsh-vision-list{display:grid;gap:6px}.dsh-vision-backend{display:grid;gap:6px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}.dsh-vision-backend.is-disabled{opacity:.6}.dsh-vision-backend-main{min-width:0}.dsh-vision-backend-main strong{display:block;font-size:13px;line-height:19px}.dsh-vision-backend-main span{display:block;margin-top:1px;color:var(--dsw-alias-label-tertiary);font-size:11px}.dsh-vision-backend-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px}.dsh-vision-tag{padding:1px 7px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary);font-size:11px}.dsh-vision-link{height:24px;padding:0 6px;border:0;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12px;cursor:pointer}.dsh-vision-link:hover{text-decoration:underline}.dsh-vision-link:disabled{opacity:.55;cursor:wait}.dsh-vision-danger{color:var(--dsw-alias-state-error-primary)}.dsh-vision-check{display:flex;align-items:center;gap:5px;color:var(--dsw-alias-label-tertiary);font-size:12px;cursor:pointer}.dsh-vision-check input{accent-color:var(--dsw-alias-state-business-primary)}.dsh-vision-test{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}.dsh-vision-actions{display:flex;flex-wrap:wrap;gap:8px}.dsh-vision-add{height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}.dsh-vision-add:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-vision-form{display:grid;gap:8px;padding:11px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}.dsh-vision-form-actions{display:flex;align-items:center;gap:10px}.dsh-vision-save{height:32px;padding:0 14px;border:0;border-radius:8px;background:var(--dsw-alias-state-business-primary);color:#fff;font:inherit;font-size:12px;cursor:pointer}.dsh-vision-save:hover{filter:brightness(1.06)}.dsh-vision-disclosure{display:flex;align-items:flex-start;gap:7px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;cursor:pointer}.dsh-vision-disclosure input{margin-top:2px;accent-color:var(--dsw-alias-state-business-primary)}.dsh-vision-error{margin:0;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}";
      style.textContent += ".dsh-cost-panel{width:340px;max-height:min(540px,calc(100vh - 156px))}.dsh-panel-heading{flex:none;padding:15px 16px 13px}.dsh-panel-scroll{min-height:0;flex:1;overflow-y:auto;overscroll-behavior:contain}.dsh-session-overview{padding:9px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsh-overview-row{min-height:40px;display:flex;align-items:center;justify-content:space-between;gap:14px}.dsh-overview-row+ .dsh-overview-row{border-top:1px solid var(--dsw-alias-border-l1)}.dsh-overview-row span{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px}.dsh-overview-row strong{min-width:0;display:flex;align-items:center;justify-content:flex-end;gap:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:610}.dsh-overview-meta{padding:0 0 9px;color:var(--dsw-alias-label-tertiary);font-size:11px}.dsh-info-section{border-bottom:1px solid var(--dsw-alias-border-l1)}.dsh-info-section>summary{min-height:48px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 16px;cursor:pointer;list-style-position:inside;font-size:13px;font-weight:610}.dsh-info-section>summary:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-info-section>summary strong{font-size:12px;font-weight:580;font-variant-numeric:tabular-nums}.dsh-info-content{padding:0 13px 12px}.dsh-info-content .dsh-balance-summary{margin:0 0 8px}.dsh-balance-summary:has(.is-warning){border-color:color-mix(in srgb,#d99000 35%,var(--dsw-alias-border-l1));background:color-mix(in srgb,#d99000 7%,var(--dsw-alias-bg-layer-1))}.dsh-balance-row span{font-size:11px}.dsh-balance-row strong{font-size:13px}.dsh-balance-row small{font-size:10px}.dsh-balance-row.is-warning span,.dsh-balance-row.is-warning small,.dsh-balance-row.is-warning strong{color:#b56f00}.dsh-info-content .dsh-model-section{padding:0}.dsh-info-content .dsh-model-section h3{margin:10px 2px 7px;font-size:12px}.dsh-info-content .dsh-model-list{max-height:none}.dsh-model-row{grid-template-columns:minmax(0,1fr) 8px auto auto 14px}.dsh-current-label{padding:2px 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary);font-size:10px;line-height:14px}.dsh-panel-footer{position:static;flex:none;margin:0;padding:10px 13px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}.dsh-desktop-notice::before{content:'!';width:18px;height:18px;display:grid;place-items:center;background:rgba(217,144,0,.16);color:#f0a000;font-size:12px;font-weight:750;opacity:1}.dsh-desktop-notice[data-phase=loading]::before{content:'';width:14px;height:14px;background:transparent;color:currentColor}.dsh-desktop-notice[data-phase=success]::before{content:'✓';background:rgba(34,154,94,.18);color:#39b874}.dsh-desktop-notice[data-phase=error]::before{content:'!';background:rgba(220,64,64,.18);color:#ef6262}@media(max-width:1279px){.dsh-cost-panel{width:min(340px,calc(100vw - 20px));max-height:min(540px,calc(100vh - 72px))}}";
      style.textContent += ".dsh-memory-card{display:grid;gap:12px;padding:14px 16px}.dsh-memory-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px}.dsh-memory-toggle-text{min-width:0}.dsh-memory-toggle-text strong{display:block;font-size:14px;font-weight:620}.dsh-memory-toggle-text small{display:block;margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.dsh-switch{width:38px;height:22px;flex:none;position:relative;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;transition:background .16s ease,border-color .16s ease}.dsh-switch .dsh-switch-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform .16s ease,background .16s ease}.dsh-switch.is-on{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary)}.dsh-switch.is-on .dsh-switch-knob{transform:translateX(16px);background:var(--dsw-alias-bg-base)}.dsh-memory-toolbar{display:flex;align-items:center;gap:8px}.dsh-memory-toolbar input{flex:1;min-width:0;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}.dsh-memory-toolbar input:focus{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.dsh-memory-count{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px}.dsh-memory-empty{margin:0;padding:16px 12px;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:9px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}.dsh-memory-list{display:grid;gap:6px;margin:0;padding:0;list-style:none;max-height:220px;overflow-y:auto}.dsh-memory-entry{display:grid;gap:5px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}.dsh-memory-entry-main{min-width:0}.dsh-memory-entry-content{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px}.dsh-memory-entry-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}.dsh-memory-entry-tag{color:var(--dsw-alias-state-business-primary);font-size:11px}.dsh-memory-entry-meta{display:flex;align-items:center;justify-content:space-between;gap:8px}.dsh-memory-entry-date{color:var(--dsw-alias-label-tertiary);font-size:11px}.dsh-memory-entry-delete{flex:none;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer}.dsh-memory-entry-delete:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}";
      style.textContent += ".dsh-tool-section{padding:12px 16px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsh-tool-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px}.dsh-tool-head strong{font-size:12px;font-weight:610}.dsh-tool-head small{color:var(--dsw-alias-label-tertiary);font-size:11px}.dsh-tool-group{display:grid;gap:7px;padding-top:10px}.dsh-tool-group+.dsh-tool-group{margin-top:9px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l1)}.dsh-tool-kind{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;letter-spacing:.4px}.dsh-tool-list{display:flex;flex-wrap:wrap;gap:6px}.dsh-tool-chip{max-width:150px;display:inline-flex;align-items:center;gap:6px;overflow:hidden;padding:3px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;text-overflow:ellipsis;white-space:nowrap}.dsh-tool-chip b{flex:none;font-size:10px;font-weight:620;color:var(--dsw-alias-state-business-primary);font-variant-numeric:tabular-nums}.dsh-tool-chip.is-mcp{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 38%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,var(--dsw-alias-bg-layer-1))}.dsh-tool-chip.is-skill{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 38%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,var(--dsw-alias-bg-layer-1))}.dsh-tool-chip.is-skill b{color:var(--dsw-alias-state-success-primary)}.dsh-tool-kind.is-mcp{color:var(--dsw-alias-state-business-primary)}.dsh-tool-kind.is-skill{color:var(--dsw-alias-state-success-primary)}";
      style.textContent += ".dsh-traffic-standalone{position:fixed;z-index:1000;right:14px;top:56px;display:flex;align-items:center;padding:8px 10px;border-radius:999px;background:linear-gradient(180deg,#2b2b2b 0%,#171717 100%);border:1px solid rgba(255,255,255,.08);box-shadow:inset 0 1px 2px rgba(255,255,255,.12),0 6px 16px rgba(0,0,0,.25)}.dsh-traffic-standalone .dsh-traffic-lamps{display:flex;align-items:center;gap:8px}.dsh-traffic-standalone .dsh-traffic-lamp{width:20px;height:20px;border-radius:50%;background:#252525;border:2px solid #0c0c0c;box-shadow:inset 0 0 6px rgba(255,255,255,.05),inset 0 -4px 8px rgba(0,0,0,.5);transition:background .25s ease,box-shadow .25s ease}.dsh-traffic-standalone .dsh-traffic-lamp.is-red.is-on{background:#ff3131;box-shadow:0 0 8px #ff3131,0 0 18px rgba(255,49,49,.7),0 0 28px rgba(255,49,49,.35),inset 0 0 8px rgba(255,255,255,.4)}.dsh-traffic-standalone .dsh-traffic-lamp.is-yellow.is-on{background:#ffb800;box-shadow:0 0 8px #ffb800,0 0 18px rgba(255,184,0,.7),0 0 28px rgba(255,184,0,.35),inset 0 0 8px rgba(255,255,255,.4)}.dsh-traffic-standalone .dsh-traffic-lamp.is-green.is-on{background:#22c55e;box-shadow:0 0 8px #22c55e,0 0 18px rgba(34,197,94,.7),0 0 28px rgba(34,197,94,.35),inset 0 0 8px rgba(255,255,255,.4)}@media(max-width:1279px){.dsh-traffic-standalone{top:10px}}";
      style.textContent += ".dsh-cost-panel{overflow-y:auto}.dsh-cost-symbol{color:#9A8B63}.dsh-sess-head{position:sticky;top:0;z-index:2;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px 16px 11px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}.dsh-sess-head strong{display:block;font-size:14px;font-weight:620}.dsh-sess-head small{display:block;margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:10px}.dsh-sess-close{width:26px;height:26px;display:grid;place-items:center;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:20px;line-height:1;cursor:pointer}.dsh-sess-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dsh-sess-status{display:flex;align-items:center;gap:8px;padding:10px 16px 6px}.dsh-sess-status strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:610}.dsh-sess-status small{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}.dsh-sess-dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--dsw-alias-label-tertiary)}.dsh-sess-dot.is-active{background:#3E9B6D;box-shadow:0 0 0 3px color-mix(in srgb,#3E9B6D 12%,transparent)}.dsh-sess-dot.is-warning{background:#C99B3F}.dsh-sess-kpis{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:6px 16px 0}.dsh-sess-kpi{min-width:0;display:grid;gap:3px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}.dsh-sess-kpi span{color:var(--dsw-alias-label-tertiary);font-size:10px}.dsh-sess-kpi strong{font-size:16px;font-weight:630;font-variant-numeric:tabular-nums;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-sess-kpi.is-money strong{color:#9A8B63}.dsh-sess-section{padding-top:2px}.dsh-sess-section-title{display:flex;align-items:center;gap:10px;margin:12px 16px 0;color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:600;letter-spacing:.6px;white-space:nowrap}.dsh-sess-section-title::before,.dsh-sess-section-title::after{content:'';flex:1;height:1px;background:var(--dsw-alias-border-l1)}.dsh-sess-spark{margin:8px 16px 2px;padding:0}.dsh-sess-spark svg{display:block;width:100%;height:40px}.dsh-sess-spark-line{fill:none;stroke:#6B7C8F;stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}.dsh-sess-spark-area{fill:color-mix(in srgb,#6B7C8F 14%,transparent)}.dsh-sess-balances{display:grid;gap:1px;margin:10px 16px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;overflow:hidden;background:var(--dsw-alias-border-l1)}.dsh-sess-balance-row{min-height:36px;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px;padding:7px 10px;background:var(--dsw-alias-bg-layer-1)}.dsh-sess-balance-row span{color:var(--dsw-alias-label-tertiary);font-size:11px}.dsh-sess-balance-row strong{font-size:12px;font-weight:620;font-variant-numeric:tabular-nums}.dsh-sess-balance-row small{grid-column:2/-1;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary));font-size:10px;margin-top:-2px}.dsh-sess-balance-row.is-warning strong{color:#B56F00}.dsh-sess-model-list{display:grid;gap:1px;margin:10px 16px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;overflow:hidden;background:var(--dsw-alias-border-l1)}.dsh-sess-model-row{min-height:38px;display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;gap:8px;padding:0 10px;border:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;text-align:left}.dsh-sess-model-row:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-sess-model-row.is-current{background:color-mix(in srgb,#6B7C8F 7%,var(--dsw-alias-bg-layer-1))}.dsh-sess-row-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}.dsh-sess-row-dot.is-current{background:#3E9B6D}.dsh-sess-row-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:540}.dsh-sess-model-row strong{font-size:12px;font-weight:620;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}.dsh-sess-model-row.is-unpriced strong{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary))}.dsh-sess-warning{margin:8px 16px 0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary));font-size:11px;line-height:17px}.dsh-sess-empty{margin:10px 16px 0;padding:14px 12px;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:9px}.dsh-sess-empty strong{display:block;font-size:12px;font-weight:600}.dsh-sess-empty span{display:block;margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px}.dsh-sess-tools{padding-bottom:4px}.dsh-sess-toolgroup{display:grid;gap:6px;padding:10px 16px 0}.dsh-sess-toolgroup-head{display:flex;align-items:center;gap:7px}.dsh-sess-toolgroup-head span{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600}.dsh-sess-toolgroup-head b{margin-left:auto;font-size:10px;font-weight:650;font-variant-numeric:tabular-nums}.dsh-sess-tool-dot{width:6px;height:6px;flex:none;border-radius:50%}.dsh-sess-toolchips{display:flex;flex-wrap:wrap;gap:6px}.dsh-sess-toolchip{max-width:150px;display:inline-flex;align-items:center;gap:6px;overflow:hidden;padding:3px 8px;border:1px solid;border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;text-overflow:ellipsis;white-space:nowrap;background:var(--dsw-alias-bg-layer-1)}.dsh-sess-toolchip b{flex:none;font-size:10px;font-weight:620;font-variant-numeric:tabular-nums}.dsh-sess-toolgroup.is-tools{--tool-accent:#6B7C8F}.dsh-sess-toolgroup.is-mcp{--tool-accent:#9A8B63}.dsh-sess-toolgroup.is-skills{--tool-accent:#4E8A6A}.dsh-sess-tool-dot{background:var(--tool-accent)}.dsh-sess-toolgroup-head b{color:var(--tool-accent)}.dsh-sess-toolchip{border-color:color-mix(in srgb,var(--tool-accent) 30%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--tool-accent) 7%,var(--dsw-alias-bg-layer-1))}.dsh-sess-toolchip b{color:var(--tool-accent)}.dsh-sess-foot{padding:12px 16px 14px}.dsh-sess-manage{width:100%;height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}.dsh-sess-manage:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-model-detail-price strong{color:#9A8B63}";
      document.head.appendChild(style);
      ctx.effect(() => () => style.remove(), "desktop billing styles");
      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
        name: "conversation.session.header.utilities", id: "desktop-billing-cost", order: -10,
        inject: (sessionId) => ({
          sessionId,
          modelDirectory: ctx.modelDirectories.directoryFor(sessionId).store,
          sessionsList: ctx.sessions.list,
          workspacesList: ctx.workspaces.list
        })
      }, UsageMeter));
      ctx.effect(() => {
        // 会话状态红绿灯：独立常驻组件，固定在会话信息弹窗上方（不随弹窗开关）。
        // 判定：working —— 会话容器内持续有 DOM 变化（agent 流式生成必然渲染消息，
        // 排除我们自己的 dsh-* 节点防自触发），2 秒无变化即空闲；failed —— 主进程
        // 内存错误缓存（getRecentErrors，60s 内）。状态机：working(黄) > failed(红)
        // > idle(绿)。只显示三盏灯，无文字。
        const trafficHost = document.createElement("div");
        trafficHost.className = "dsh-traffic-standalone";
        trafficHost.setAttribute("role", "status");
        trafficHost.setAttribute("aria-label", "对话状态");
        const lampsWrap = document.createElement("span");
        lampsWrap.className = "dsh-traffic-lamps";
        const lampRed = document.createElement("i");
        lampRed.className = "dsh-traffic-lamp is-red";
        const lampYellow = document.createElement("i");
        lampYellow.className = "dsh-traffic-lamp is-yellow";
        const lampGreen = document.createElement("i");
        lampGreen.className = "dsh-traffic-lamp is-green";
        lampsWrap.appendChild(lampRed);
        lampsWrap.appendChild(lampYellow);
        lampsWrap.appendChild(lampGreen);
        trafficHost.appendChild(lampsWrap);
        document.body.appendChild(trafficHost);
        const setStatus = (status) => {
          trafficHost.dataset.status = status;
          lampRed.classList.toggle("is-on", status === "red");
          lampYellow.classList.toggle("is-on", status === "yellow");
          lampGreen.classList.toggle("is-on", status === "green");
        };
        setStatus("green");
        let activityAt = 0;
        let errorCheckedAt = 0;
        const mark = () => { activityAt = Date.now(); };
        let throttle = 0;
        const observer = new MutationObserver((mutations) => {
          let active = false;
          for (const mutation of mutations) {
            if (active) break;
            for (const node of mutation.addedNodes) {
              const element = node instanceof Element ? node : node.parentElement;
              if (element && element.className && String(element.className).includes("dsh-")) continue;
              active = true;
              break;
            }
          }
          if (active) {
            clearTimeout(throttle);
            throttle = window.setTimeout(mark, 0);
          }
        });
        const attach = () => {
          const composer = findComposerInput();
          const host = composer?.closest('[role="dialog"]') || document.body;
          observer.observe(host, { childList: true, subtree: true });
        };
        attach();
        const reattach = new MutationObserver(attach);
        reattach.observe(document.body, { childList: true, subtree: true });
        const timer = window.setInterval(() => {
          const now = Date.now();
          const working = now - activityAt < 2_000;
          const checkErrors = now - errorCheckedAt >= 5_000;
          const apply = (errors) => {
            if (errors && errors.length > 0 && !working) setStatus("red");
            else if (working) setStatus("yellow");
            else setStatus("green");
          };
          if (checkErrors) {
            errorCheckedAt = now;
            window.desktop?.getRecentErrors?.(60_000).then(apply).catch(() => apply(null));
          } else {
            apply(null);
          }
        }, 500);
        return () => {
          window.clearInterval(timer);
          window.clearTimeout(throttle);
          observer.disconnect();
          reattach.disconnect();
          trafficHost.remove();
        };
      }, "desktop agent traffic light");
      ctx.effect(() => {
        // composer 图片拦截（仅复制粘贴路径，用户选择的上传方式）：粘贴图片且
        // 视觉解析开启、主模型不支持图片时，把图片存盘、插入「[已保存图片: <id>]」
        // 纯文本占位，消息以纯文本发出，宿主图片门禁不触发。主模型支持图片时
        // 放行，宿主原生附件路径全流程可用。拖放上传保持宿主原样不改动。
        // policy/能力走内存缓存做同步判定并同步 preventDefault：异步判定在事件
        // 派发完成后才执行，图片已被浏览器默认行为插入。window 捕获阶段
        // stopImmediatePropagation 截断传播：宿主无视 preventDefault 自行插入
        // 图片附件（发送时触发门禁），截断后宿主在 document/目标/冒泡层的监听
        // 收不到粘贴事件。
        // 直接按事件目标定位输入框：粘贴时焦点就在 composer 上，target.closest
        // 命中 textarea/contenteditable。不依赖 findComposerInput 的「窗口底部
        // 62% 以下」位置启发式——新会话欢迎页布局不同，那个启发式会漏判。
        const composerAt = (event) => {
          const target = event.target;
          if (!target || typeof target.closest !== "function") return null;
          return target.closest('textarea, [contenteditable="true"]') || null;
        };
        const imageFromEvent = (event) => {
          if (event.clipboardData) {
            for (const item of event.clipboardData.items)
              if (item.kind === "file" && item.type.startsWith("image/")) return item.getAsFile();
          }
          return null;
        };
        const reportUserAction = (type, fields) => {
          window.desktop?.appendEventLog?.({ area: "user-action", type, ...fields }).catch(() => {});
        };
        const insertImage = (composer, file) => {
          if (file.size > 20 * 1024 * 1024) {
            desktopNotify("图片不能超过 20 MB", "error");
            reportUserAction("paste-image-skipped", { reason: "too-large", bytes: file.size });
            return;
          }
          const reader = new FileReader();
          reader.onload = async () => {
            try {
              const saved = await window.desktop.saveVisionImage(String(reader.result));
              insertComposerText(composer, "[已保存图片: " + saved.imageId + "]");
              desktopNotify("图片已保存，发送后模型可查看", "success");
              reportUserAction("paste-image-intercepted", { imageId: saved.imageId, mimeType: saved.mimeType });
            } catch (cause) {
              desktopNotify(cause instanceof Error ? cause.message : String(cause), "error", true);
              reportUserAction("paste-image-failed", { message: cause instanceof Error ? cause.message : String(cause) });
            }
          };
          reader.onerror = () => {
            desktopNotify("读取图片失败", "error");
            reportUserAction("paste-image-failed", { message: "读取图片失败" });
          };
          reader.readAsDataURL(file);
        };
        const shouldIntercept = () => {
          refreshVisionPolicy();
          if (visionPolicy === "off") return false;
          if (visionPolicy === "auto" && currentModelRef.capable === true) return false;
          return true;
        };
        const intercept = (event) => {
          const composer = composerAt(event);
          if (!composer) {
            reportUserAction("paste-image-skipped", { reason: "no-composer" });
            return;
          }
          const file = imageFromEvent(event);
          if (!file) return;
          if (!shouldIntercept()) {
            reportUserAction("paste-image-skipped", {
              reason: visionPolicy === "off" ? "policy-off" : "model-capable",
              policy: visionPolicy,
              modelCapable: currentModelRef.capable,
            });
            return;
          }
          event.preventDefault();
          event.stopImmediatePropagation();
          insertImage(composer, file);
        };
        window.addEventListener("paste", intercept, true);
        return () => {
          window.removeEventListener("paste", intercept, true);
        };
      }, "desktop vision composer interception");
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section", id: "desktop-memory", order: 90,
        label: () => "记忆"
      }, MemoryCard));
      ctx.effect(() => {
        // Harness 的 settings.section 导航只透传 {id, order, label}，icon 由
        // 前端 navIcon(id) 硬编码：未知 id 一律回退到「通用设置」同款齿轮。
        // 且 Harness 的 Icon 组件渲染为裸 <svg>（非 span 包裹），所以这里在
        // DOM 层把「记忆」导航项的 svg 内容替换成专属记忆图标，并兜底字体与
        // 其它导航项（navCell 14px/400）保持一致。替换前先比对已有 path 的 d
        // 保证幂等：React 重渲染 navCell 时 fiber 认为 icon props 未变就不触碰
        // 该节点，即便被重建回齿轮，observer 也会再次替换；content 比对同时
        // 天然阻止我们自己写入触发的 observer 循环。
        const CLOCK = "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8";
        const decorate = () => {
          const dialogs = document.querySelectorAll('[role="dialog"]');
          for (const dialog of dialogs) {
            const navs = dialog.querySelectorAll('nav');
            for (const nav of navs) {
              const buttons = nav.querySelectorAll('button');
              for (const btn of buttons) {
                const spans = btn.querySelectorAll('span');
                const label = spans[spans.length - 1];
                if (!label || label.textContent !== '记忆') continue;
                const icon = btn.firstElementChild;
                const svg = icon && icon.tagName === 'svg' ? icon : (icon && icon.querySelector('svg'));
                if (!svg) continue;
                const existing = svg.querySelector('path');
                if (existing && existing.getAttribute('d') === CLOCK) continue;
                btn.dataset.dshMemoryNav = '1';
                while (svg.firstChild) svg.removeChild(svg.firstChild);
                svg.setAttribute('viewBox', '0 0 24 24');
                svg.setAttribute('fill', 'none');
                svg.setAttribute('stroke', 'currentColor');
                svg.setAttribute('stroke-width', '2');
                svg.setAttribute('stroke-linecap', 'round');
                svg.setAttribute('stroke-linejoin', 'round');
                const NS = "http://www.w3.org/2000/svg";
                for (const d of [CLOCK, "M3 3v5h5", "M12 7v5l4 2"]) {
                  const p = document.createElementNS(NS, "path");
                  p.setAttribute("d", d);
                  svg.appendChild(p);
                }
                btn.style.fontFamily = 'inherit';
                btn.style.fontSize = '14px';
                btn.style.fontWeight = '400';
                btn.style.lineHeight = '22px';
              }
            }
          }
        };
        const observer = new MutationObserver(decorate);
        observer.observe(document.documentElement, { childList: true, subtree: true });
        decorate();
        return () => observer.disconnect();
      }, 'desktop memory settings nav decoration');
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section", id: "desktop-vision", order: 91,
        label: () => "视觉"
      }, VisionCard));
      ctx.effect(() => {
        // 与记忆卡同款：Harness 的 settings.section 导航 icon 由 navIcon(id) 硬编码
        // 回退到齿轮，这里在 DOM 层把「视觉」导航项的 svg 换成图片图标（矩形+山+太阳），
        // 按已有 path 的 d 幂等，避免 observer 循环。
        const IMAGE = "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z";
        const SUN = "M9 12a3 3 0 1 0 6 0a3 3 0 0 0-6 0";
        const decorate = () => {
          const dialogs = document.querySelectorAll('[role="dialog"]');
          for (const dialog of dialogs) {
            const navs = dialog.querySelectorAll('nav');
            for (const nav of navs) {
              const buttons = nav.querySelectorAll('button');
              for (const btn of buttons) {
                const spans = btn.querySelectorAll('span');
                const label = spans[spans.length - 1];
                if (!label || label.textContent !== '视觉') continue;
                const icon = btn.firstElementChild;
                const svg = icon && icon.tagName === 'svg' ? icon : (icon && icon.querySelector('svg'));
                if (!svg) continue;
                const existing = svg.querySelector('path');
                if (existing && existing.getAttribute('d') === IMAGE) continue;
                btn.dataset.dshVisionNav = '1';
                while (svg.firstChild) svg.removeChild(svg.firstChild);
                svg.setAttribute('viewBox', '0 0 24 24');
                svg.setAttribute('fill', 'none');
                svg.setAttribute('stroke', 'currentColor');
                svg.setAttribute('stroke-width', '2');
                svg.setAttribute('stroke-linecap', 'round');
                svg.setAttribute('stroke-linejoin', 'round');
                const NS = "http://www.w3.org/2000/svg";
                for (const d of [IMAGE, SUN, "M3 17l5-5 4 4 3-3 6 6"]) {
                  const p = document.createElementNS(NS, "path");
                  p.setAttribute("d", d);
                  svg.appendChild(p);
                }
                btn.style.fontFamily = 'inherit';
                btn.style.fontSize = '14px';
                btn.style.fontWeight = '400';
                btn.style.lineHeight = '22px';
              }
            }
          }
        };
        const observer = new MutationObserver(decorate);
        observer.observe(document.documentElement, { childList: true, subtree: true });
        decorate();
        return () => observer.disconnect();
      }, 'desktop vision settings nav decoration');
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section", id: "desktop-image", order: 93,
        label: () => "生图"
      }, ImageCard));
      ctx.effect(() => {
        // 与记忆/视觉/日志卡同款：把「生图」导航项的 svg 换成画笔图标，按 path d 幂等。
        const PEN = "M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z";
        const LINE = "M15 5l4 4";
        const decorate = () => {
          const dialogs = document.querySelectorAll('[role="dialog"]');
          for (const dialog of dialogs) {
            const navs = dialog.querySelectorAll('nav');
            for (const nav of navs) {
              const buttons = nav.querySelectorAll('button');
              for (const btn of buttons) {
                const spans = btn.querySelectorAll('span');
                const label = spans[spans.length - 1];
                if (!label || label.textContent !== '生图') continue;
                const icon = btn.firstElementChild;
                const svg = icon && icon.tagName === 'svg' ? icon : (icon && icon.querySelector('svg'));
                if (!svg) continue;
                const existing = svg.querySelector('path');
                if (existing && existing.getAttribute('d') === PEN) continue;
                btn.dataset.dshImageNav = '1';
                while (svg.firstChild) svg.removeChild(svg.firstChild);
                svg.setAttribute('viewBox', '0 0 24 24');
                svg.setAttribute('fill', 'none');
                svg.setAttribute('stroke', 'currentColor');
                svg.setAttribute('stroke-width', '2');
                svg.setAttribute('stroke-linecap', 'round');
                svg.setAttribute('stroke-linejoin', 'round');
                const NS = "http://www.w3.org/2000/svg";
                for (const d of [PEN, LINE]) {
                  const p = document.createElementNS(NS, "path");
                  p.setAttribute("d", d);
                  svg.appendChild(p);
                }
                btn.style.fontFamily = 'inherit';
                btn.style.fontSize = '14px';
                btn.style.fontWeight = '400';
                btn.style.lineHeight = '22px';
              }
            }
          }
        };
        const observer = new MutationObserver(decorate);
        observer.observe(document.documentElement, { childList: true, subtree: true });
        decorate();
        return () => observer.disconnect();
      }, 'desktop image settings nav decoration');
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section", id: "desktop-event-log", order: 92,
        label: () => "日志"
      }, LogCard));
      ctx.effect(() => {
        // 与记忆/视觉卡同款：把「日志」导航项的 svg 换成文档图标（页面+折线），
        // 按已有 path 的 d 幂等，避免 observer 循环。
        const DOC = "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z";
        const FOLD = "M14 2v6h6";
        const LINE = "M8 13h8";
        const decorate = () => {
          const dialogs = document.querySelectorAll('[role="dialog"]');
          for (const dialog of dialogs) {
            const navs = dialog.querySelectorAll('nav');
            for (const nav of navs) {
              const buttons = nav.querySelectorAll('button');
              for (const btn of buttons) {
                const spans = btn.querySelectorAll('span');
                const label = spans[spans.length - 1];
                if (!label || label.textContent !== '日志') continue;
                const icon = btn.firstElementChild;
                const svg = icon && icon.tagName === 'svg' ? icon : (icon && icon.querySelector('svg'));
                if (!svg) continue;
                const existing = svg.querySelector('path');
                if (existing && existing.getAttribute('d') === DOC) continue;
                btn.dataset.dshLogNav = '1';
                while (svg.firstChild) svg.removeChild(svg.firstChild);
                svg.setAttribute('viewBox', '0 0 24 24');
                svg.setAttribute('fill', 'none');
                svg.setAttribute('stroke', 'currentColor');
                svg.setAttribute('stroke-width', '2');
                svg.setAttribute('stroke-linecap', 'round');
                svg.setAttribute('stroke-linejoin', 'round');
                const NS = "http://www.w3.org/2000/svg";
                for (const d of [DOC, FOLD, LINE]) {
                  const p = document.createElementNS(NS, "path");
                  p.setAttribute("d", d);
                  svg.appendChild(p);
                }
                btn.style.fontFamily = 'inherit';
                btn.style.fontSize = '14px';
                btn.style.fontWeight = '400';
                btn.style.lineHeight = '22px';
              }
            }
          }
        };
        const observer = new MutationObserver(decorate);
        observer.observe(document.documentElement, { childList: true, subtree: true });
        decorate();
        return () => observer.disconnect();
      }, 'desktop event log settings nav decoration');
      window.postMessage({ type: READY }, window.location.origin);
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});`;

function injectDesktopClient(html: string): string {
  const row = JSON.stringify({
    id: CLIENT_PLUGIN_ID,
    url: CLIENT_PLUGIN_PATH,
    rev: "4",
    inject: ["workspaces", "sessions", "slots", "modelDirectories"],
    immediately: true,
  });
  const script = `<script>(function(w){function add(g){if(g&&Array.isArray(g.entries)&&!g.entries.some(function(e){return e.id===${JSON.stringify(CLIENT_PLUGIN_ID)}})){g.entries.push(${row});}}if(w.__DSH_BOOT__){add(w.__DSH_BOOT__);return;}Object.defineProperty(w,"__DSH_BOOT__",{configurable:true,set:function(g){add(g);Object.defineProperty(w,"__DSH_BOOT__",{configurable:true,writable:true,value:g});}});})(window);</script>`;
  const head = html.indexOf("<head>");
  return head === -1
    ? `${script}${html}`
    : `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`;
}

interface BridgeResponse {
  path?: unknown;
  error?: unknown;
}

function bridgeConfiguration(): { port: number; token: string } {
  const port = Number(process.env.DSH_DESKTOP_BRIDGE_PORT);
  const token = process.env.DSH_DESKTOP_BRIDGE_TOKEN ?? "";
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    token.length < 32
  ) {
    throw new Error("desktop directory picker bridge is not configured");
  }
  return { port, token };
}

export async function pickDirectoryThroughElectron(
  signal: AbortSignal,
): Promise<string | null> {
  const { port, token } = bridgeConfiguration();
  const response = await fetch(`http://127.0.0.1:${port}/pick-directory`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  const body = (await response.json()) as BridgeResponse;
  if (!response.ok) {
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : `desktop directory picker failed (${response.status})`,
    );
  }
  if (body.path === null) return null;
  if (typeof body.path !== "string" || body.path.length === 0) {
    throw new Error("desktop directory picker returned an invalid path");
  }
  return body.path;
}

/**
 * webServer 是宿主在运行时注入的服务，应用侧没有它的类型声明。这里按使用面
 * 声明最小接口，避免退化成 any。register/tapIndex 返回的 disposer 正好是
 * `ctx.effect()` 期望的 effect body 返回值。
 */
interface DesktopWebServer {
  register(options: {
    kind: "exact";
    path: string;
    handler: (
      request: unknown,
      response: import("node:http").ServerResponse,
    ) => void;
  }): () => void;
  tapIndex(callback: (html: string) => string): () => void;
}

export default class ElectronDirectoryPicker extends DirectoryPicker {
  constructor(ctx: ConstructorParameters<typeof DirectoryPicker>[0]) {
    super(ctx);
    ctx.inject(["webServer"], (httpCtx) => {
      // 只有宿主根上下文挂载了 webServer，这里按使用面收窄类型。
      const webServer = (httpCtx as unknown as { webServer: DesktopWebServer })
        .webServer;
      httpCtx.effect(
        () =>
          webServer.register({
            kind: "exact",
            path: CLIENT_PLUGIN_PATH,
            handler: (_request, response) => {
              response.writeHead(200, {
                "content-type": "text/javascript; charset=utf-8",
                "cache-control": "no-store",
              });
              response.end(CLIENT_PLUGIN_SOURCE);
            },
          }),
        "desktop integration client route",
      );
      httpCtx.effect(
        () => webServer.tapIndex(injectDesktopClient),
        "desktop integration client bootstrap",
      );
    });
  }

  private readonly nativeCapability = {
    kind: "native" as const,
    pick: (signal: AbortSignal) => pickDirectoryThroughElectron(signal),
  };

  capability(): typeof this.nativeCapability {
    return this.nativeCapability;
  }
}
