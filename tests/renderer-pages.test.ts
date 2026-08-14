import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function scriptsOf(file: string): Promise<string[]> {
  const html = await readFile(new URL(`../src/renderer/${file}`, import.meta.url), "utf8");
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
}

describe("renderer pages", () => {
  it("keeps billing out of general settings", async () => {
    const html = await readFile(new URL("../src/renderer/settings.html", import.meta.url), "utf8");
    expect(html).not.toContain("id=\"billingAuto\"");
    expect(html).not.toContain("id=\"priceList\"");
  });

  it("parses the standalone billing page script", async () => {
    const scripts = await scriptsOf("billing.html");
    expect(scripts).toHaveLength(1);
    expect(() => Function(scripts[0]!)).not.toThrow();
  });

  it("provides a responsive session billing rail with per-model history", async () => {
    const source = await readFile(new URL("../src/sidecar/electron-directory-picker.ts", import.meta.url), "utf8");
    expect(source).toContain("(min-width: 1540px)");
    expect(source).toContain("模型费用 · 点击查看详情");
    expect(source).toContain("model.totals");
  });

  it("keeps the billing application-menu label unclipped", async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
    expect(source).toContain('label: "用量与费用", accelerator: "CmdOrCtrl+Shift+U"');
    expect(source).not.toContain('label: "用量与费用…"');
  });
});
