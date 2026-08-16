import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error No declaration file is emitted for this local plugin.
import { apply } from "../plugins/memory/index.js";

const ENV_KEY = "DSH_DESKTOP_MEMORY_PATH";
const directories: string[] = [];

afterEach(async () => {
  delete process.env[ENV_KEY];
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

type ToolDef = {
  name: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>;
  };
  execute: (args: unknown, exec: { signal?: AbortSignal }) => Promise<unknown>;
};

function install(dir: string): { definitions: Map<string, ToolDef>; warn: ReturnType<typeof vi.fn> } {
  process.env[ENV_KEY] = path.join(dir, "memory.json");
  const definitions = new Map<string, ToolDef>();
  const disposers: Array<() => void> = [];
  const warn = vi.fn();
  const ctx = {
    tools: {
      register: (definition: ToolDef): (() => void) => {
        definitions.set(definition.name, definition);
        const disposer = (): void => {};
        disposers.push(disposer);
        return disposer;
      },
    },
    logger: { warn },
    effect: (fn: () => unknown) => fn(),
  };
  apply(ctx);
  return { definitions, warn };
}

async function fileEntries(dir: string): Promise<Array<{ id: string; content: string; tags: string[]; updatedAt: string }>> {
  const raw = await readFile(path.join(dir, "memory.json"), "utf8");
  return (JSON.parse(raw) as { entries: Array<{ id: string; content: string; tags: string[]; updatedAt: string }> }).entries;
}

describe("desktop-memory 插件", () => {
  it("在 DSH_DESKTOP_MEMORY_PATH 存在时注册两个工具", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-memory-plugin-"));
    directories.push(dir);
    const { definitions, warn } = install(dir);
    expect([...definitions.keys()].sort()).toEqual(["memory_search", "memory_write"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("缺少环境变量时只告警不注册工具", () => {
    const warn = vi.fn();
    apply({ tools: { register: () => () => {} }, logger: { warn }, effect: () => {} });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("DSH_DESKTOP_MEMORY_PATH"));
  });

  it("memory_write 写盘、去重并合并标签", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-memory-plugin-"));
    directories.push(dir);
    const { definitions } = install(dir);
    const write = definitions.get("memory_write")!;

    const first = (await write.execute(
      { content: "用户偏好深色主题", tags: ["偏好"] },
      {},
    )) as { id: string; count: number };
    expect(typeof first.id).toBe("string");
    expect(first.count).toBe(1);
    expect(await fileEntries(dir)).toHaveLength(1);

    const again = (await write.execute(
      { content: "用户偏好深色主题", tags: ["外观"] },
      {},
    )) as { id: string; count: number };
    expect(again.id).toBe(first.id);
    expect(again.count).toBe(1);
    const entries = await fileEntries(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tags.sort()).toEqual(["偏好", "外观"]);
    expect(entries[0]!.updatedAt >= "2026-08-15").toBe(true);
  });

  it("memory_write 校验非空 content 并裁剪标签", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-memory-plugin-"));
    directories.push(dir);
    const { definitions } = install(dir);
    const write = definitions.get("memory_write")!;

    await expect(write.execute({ content: "   " }, {})).rejects.toThrow("非空");
    await write.execute({ content: "  hello  ", tags: ["  ", "tag1 ", "tag2"] }, {});
    const entries = await fileEntries(dir);
    expect(entries[0]!.content).toBe("hello");
    expect(entries[0]!.tags).toEqual(["tag1", "tag2"]);
  });

  it("memory_search 大小写不敏感匹配、倒序、限制条数", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-memory-plugin-"));
    directories.push(dir);
    const { definitions } = install(dir);
    const search = definitions.get("memory_search")!;

    await writeFile(
      path.join(dir, "memory.json"),
      JSON.stringify({
        entries: [
          { id: "a", content: "Prefer Dark Theme", tags: ["ui"], createdAt: "t", updatedAt: "2026-08-15T09:00:00.000Z" },
          { id: "b", content: "dark mode reading", tags: ["偏好"], createdAt: "t", updatedAt: "2026-08-15T11:00:00.000Z" },
          { id: "c", content: "light mode", tags: [], createdAt: "t", updatedAt: "2026-08-15T10:00:00.000Z" },
        ],
      }),
      "utf8",
    );

    const dark = (await search.execute({ query: "dark" }, {})) as { matches: Array<{ id: string }>; count: number };
    expect(dark.count).toBe(2);
    expect(dark.matches.map((m) => m.id)).toEqual(["b", "a"]); // content 大小写不敏感 + 倒序

    const zh = (await search.execute({ query: "偏好" }, {})) as { matches: Array<{ id: string }>; count: number };
    expect(zh.count).toBe(1);
    expect(zh.matches[0]!.id).toBe("b"); // tag 匹配

    const all = (await search.execute({ query: "mode", limit: 2 }, {})) as { matches: Array<{ id: string }>; count: number };
    expect(all.matches.map((m) => m.id)).toEqual(["b", "c"]); // 倒序 + limit
  });

  it("memory_search 默认 5 条、limit 上下限 clamp", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-memory-plugin-"));
    directories.push(dir);
    const { definitions } = install(dir);
    const search = definitions.get("memory_search")!;

    const entries = Array.from({ length: 8 }, (_, index) => ({
      id: `m${index}`,
      content: `common fact ${index}`,
      tags: [],
      createdAt: "t",
      updatedAt: new Date(2026, 7, 1 + index).toISOString(),
    }));
    await writeFile(
      path.join(dir, "memory.json"),
      JSON.stringify({ entries }),
      "utf8",
    );

    const byDefault = (await search.execute({ query: "common" }, {})) as { count: number };
    expect(byDefault.count).toBe(5); // 默认 5
    const withLimit = (await search.execute({ query: "common", limit: 3 }, {})) as { count: number };
    expect(withLimit.count).toBe(3);
    const zero = (await search.execute({ query: "common", limit: 0 }, {})) as { count: number };
    expect(zero.count).toBe(1); // 下限 clamp 到 1
    const huge = (await search.execute({ query: "common", limit: 999 }, {})) as { count: number };
    expect(huge.count).toBe(8); // 上限 clamp 到 20，但只有 8 条匹配
  });

  it("写入超过 500 条时丢弃最旧", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-memory-plugin-"));
    directories.push(dir);
    const { definitions } = install(dir);
    const write = definitions.get("memory_write")!;

    const seeds = Array.from({ length: 500 }, (_, index) => ({
      id: `seed-${index}`,
      content: `seed fact ${index}`,
      tags: [],
      createdAt: "t",
      updatedAt: new Date(2026, 7, 1 + index).toISOString(),
    }));
    await writeFile(
      path.join(dir, "memory.json"),
      JSON.stringify({ entries: seeds }),
      "utf8",
    );

    const result = (await write.execute(
      { content: "brand new fact" },
      {},
    )) as { id: string; count: number };
    expect(result.count).toBe(500);
    const entries = await fileEntries(dir);
    expect(entries).toHaveLength(500);
    expect(entries.some((item) => item.content === "seed fact 0")).toBe(false); // 最旧被丢弃
    expect(entries.some((item) => item.content === "brand new fact")).toBe(true);
  });

  it("render 输出可读文本", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-memory-plugin-"));
    directories.push(dir);
    const { definitions } = install(dir);

    const writeBlocks = definitions.get("memory_write")!.output.render(
      { content: "你好世界" },
      { id: "x", count: 3 },
    );
    expect(writeBlocks[0]!.text).toBe("已记住：你好世界");

    const searchBlocks = definitions.get("memory_search")!.output.render(
      {},
      {
        matches: [{ id: "x", content: "一条记忆", tags: ["a"], updatedAt: "t" }],
        count: 1,
      },
    );
    expect(searchBlocks[0]!.text).toContain("找到 1 条记忆");
    expect(searchBlocks[0]!.text).toContain("一条记忆 (a)");
  });

  it("enabled: false 时两个工具都抛「记忆工具已禁用」且不写盘", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-memory-plugin-"));
    directories.push(dir);
    const { definitions } = install(dir);
    const write = definitions.get("memory_write")!;
    const search = definitions.get("memory_search")!;

    await writeFile(
      path.join(dir, "memory.json"),
      JSON.stringify({ enabled: false, entries: [] }),
      "utf8",
    );
    await expect(write.execute({ content: "x" }, {})).rejects.toThrow(
      "记忆工具已禁用",
    );
    await expect(search.execute({ query: "x" }, {})).rejects.toThrow(
      "记忆工具已禁用",
    );
    const raw = JSON.parse(await readFile(path.join(dir, "memory.json"), "utf8"));
    expect(raw.entries).toEqual([]);
  });

  it("缺省（无 enabled 字段）时工具正常", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-memory-plugin-"));
    directories.push(dir);
    const { definitions } = install(dir);
    const write = definitions.get("memory_write")!;

    const result = (await write.execute(
      { content: "ok" },
      {},
    )) as { count: number };
    expect(result.count).toBe(1);
    expect(await fileEntries(dir)).toHaveLength(1);
  });

  it("memory_write 写盘保留 enabled 开关", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-memory-plugin-"));
    directories.push(dir);
    const { definitions } = install(dir);
    const write = definitions.get("memory_write")!;

    await writeFile(
      path.join(dir, "memory.json"),
      JSON.stringify({ enabled: true, entries: [] }),
      "utf8",
    );
    await write.execute({ content: "remember this" }, {});
    const raw = JSON.parse(await readFile(path.join(dir, "memory.json"), "utf8"));
    expect(raw.enabled).toBe(true);
    expect(raw.entries).toHaveLength(1);
  });
});
