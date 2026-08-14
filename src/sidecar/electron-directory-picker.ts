import { DirectoryPicker } from "@deepseek-ai/dsh-host-directory-picker";

const CLIENT_PLUGIN_ID = "deepseek-harness-desktop-integration";
const CLIENT_PLUGIN_PATH = "/desktop-integration/client.js";
const CLIENT_PLUGIN_SOURCE = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(CLIENT_PLUGIN_ID)},
  factory: () => {
    const module = { exports: {} };
    const exports = module.exports;
    const READY = "desktop:harness-integration-ready";
    const OPEN = "desktop:open-workspace";
    const RESULT = "desktop:open-workspace-result";
    const inject = ["workspaces", "sessions"];
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
    inject: ["workspaces", "sessions"],
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
