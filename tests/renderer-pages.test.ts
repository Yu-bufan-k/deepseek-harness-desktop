import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function scriptsOf(file: string): Promise<string[]> {
  const html = await readFile(new URL(`../src/renderer/${file}`, import.meta.url), "utf8");
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
}

describe("renderer pages", () => {
  it("keeps billing out of general settings", async () => {
    const html = await readFile(new URL("../src/renderer/settings.html", import.meta.url), "utf8");
    const scripts = await scriptsOf("settings.html");
    expect(html).not.toContain("id=\"billingAuto\"");
    expect(html).not.toContain("id=\"priceList\"");
    expect(html).toContain("检查 Harness 新版");
    expect(() => Function(scripts[0]!)).not.toThrow();
  });

  it("parses the standalone billing page script", async () => {
    const html = await readFile(new URL("../src/renderer/billing.html", import.meta.url), "utf8");
    const scripts = await scriptsOf("billing.html");
    expect(scripts).toHaveLength(1);
    expect(() => Function(scripts[0]!)).not.toThrow();
    expect(html).toContain("用量总览");
    expect(html).toContain("全部对话预估费用");
    expect(html).toContain("onBillingUsageChanged");
    expect(html).toContain("onBillingEditRequested");
    expect(html).toContain("开始生效时间");
    expect(html).toContain("缓存写入价格与未缓存输入相同");
    expect(html).toContain("结束生效时间（可选）");
    expect(html).not.toContain("function selectRule");
    expect(html).not.toContain("function costOf");
    expect(html).not.toContain("function statusOf");
    expect(html).not.toContain("Number(BigInt");
    expect(html).toContain("billing.ruleStatuses[rule.id]");
  });

  it("provides a responsive session billing rail with per-model history", async () => {
    const source = await readFile(new URL("../src/sidecar/electron-directory-picker.ts", import.meta.url), "utf8");
    expect(source).toContain("findComposerBoundary");
    expect(source).toContain("available >= 352");
    expect(source).toContain("模型费用 · 点击查看详情");
    expect(source).toContain("session.models.map");
    expect(source).toContain("modelDirectories.directoryFor(sessionId).store");
    expect(source).toContain("reportBillingUsage");
    expect(source).toContain("修正此模型价格");
    expect(source).not.toContain("const selectRule");
    expect(source).not.toContain("const costOf");
    expect(source).not.toContain("const ratesAt");
    expect(source).not.toContain("Number(BigInt");
    expect(source).toContain("sentRevisionsRef");
    expect(source).toContain("sessions: changed");
  });

  it("keeps separate retry requests additive in the billing projection", async () => {
    const source = await readFile(new URL("../plugins/billing/index.js", import.meta.url), "utf8");
    expect(source).toContain("context: event.data, last: null");
    expect(source).toContain("stateVersion: 3");
    expect(source).toContain("revision: state.revision + 1");
  });

  it("keeps the billing application-menu label unclipped", async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
    expect(source).toContain('label: "用量与费用", accelerator: "CmdOrCtrl+Shift+U"');
    expect(source).not.toContain('label: "用量与费用…"');
  });
});
