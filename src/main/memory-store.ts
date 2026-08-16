import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MemoryEntry, MemoryFile } from "../shared/memory.js";
import { parseMemoryFile } from "../shared/memory.js";

/**
 * 桌面侧跨会话记忆持久化。与插件子进程共用同一 memory.json：
 * 不做内存缓存，list()/delete() 都直接读盘，保证能看到插件写入的最新内容。
 * 写入采用读-改-写（last-write-wins，MVP 容忍竞态）。
 */
export class MemoryStore {
  readonly filePath: string;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "memory.json");
  }

  /** 读盘并返回按 updatedAt 倒序的全部条目（缺文件 → 空数组）。 */
  async list(): Promise<MemoryEntry[]> {
    return sortNewestFirst((await this.readState()).entries);
  }

  /** 删除指定条目并持久化，返回剩余条目（倒序）。 */
  async delete(id: string): Promise<MemoryEntry[]> {
    const state = await this.readState();
    const remaining = state.entries.filter((entry) => entry.id !== id);
    if (remaining.length !== state.entries.length) {
      await this.persist({ enabled: state.enabled, entries: remaining });
    }
    return sortNewestFirst(remaining);
  }

  /** 记忆工具启用开关（缺文件/缺字段 → 视为开启）。 */
  async getEnabled(): Promise<boolean> {
    return (await this.readState()).enabled !== false;
  }

  /** 写入启用开关，保留现有条目；返回写入后的值。 */
  async setEnabled(enabled: boolean): Promise<boolean> {
    const state = await this.readState();
    await this.persist({ enabled, entries: state.entries });
    return enabled;
  }

  private async readState(): Promise<MemoryFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { enabled: true, entries: [] };
      throw error;
    }
    return parseMemoryFile(raw);
  }

  private async persist(file: MemoryFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify(file, null, 2)}\n`,
      "utf8",
    );
  }
}

function sortNewestFirst(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
