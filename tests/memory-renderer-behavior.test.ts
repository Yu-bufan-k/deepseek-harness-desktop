import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// main.tsx 依赖 monaco/echarts，happy-dom 无法挂载整个 React 树；沿用
// quota-renderer-behavior.test.ts 的约定，对源码做行为面断言（UI 标记 + 交互连线）。
function flat(source: string): string {
  return source.replace(/\s+/g, " ");
}

async function workbench(): Promise<string> {
  return flat(
    await readFile(new URL("../src/ui/main.tsx", import.meta.url), "utf8"),
  );
}

describe("cross-session memory renderer", () => {
  it("moved to the Harness settings section: no desktop memory card remains", async () => {
    const source = await workbench();
    expect(source).not.toContain("跨会话记忆");
    expect(source).not.toContain("MemorySettingsCard");
    expect(source).not.toContain("getMemoryEntries");
    expect(source).not.toContain("formatMemoryTime");
    expect(source).not.toContain("memory-list");
    expect(source).not.toContain('aria-label="过滤记忆"');
  });
});

describe("billing tool summary renderer", () => {
  it("keeps per-session tool usage out of the desktop billing popup", async () => {
    const source = await workbench();
    expect(source).not.toContain("billingToolChips");
    expect(source).not.toContain("aggregateSessionTools");
    expect(source).not.toContain('data-section="会话工具使用"');
    expect(source).not.toContain("tool-chips");
    expect(source).not.toContain("tool-stats-table");
    expect(source).not.toContain("覆盖对话");
  });

  it("renders per-session tool usage in the conversation side panel", async () => {
    const source = flat(
      await readFile(
        new URL("../src/sidecar/electron-directory-picker.ts", import.meta.url),
        "utf8",
      ),
    );
    expect(source).toContain("sessionTools");
    expect(source).toContain("工具 · MCP · 技能");
    expect(source).toContain('className: "dsh-sess-tools"');
    expect(source).toContain('className: "dsh-sess-toolchip"');
    expect(source).toContain('toolGroup("工具", sessionTools.tools, "tools")');
    expect(source).toContain('toolGroup("MCP", sessionTools.mcp, "mcp")');
    expect(source).toContain('toolGroup("技能", sessionTools.skills, "skills")');
    expect(source).toContain("is-mcp");
    expect(source).toContain("is-skill");
  });
});
