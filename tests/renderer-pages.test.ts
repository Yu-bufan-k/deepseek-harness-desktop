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
});
