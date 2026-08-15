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
    const money = (currency, nanos) => {
      const value = Number(BigInt(nanos)) / 1e9;
      return new Intl.NumberFormat("zh-CN", { style: "currency", currency, minimumFractionDigits: value < 0.01 ? 4 : 2, maximumFractionDigits: 6 }).format(value);
    };
    const compactTokens = (value) => value >= 1e6 ? (value / 1e6).toFixed(1) + "M" : value >= 1e3 ? (value / 1e3).toFixed(value >= 1e4 ? 0 : 1) + "K" : String(value);
    function UsageMeter({ useProjection, modelDirectory, sessionsList, sessionId }) {
      const usage = useProjection("billingUsage") ?? [];
      const modelState = React.useSyncExternalStore(
        (listener) => modelDirectory.subscribe(listener),
        () => modelDirectory.getSnapshot()
      );
      const sessionsState = React.useSyncExternalStore(
        (listener) => sessionsList.subscribe(listener),
        () => sessionsList.getSnapshot()
      );
      const [report, setReport] = React.useState(null);
      const [billingRevision, setBillingRevision] = React.useState(0);
      const [wide, setWide] = React.useState(false);
      const [open, setOpen] = React.useState(false);
      const [detail, setDetail] = React.useState(null);
      const rootRef = React.useRef(null);
      const selected = modelState?.current ?? usage[usage.length - 1] ?? null;
      React.useEffect(() => window.desktop?.onBillingChanged(() => setBillingRevision((value) => value + 1)), []);
      React.useEffect(() => {
        const sessions = (sessionsState.ids ?? []).map((id) => {
          const summary = sessionsState.byId?.[id] ?? {};
          const projected = summary.projectionValues?.billingUsage;
          return {
            sessionId: id,
            title: summary.displayTitle || summary.title || "未命名对话",
            samples: id === sessionId ? usage : (Array.isArray(projected) ? projected : [])
          };
        });
        if (sessionId && !sessions.some((session) => session.sessionId === sessionId)) {
          sessions.push({ sessionId, title: "当前对话", samples: usage });
        }
        let alive = true;
        const target = selected?.provider && selected?.model ? { provider: selected.provider, model: selected.model } : undefined;
        window.desktop?.reportBillingUsage({ collectedAt: new Date().toISOString(), sessions }, target)
          .then((value) => { if (alive) setReport(value); })
          .catch((error) => { if (alive) setReport({ error: error instanceof Error ? error.message : String(error) }); });
        return () => { alive = false; };
      }, [sessionsState, sessionId, usage, selected?.provider, selected?.model, billingRevision]);
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
      const totals = session.totals;
      const models = new Map(session.models.map((model) => {
        const key = JSON.stringify([model.provider, model.model]);
        return [key, { ...model, key, input: model.inputTokens + model.cacheReadTokens + model.cacheWriteTokens, cache: model.cacheReadTokens + model.cacheWriteTokens, output: model.outputTokens, unknown: model.unpricedRequests, pricing: model.currentPricing, rule: model.currentPricing?.rule ?? null }];
      }));
      const unknown = session.unpricedRequests, inputTokens = session.inputTokens + session.cacheReadTokens + session.cacheWriteTokens, outputTokens = session.outputTokens;
      const summary = totals.map(({ currency, nanos }) => money(currency, nanos)).join(" + ");
      const label = summary || (unknown ? "未计价" : "¥0.0000");
      const currentKey = selected?.provider && selected?.model ? JSON.stringify([selected.provider, selected.model]) : null;
      if (currentKey && !models.has(currentKey)) {
        models.set(currentKey, { key: currentKey, provider: selected.provider, model: selected.model, requests: 0, input: 0, cache: 0, output: 0, unknown: 0, totals: [], pricing: report.currentTarget?.pricing ?? null, rule: report.currentTarget?.pricing?.rule ?? null });
      }
      const current = currentKey ? models.get(currentKey) : null;
      const previous = [...models.values()].filter((model) => model.key !== currentKey).reverse();
      const orderedModels = current ? [current, ...previous] : previous;
      const detailModel = detail ? models.get(detail.key) : null;
      const modelAmount = (model) => model.totals.map(({ currency, nanos }) => money(currency, nanos)).join(" + ") || (model.unknown || !model.rule ? "未配置价格" : "¥0.0000");
      const ruleSummary = (pricing) => {
        if (!pricing) return "尚未匹配价格规则";
        const rates = pricing.rates;
        return pricing.rule.currency + "/百万 Token · " + (pricing.scheduleLabel ? (pricing.isPeak ? "当前高峰价 · " : "当前空闲价 · ") : "") + "输入 " + rates.input + " · 缓存读取 " + rates.cacheRead + " · 缓存写入 " + rates.cacheWrite + " · 输出 " + rates.output;
      };
      const amountRows = totals.map(({ currency, nanos }) => h("div", { className: "dsh-cost-total", key: currency }, h("span", null, currency + " 预估"), h("strong", null, money(currency, nanos))));
      if (!amountRows.length) amountRows.push(h("div", { className: "dsh-cost-total", key: "empty" }, h("span", null, "本会话预估"), h("strong", null, unknown ? "未配置单价" : "¥0.0000")));
      const openModelDetail = (event, model) => {
        const top = Math.min(Math.max(12, event.currentTarget.getBoundingClientRect().top - 8), Math.max(12, window.innerHeight - 356));
        setDetail(detail?.key === model.key ? null : { key: model.key, top });
      };
      const modelRow = (model) => h("button", {
        type: "button", className: "dsh-model-row" + (model.key === currentKey ? " is-current" : "") + (!model.rule ? " is-unpriced" : ""), key: model.key,
        "aria-expanded": detail?.key === model.key, onClick: (event) => openModelDetail(event, model)
      }, h("span", { className: "dsh-model-row-name", title: model.provider + "/" + model.model }, model.model),
        h("span", { className: "dsh-current-dot" + (model.key === currentKey ? "" : " is-placeholder"), title: model.key === currentKey ? "当前模型" : "", "aria-hidden": "true" }),
        h("strong", null, modelAmount(model)), h("span", { className: "dsh-model-row-chevron", "aria-hidden": "true" }, "›"));
      return h("div", { className: "dsh-cost-meter", ref: rootRef, "data-open": open ? "true" : "false", "data-wide": wide ? "true" : "false" },
        h("button", { type: "button", className: "dsh-cost-trigger", "aria-expanded": open, "aria-label": "查看用量与费用", onClick: () => setOpen(!open) },
          h("span", { className: "dsh-cost-symbol", "aria-hidden": "true" }, "¥"),
          h("span", { className: "dsh-cost-label" }, "本会话 " + label),
          h("span", { className: "dsh-cost-chevron", "aria-hidden": "true" }, open ? "▴" : "▾")),
        open && !wide && h("button", { type: "button", className: "dsh-cost-backdrop", "aria-label": "关闭用量侧栏", onClick: () => setOpen(false) }),
        open && h("aside", { className: "dsh-cost-panel", "aria-label": "本会话用量与费用" },
          h("div", { className: "dsh-panel-heading" },
            h("div", null, h("strong", null, "用量与费用"), h("small", null, "本地估算 · 供应商账单为准")),
            h("button", { type: "button", className: "dsh-panel-close", "aria-label": "收起侧栏", onClick: () => { setDetail(null); setOpen(false); } }, "×")),
          h("div", { className: "dsh-cost-totals" }, amountRows),
          session.requests > 0 && h("div", { className: "dsh-session-meta" },
            h("span", null, session.requests + " 次请求"), h("span", null, "输入 " + compactTokens(inputTokens)), h("span", null, "输出 " + compactTokens(outputTokens))),
          usage.length === 0 && h("div", { className: "dsh-cost-empty" }, h("strong", null, "还没有模型用量"), h("span", null, "发送消息后，这里会按模型记录 Token 与预估费用。")),
          orderedModels.length > 0 && h("section", { className: "dsh-model-section" }, h("h3", null, "模型费用 · 点击查看详情"), h("div", { className: "dsh-model-list" }, orderedModels.map(modelRow))),
          unknown > 0 && h("div", { className: "dsh-cost-warning" }, unknown + " 次请求未配置价格，金额暂未计入。"),
          report.warnings?.map((warning) => h("div", { className: "dsh-cost-warning", key: warning }, warning)),
          h("div", { className: "dsh-panel-footer" }, h("button", { type: "button", className: "dsh-cost-manage", onClick: () => window.desktop?.openBilling() }, "查看全部用量与价格规则"))),
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
          h("button", { type: "button", className: "dsh-model-fix", onClick: () => window.desktop?.openBilling({ provider: detailModel.provider, model: detailModel.model }) }, detailModel.rule ? "修正此模型价格" : "配置此模型价格")));
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
      document.head.appendChild(style);
      ctx.effect(() => () => style.remove(), "desktop billing styles");
      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
        name: "conversation.session.header.utilities", id: "desktop-billing-cost", order: -10,
        inject: (sessionId) => ({
          sessionId,
          modelDirectory: ctx.modelDirectories.directoryFor(sessionId).store,
          sessionsList: ctx.sessions.list
        })
      }, UsageMeter));
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
    rev: "1",
    inject: ["workspaces", "sessions", "slots", "modelDirectories"],
    immediately: true
  });
  const script = `<script>(function(w){function add(g){if(g&&Array.isArray(g.entries)&&!g.entries.some(function(e){return e.id===${JSON.stringify(CLIENT_PLUGIN_ID)}})){g.entries.push(${row});}}if(w.__DSH_BOOT__){add(w.__DSH_BOOT__);return;}Object.defineProperty(w,"__DSH_BOOT__",{configurable:true,set:function(g){add(g);Object.defineProperty(w,"__DSH_BOOT__",{configurable:true,writable:true,value:g});}});})(window);<\/script>`;
  const head = html.indexOf("<head>");
  return head === -1 ? `${script}${html}` : `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`;
}

interface BridgeResponse {
  path?: unknown;
  error?: unknown;
}

function bridgeConfiguration(): { port: number; token: string } {
  const port = Number(process.env.DSH_DESKTOP_BRIDGE_PORT);
  const token = process.env.DSH_DESKTOP_BRIDGE_TOKEN ?? "";
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || token.length < 32) {
    throw new Error("desktop directory picker bridge is not configured");
  }
  return { port, token };
}

export async function pickDirectoryThroughElectron(signal: AbortSignal): Promise<string | null> {
  const { port, token } = bridgeConfiguration();
  const response = await fetch(`http://127.0.0.1:${port}/pick-directory`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal
  });
  const body = await response.json() as BridgeResponse;
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `desktop directory picker failed (${response.status})`);
  }
  if (body.path === null) return null;
  if (typeof body.path !== "string" || body.path.length === 0) {
    throw new Error("desktop directory picker returned an invalid path");
  }
  return body.path;
}

export default class ElectronDirectoryPicker extends DirectoryPicker {
  constructor(ctx: any) {
    super(ctx);
    ctx.inject(["webServer"], (httpCtx: any) => {
      httpCtx.effect(() => httpCtx.webServer.register({
        kind: "exact",
        path: CLIENT_PLUGIN_PATH,
        handler: (_request: unknown, response: any) => {
          response.writeHead(200, {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store"
          });
          response.end(CLIENT_PLUGIN_SOURCE);
        }
      }), "desktop integration client route");
      httpCtx.effect(() => httpCtx.webServer.tapIndex(injectDesktopClient), "desktop integration client bootstrap");
    });
  }

  private readonly nativeCapability = {
    kind: "native" as const,
    pick: (signal: AbortSignal) => pickDirectoryThroughElectron(signal)
  };

  capability(): typeof this.nativeCapability {
    return this.nativeCapability;
  }
}
