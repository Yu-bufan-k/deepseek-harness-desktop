// 跨会话记忆服务端插件：给 Harness 助手注册 memory_write / memory_search 工具。
// 事实经 DSH_DESKTOP_MEMORY_PATH 指向的 JSON 文件持久化，桌面侧（MemoryStore）读同一文件做展示/删除。
// 最小原型：无 scope、无加密，插件子进程与主进程各自读-改-写（last-write-wins）。

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const MEMORY_CAP = 500;
const SEARCH_DEFAULT_LIMIT = 5;
const SEARCH_MAX_LIMIT = 20;

// --- 本地文件读写（ENOENT → 空数组；其他错误抛出） ---

// 读取完整状态（enabled + entries）。enabled 缺省 true，缺失/非法文件视为空库开启状态。
async function readState(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { enabled: true, entries: [] };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { enabled: true, entries: [] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { enabled: true, entries: [] };
  }
  return {
    enabled: parsed.enabled === false ? false : true,
    entries: Array.isArray(parsed.entries)
      ? parsed.entries.filter(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            typeof entry.id === "string" &&
            typeof entry.content === "string" &&
            Array.isArray(entry.tags) &&
            entry.tags.every((tag) => typeof tag === "string"),
        )
      : [],
  };
}

// 写回完整状态，保留 enabled（否则会抹掉开关）。
async function writeEntries(filePath, enabled, entries) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ enabled, entries }, null, 2)}\n`,
    "utf8",
  );
}

/** 调用时门控：每次现场重读开关，关闭即抛错，下一条消息立即生效。 */
function assertEnabled(state) {
  if (state.enabled === false) throw new Error("记忆工具已禁用");
}

function sortNewestFirst(entries) {
  return [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function abortIfSignal(signal) {
  if (signal?.aborted) {
    const error = new Error("memory 工具调用已取消");
    error.name = "AbortError";
    throw error;
  }
}

// --- 工具定义 ---

const writeParameters = {
  type: "object",
  properties: {
    content: {
      type: "string",
      description: "要记住的事实/偏好/约定，建议写成完整、自包含的句子",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "可选标签，便于后续检索分类",
    },
  },
  required: ["content"],
  additionalProperties: false,
};

const writeOutput = {
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      count: { type: "integer" },
    },
    required: ["id", "count"],
    additionalProperties: false,
  },
  render(args) {
    return [{ type: "text", text: `已记住：${args.content}` }];
  },
};

const searchParameters = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "检索关键词",
    },
    limit: {
      type: "integer",
      description: "返回条数（默认 5，最大 20）",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

const searchOutput = {
  schema: {
    type: "object",
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            content: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            updatedAt: { type: "string" },
          },
          required: ["id", "content", "tags", "updatedAt"],
          additionalProperties: false,
        },
      },
      count: { type: "integer" },
    },
    required: ["matches", "count"],
    additionalProperties: false,
  },
  render(_args, value) {
    const lines = value.matches.map(
      (match) =>
        `- ${match.updatedAt} ${match.content}${
          match.tags.length ? ` (${match.tags.join(", ")})` : ""
        }`,
    );
    return [
      { type: "text", text: `找到 ${value.count} 条记忆：\n${lines.join("\n")}` },
    ];
  },
};

export const name = "desktop-memory";
export const inject = ["tools"];

export function apply(ctx) {
  const memoryPath = process.env.DSH_DESKTOP_MEMORY_PATH;
  if (!memoryPath) {
    ctx.logger?.warn?.("desktop-memory: 缺少 DSH_DESKTOP_MEMORY_PATH，跳过工具注册");
    return;
  }
  const disposers = [
    ctx.tools.register({
      name: "memory_write",
      description:
        "跨会话保存一条事实、偏好或约定，之后的任何会话都能检索到。内容相同的再次写入会刷新更新时间并合并标签，不产生重复条目。",
      parameters: writeParameters,
      output: writeOutput,
      async execute(args, exec) {
        abortIfSignal(exec.signal);
        const state = await readState(memoryPath);
        assertEnabled(state);
        const content = String(args?.content ?? "").trim();
        if (!content) throw new Error("memory_write 需要非空的 content");
        const tags = Array.isArray(args?.tags)
          ? [
              ...new Set(
                args.tags
                  .map((tag) => String(tag).trim())
                  .filter((tag) => tag.length > 0),
              ),
            ]
          : [];
        const now = new Date().toISOString();
        const entries = state.entries;
        const existing = entries.find((entry) => entry.content === content);
        if (existing) {
          existing.updatedAt = now;
          existing.tags = [...new Set([...existing.tags, ...tags])];
        } else {
          entries.push({
            id: randomUUID(),
            content,
            tags,
            createdAt: now,
            updatedAt: now,
          });
        }
        const kept = sortNewestFirst(entries).slice(0, MEMORY_CAP);
        await writeEntries(memoryPath, state.enabled, kept);
        const entry = existing ?? kept.find((item) => item.content === content);
        return { id: entry.id, count: kept.length };
      },
    }),
    ctx.tools.register({
      name: "memory_search",
      description:
        "在跨会话记忆中按关键词检索已保存的事实。对 content 与标签做大小写不敏感的子串匹配，按最近更新倒序返回。",
      parameters: searchParameters,
      output: searchOutput,
      async execute(args, exec) {
        abortIfSignal(exec.signal);
        const state = await readState(memoryPath);
        assertEnabled(state);
        const query = String(args?.query ?? "").trim().toLowerCase();
        if (!query) throw new Error("memory_search 需要非空的 query");
        const requested = args?.limit;
        const limit = Number.isInteger(requested)
          ? Math.min(Math.max(requested, 1), SEARCH_MAX_LIMIT)
          : SEARCH_DEFAULT_LIMIT;
        const entries = state.entries;
        const matches = sortNewestFirst(entries)
          .filter(
            (entry) =>
              entry.content.toLowerCase().includes(query) ||
              entry.tags.some((tag) => tag.toLowerCase().includes(query)),
          )
          .slice(0, limit)
          .map((entry) => ({
            id: entry.id,
            content: entry.content,
            tags: entry.tags,
            updatedAt: entry.updatedAt,
          }));
        return { matches, count: matches.length };
      },
    }),
  ];
  ctx.effect(
    () => () => {
      for (const dispose of disposers) dispose();
    },
    "desktop-memory.tools",
  );
}
