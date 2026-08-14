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
    function CostLine({ useProjection }) {
      const usage = useProjection("billingUsage") ?? [];
      const [settings, setSettings] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        window.desktop?.getBillingSettings().then((value) => { if (alive) setSettings(value); }).catch(() => {});
        const dispose = window.desktop?.onBillingChanged((value) => setSettings(value));
        return () => { alive = false; dispose?.(); };
      }, []);
      if (!settings || usage.length === 0) return null;
      const totals = new Map();
      let unknown = 0;
      for (const sample of usage) {
        const rule = selectRule(settings, sample);
        if (!rule) { unknown += 1; continue; }
        totals.set(rule.currency, (totals.get(rule.currency) ?? 0) + costOf(rule, sample));
      }
      const summary = [...totals].map(([currency, amount]) => money(currency, amount)).join(" + ");
      const label = summary ? "预估 " + summary + (unknown ? " · " + unknown + " 笔未计价" : "") : unknown + " 笔未配置单价";
      return React.createElement("button", {
        type: "button",
        title: "费用为本地估算，以供应商账单为准。共 " + usage.length + " 次模型请求。点击打开计费设置。",
        onClick: () => window.desktop?.openSettings(),
        style: { border: 0, background: "transparent", color: "inherit", opacity: .75, font: "inherit", cursor: "pointer", padding: "0 4px", whiteSpace: "nowrap" }
      }, "| " + label);
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
      ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
        name: "conversation.composer.dock", id: "desktop-billing-cost", order: 10
      }, CostLine));
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
