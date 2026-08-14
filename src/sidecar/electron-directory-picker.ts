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
    const inject = ["workspaces", "sessions", "slots"];
    const selectRule = (settings, sample) => [...settings.catalog.rules, ...settings.customRules]
      .filter((rule) => rule.provider.trim().toLowerCase() === sample.provider.trim().toLowerCase()
        && rule.model.trim().toLowerCase() === sample.model.trim().toLowerCase()
        && Date.parse(rule.effectiveFrom) <= sample.time)
      .sort((a, b) => Number(b.mode !== "official") - Number(a.mode !== "official") || Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom))[0];
    const ratesAt = (rule, time) => {
      const clock = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(time);
      return rule.peakRates && rule.peakWindows?.some((window) => clock >= window.start && clock < window.end) ? rule.peakRates : rule.rates;
    };
    const costOf = (rule, sample) => {
      if (rule.mode === "free") return 0;
      const rates = ratesAt(rule, sample.time);
      return (sample.uncachedInputTokens * rates.input + sample.cacheReadTokens * rates.cacheRead
        + sample.cacheWriteTokens * rates.cacheWrite + sample.outputTokens * rates.output) / 1e6;
    };
    const money = (currency, value) => new Intl.NumberFormat("zh-CN", { style: "currency", currency, minimumFractionDigits: value < 0.01 ? 4 : 2, maximumFractionDigits: 6 }).format(value);
    const compactTokens = (value) => value >= 1e6 ? (value / 1e6).toFixed(1) + "M" : value >= 1e3 ? (value / 1e3).toFixed(value >= 1e4 ? 0 : 1) + "K" : String(value);
    function UsageMeter({ useProjection }) {
      const usage = useProjection("billingUsage") ?? [];
      const [settings, setSettings] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const rootRef = React.useRef(null);
      React.useEffect(() => {
        let alive = true;
        window.desktop?.getBillingSettings().then((value) => { if (alive) setSettings(value); }).catch(() => {});
        const dispose = window.desktop?.onBillingChanged((value) => setSettings(value));
        return () => { alive = false; dispose?.(); };
      }, []);
      React.useEffect(() => {
        if (!open) return;
        const close = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
        const escape = (event) => { if (event.key === "Escape") setOpen(false); };
        document.addEventListener("pointerdown", close);
        document.addEventListener("keydown", escape);
        return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
      }, [open]);
      if (!settings) return null;
      const totals = new Map();
      let unknown = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      for (const sample of usage) {
        inputTokens += sample.uncachedInputTokens + sample.cacheReadTokens + sample.cacheWriteTokens;
        outputTokens += sample.outputTokens;
        const rule = selectRule(settings, sample);
        if (!rule) { unknown += 1; continue; }
        totals.set(rule.currency, (totals.get(rule.currency) ?? 0) + costOf(rule, sample));
      }
      const summary = [...totals].map(([currency, amount]) => money(currency, amount)).join(" + ");
      const label = summary || (unknown ? "未计价" : "¥0.0000");
      const last = usage[usage.length - 1];
      const lastRule = last ? selectRule(settings, last) : null;
      const h = React.createElement;
      const amountRows = [...totals].map(([currency, amount]) => h("div", { className: "dsh-cost-total", key: currency }, h("span", null, currency + " 预估"), h("strong", null, money(currency, amount))));
      if (!amountRows.length) amountRows.push(h("div", { className: "dsh-cost-total", key: "empty" }, h("span", null, "本会话预估"), h("strong", null, unknown ? "未配置单价" : "¥0.0000")));
      return h("div", { className: "dsh-cost-meter", ref: rootRef },
        h("button", { type: "button", className: "dsh-cost-trigger", "aria-expanded": open, onClick: () => setOpen(!open) },
          h("span", { className: "dsh-cost-symbol", "aria-hidden": "true" }, "¥"),
          h("span", { className: "dsh-cost-label" }, "本会话 " + label),
          h("span", { className: "dsh-cost-chevron", "aria-hidden": "true" }, open ? "▴" : "▾")
        ),
        open && h("div", { className: "dsh-cost-popover", role: "dialog", "aria-label": "本会话用量与费用" },
          h("div", { className: "dsh-cost-heading" }, h("div", null, h("strong", null, "本会话用量"), h("small", null, "本地估算，以供应商账单为准"))),
          h("div", { className: "dsh-cost-totals" }, amountRows),
          h("div", { className: "dsh-cost-facts" },
            h("div", null, h("span", null, "模型请求"), h("strong", null, String(usage.length) + " 次")),
            h("div", null, h("span", null, "输入 Token"), h("strong", null, compactTokens(inputTokens))),
            h("div", null, h("span", null, "输出 Token"), h("strong", null, compactTokens(outputTokens))),
            h("div", null, h("span", null, "当前模型"), h("strong", { title: last ? last.provider + "/" + last.model : "" }, last ? last.model : "—"))
          ),
          unknown > 0 && h("div", { className: "dsh-cost-warning" }, unknown + " 次请求未配置价格，不计入金额。"),
          last && !lastRule && h("div", { className: "dsh-cost-route" }, last.provider + " / " + last.model),
          h("button", { type: "button", className: "dsh-cost-manage", onClick: () => window.desktop?.openBilling() }, "管理价格与规则")
        )
      );
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
      style.textContent = ".dsh-cost-meter{position:relative;display:inline-flex;align-items:center}.dsh-cost-trigger{height:32px;display:inline-flex;align-items:center;gap:7px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);padding:0 11px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}.dsh-cost-trigger:hover,.dsh-cost-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dsh-cost-symbol{width:18px;height:18px;display:grid;place-items:center;border-radius:50%;background:var(--dsw-alias-bg-module-platform);font-size:11px;font-weight:650;color:var(--dsw-alias-state-business-primary)}.dsh-cost-chevron{font-size:9px;color:var(--dsw-alias-label-tertiary)}.dsh-cost-popover{position:absolute;z-index:1000;right:0;top:calc(100% + 9px);width:318px;border:1px solid var(--dsw-alias-border-l2);border-radius:13px;background:var(--dsw-alias-bg-base);box-shadow:0 14px 42px rgba(0,0,0,.16);padding:14px;color:var(--dsw-alias-label-primary)}.dsh-cost-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.dsh-cost-heading strong{display:block;font-size:13px;font-weight:610}.dsh-cost-heading small{display:block;color:var(--dsw-alias-label-tertiary);font-size:10px;margin-top:2px}.dsh-cost-totals{display:grid;gap:5px;padding:10px 11px;border-radius:9px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}.dsh-cost-total{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.dsh-cost-total span{color:var(--dsw-alias-label-tertiary);font-size:11px}.dsh-cost-total strong{font-size:16px;font-weight:620;font-variant-numeric:tabular-nums}.dsh-cost-facts{display:grid;grid-template-columns:1fr 1fr;gap:9px 14px;padding:13px 2px}.dsh-cost-facts div{min-width:0}.dsh-cost-facts span{display:block;color:var(--dsw-alias-label-tertiary);font-size:10px}.dsh-cost-facts strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:550;margin-top:2px}.dsh-cost-warning{border-top:1px solid var(--dsw-alias-border-l1);padding:9px 2px;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary));font-size:10px;line-height:16px}.dsh-cost-route{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:9px;margin:-4px 2px 9px}.dsh-cost-manage{width:100%;height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;cursor:pointer}.dsh-cost-manage:hover{background:var(--dsw-alias-interactive-bg-hover)}@media(max-width:900px){.dsh-cost-trigger{width:32px;padding:0;justify-content:center}.dsh-cost-label,.dsh-cost-chevron{display:none}.dsh-cost-symbol{background:transparent}.dsh-cost-popover{position:fixed;right:12px;top:58px;width:min(318px,calc(100vw - 24px))}}";
      document.head.appendChild(style);
      ctx.effect(() => () => style.remove(), "desktop billing styles");
      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
        name: "conversation.session.header.utilities", id: "desktop-billing-cost", order: -10
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
    inject: ["workspaces", "sessions", "slots"],
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
