/** 跨会话记忆域：Harness 助手跨会话写入/检索的本地事实存储。 */

/** 记忆条数上限，超出按 updatedAt 倒序丢弃最旧。 */
export const MEMORY_CAP = 500;
/** memory_search 默认返回条数。 */
export const MEMORY_SEARCH_DEFAULT_LIMIT = 5;
/** memory_search 允许的最大返回条数。 */
export const MEMORY_SEARCH_MAX_LIMIT = 20;

export interface MemoryEntry {
  /** 唯一 id（插件用 crypto.randomUUID 生成）。 */
  id: string;
  /** 事实/偏好/约定，非空字符串。 */
  content: string;
  /** 检索用标签，可为空数组。 */
  tags: string[];
  /** 首次写入时刻（ISO）。 */
  createdAt: string;
  /** 最近更新时刻（ISO）。 */
  updatedAt: string;
}

export interface MemoryFile {
  /** 记忆工具启用开关；缺省视为开启。 */
  enabled?: boolean;
  entries: MemoryEntry[];
}

/** 结构守卫：id/content/tags 类型 + createdAt/updatedAt 为可解析 ISO 时间戳。 */
export function isValidMemoryEntry(value: unknown): value is MemoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0) return false;
  if (typeof entry.content !== "string" || entry.content.trim().length === 0)
    return false;
  if (
    !Array.isArray(entry.tags) ||
    !entry.tags.every((tag) => typeof tag === "string")
  )
    return false;
  if (
    typeof entry.createdAt !== "string" ||
    Number.isNaN(Date.parse(entry.createdAt))
  )
    return false;
  if (
    typeof entry.updatedAt !== "string" ||
    Number.isNaN(Date.parse(entry.updatedAt))
  )
    return false;
  return true;
}

/** 解析 memory.json 文本，返回 { enabled, entries }；enabled 缺省 true，非法条目丢弃。 */
export function parseMemoryFile(raw: string): MemoryFile {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object")
    return { enabled: true, entries: [] };
  const { enabled, entries } = parsed as {
    enabled?: unknown;
    entries?: unknown;
  };
  return {
    enabled: enabled === false ? false : true,
    entries: Array.isArray(entries)
      ? entries.filter(isValidMemoryEntry)
      : [],
  };
}
