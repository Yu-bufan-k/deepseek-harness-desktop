import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function scriptsOf(file: string): Promise<string[]> {
  const html = await readFile(
    new URL(`../src/renderer/${file}`, import.meta.url),
    "utf8",
  );
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1] ?? "",
  );
}

// Prettier owns formatting, so whitespace (indentation/newlines) is not a
// stable part of the source. Collapse runs of whitespace to a single space so
// the token-sequence assertions below survive any reformat.
function flat(source: string): string {
  return source.replace(/\s+/g, " ");
}

describe("renderer pages", () => {
  it("keeps billing out of general settings", async () => {
    const html = flat(
      await readFile(
        new URL("../src/renderer/settings.html", import.meta.url),
        "utf8",
      ),
    );
    const scripts = await scriptsOf("settings.html");
    expect(html).not.toContain('id="billingAuto"');
    expect(html).not.toContain('id="priceList"');
    expect(html).toContain("检查 Harness 新版");
    expect(() => Function(scripts[0]!)).not.toThrow();
  });

  it("parses the standalone billing page script", async () => {
    const html = flat(
      await readFile(
        new URL("../src/renderer/billing.html", import.meta.url),
        "utf8",
      ),
    );
    const scripts = await scriptsOf("billing.html");
    expect(scripts).toHaveLength(1);
    expect(() => Function(scripts[0]!)).not.toThrow();
    expect(html).toContain("账户余额");
    expect(html).toContain("计费与价格规则");
    expect(html).not.toContain("onBillingUsageChanged");
    expect(html).toContain("onBillingEditRequested");
    expect(html).toContain("开始生效时间");
    expect(html).toContain("缓存写入价格与未缓存输入相同");
    expect(html).toContain("结束生效时间（可选）");
    expect(html).not.toContain("function selectRule");
    expect(html).not.toContain("function costOf");
    expect(html).not.toContain("function statusOf");
    expect(html).not.toContain("Number(BigInt");
    expect(html).toContain("billing.ruleStatuses[rule.id]");
    expect(html).toContain("createDateTimePicker");
    expect(html).not.toContain('type="datetime-local"');
  });

  it("provides a responsive session billing rail with per-model history", async () => {
    const source = flat(
      await readFile(
        new URL("../src/sidecar/electron-directory-picker.ts", import.meta.url),
        "utf8",
      ),
    );
    expect(source).toContain("findComposerBoundary");
    expect(source).toContain("available >= 352");
    expect(source).toContain("dsh-sess-model-row");
    expect(source).toContain('h("strong", null, "会话信息")');
    expect(source).toContain("dsh-sess-status");
    expect(source).toContain("dsh-sess-kpis");
    expect(source).toContain("dsh-sess-spark-line");
    expect(source).toContain("dsh-current-label");
    expect(source).toContain("dsh-panel-scroll");
    expect(source).toContain("dsh-info-section");
    expect(source).toContain("dsh-sess-section-title");
    expect(source).toContain("session.models.map");
    expect(source).toContain("modelDirectories.directoryFor(sessionId).store");
    expect(source).toContain("reportBillingUsage");
    expect(source).toContain("价格来源与设置");
    expect(source).toContain("从现在起恢复官方价格");
    expect(source).not.toContain("const selectRule");
    expect(source).not.toContain("const costOf");
    expect(source).not.toContain("const ratesAt");
    expect(source).not.toContain("Number(BigInt");
    expect(source).toContain("sentRevisionsRef");
    expect(source).toContain("sessions: changed");
  });

  it("keeps separate retry requests additive in the billing projection", async () => {
    const source = flat(
      await readFile(
        new URL("../plugins/billing/index.js", import.meta.url),
        "utf8",
      ),
    );
    expect(source).toContain("context: event.data, last: null");
    expect(source).toContain("stateVersion: 4");
    expect(source).toContain("revision: state.revision + 1");
  });

  it("keeps the billing application-menu label unclipped", async () => {
    const source = flat(
      await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8"),
    );
    expect(source).toContain(
      'label: "计费与价格规则", accelerator: "CmdOrCtrl+Shift+U"',
    );
    expect(source).not.toContain('label: "计费与价格规则…"');
  });

  it("keeps the workbench window menu-free so it cannot spawn more windows", async () => {
    const source = flat(
      await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8"),
    );
    expect(source).toContain("workbenchWindow.setMenu(null)");
    expect(source).not.toContain("autoHideMenuBar");
    expect(source).not.toContain("setMenuBarVisibility");
  });

  it("opens lightweight panels as parent-attached popup windows without their own menu", async () => {
    const source = flat(
      await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8"),
    );
    expect(source).toContain("createPopupWindow");
    expect(source).toContain("parent: parentWindow");
    expect(source).toContain("BrowserWindow.getFocusedWindow()");
    expect(source).toContain("window.setMenu(null);");
    expect(source).toContain("secureWindow(window);");
    expect(source).toContain("destroyPopupsOf");
    expect(source).toContain('view: "settings", mode: "popup"');
    expect(source).toContain('view: "billing", mode: "popup"');
  });

  it("builds the typed workbench and Harness bridges from source", async () => {
    const workbench = flat(
      await readFile(new URL("../src/ui/main.tsx", import.meta.url), "utf8"),
    );
    const sidecar = flat(
      await readFile(
        new URL("../src/sidecar/electron-directory-picker.ts", import.meta.url),
        "utf8",
      ),
    );
    expect(workbench).toContain("DiffEditor");
    expect(workbench).not.toContain("VisionView");
    expect(workbench).not.toContain("discoverVisionTools");
    expect(workbench).not.toContain("VisionBridge");
    expect(workbench).toContain("AnalyticsView");
    expect(workbench).toContain("视觉解析健康度");
    expect(workbench).toContain("撤销此处");
    expect(workbench).not.toContain('className="theme-card"');
    expect(workbench).not.toContain("theme-preview preview-");
    expect(workbench).toContain('query.get("mode") === "popup"');
    expect(workbench).not.toContain("window.desktop.openBilling()");
    expect(workbench).not.toContain("window.desktop.openSettings()");
    expect(workbench).not.toContain("activity-rail");
    expect(workbench).toContain("workbench-header");
    expect(workbench).not.toContain('id: "settings", label: "设置"');
    expect(sidecar).toContain("createChangeBatch");
    expect(sidecar).not.toContain("VisionBridge");
    expect(sidecar).not.toContain("desktop-vision-bridge");
    expect(sidecar).not.toContain("analyzeVision");
    expect(sidecar).not.toContain("desktop_vision_context");
    expect(sidecar).toContain("saveVisionImage");
    expect(sidecar).toContain("vision_understand");
    expect(sidecar).toContain("desktop-vision");
    expect(sidecar).toContain("图片已保存");
    expect(sidecar).toContain('id: "desktop-memory"');
    expect(sidecar).toContain('"settings.section"');
    expect(sidecar).toContain("dshMemoryNav");
    expect(sidecar).toContain("desktop memory settings nav decoration");
    expect(sidecar).toContain("dshVisionNav");
    expect(sidecar).toContain("desktop vision settings nav decoration");
  });
});
