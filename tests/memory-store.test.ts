import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/main/memory-store.js";
import type { MemoryEntry } from "../src/shared/memory.js";

const directories: string[] = [];
afterEach(() =>
  Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

const entry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: "mem-1",
  content: "用户喜欢暗色主题",
  tags: ["偏好"],
  createdAt: "2026-08-15T10:00:00.000Z",
  updatedAt: "2026-08-15T10:00:00.000Z",
  ...overrides,
});

describe("MemoryStore", () => {
  it("returns [] when the memory file is missing", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-memory-"));
    directories.push(directory);
    const store = new MemoryStore(directory);
    expect(await store.list()).toEqual([]);
  });

  it("reads a plugin-written file and sorts entries newest first", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-memory-"));
    directories.push(directory);
    const store = new MemoryStore(directory);
    await writeFile(
      store.filePath,
      JSON.stringify({
        entries: [
          entry({ id: "old", updatedAt: "2026-08-14T10:00:00.000Z" }),
          entry({ id: "new", updatedAt: "2026-08-15T12:00:00.000Z" }),
        ],
      }),
      "utf8",
    );
    expect((await store.list()).map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("deletes an entry, persists, and returns the remaining list", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-memory-"));
    directories.push(directory);
    const store = new MemoryStore(directory);

    // 删除不存在的 id 是 no-op：不创建文件。
    await store.delete("missing");
    await expect(readFile(store.filePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await writeFile(
      store.filePath,
      JSON.stringify({ entries: [entry({ id: "a" }), entry({ id: "b" })] }),
      "utf8",
    );
    const remaining = await store.delete("a");
    expect(remaining.map((item) => item.id)).toEqual(["b"]);
    const saved = JSON.parse(await readFile(store.filePath, "utf8"));
    expect(saved.entries.map((item: MemoryEntry) => item.id)).toEqual(["b"]);
  });

  it("filters out malformed entries from the file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-memory-"));
    directories.push(directory);
    const store = new MemoryStore(directory);
    await writeFile(
      store.filePath,
      JSON.stringify({
        entries: [
          entry({ id: "good" }),
          { id: "bad", content: 42, tags: [], createdAt: "t", updatedAt: "t" },
          { id: "no-time", content: "x", tags: [], createdAt: "nope", updatedAt: "nope" },
          "not-an-object",
        ],
      }),
      "utf8",
    );
    expect((await store.list()).map((item) => item.id)).toEqual(["good"]);
  });

  it("getEnabled 缺省为 true；setEnabled 持久化且保留条目", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-memory-"));
    directories.push(directory);
    const store = new MemoryStore(directory);

    expect(await store.getEnabled()).toBe(true);
    await writeFile(
      store.filePath,
      JSON.stringify({ entries: [entry({ id: "a" })] }),
      "utf8",
    );
    expect(await store.getEnabled()).toBe(true);

    await store.setEnabled(false);
    expect(await store.getEnabled()).toBe(false);
    const saved = JSON.parse(await readFile(store.filePath, "utf8"));
    expect(saved.enabled).toBe(false);
    expect(saved.entries.map((item: MemoryEntry) => item.id)).toEqual(["a"]);

    await store.setEnabled(true);
    expect(await store.getEnabled()).toBe(true);
  });

  it("delete 保留 enabled 开关", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-memory-"));
    directories.push(directory);
    const store = new MemoryStore(directory);
    await writeFile(
      store.filePath,
      JSON.stringify({
        enabled: false,
        entries: [entry({ id: "a" }), entry({ id: "b" })],
      }),
      "utf8",
    );
    await store.delete("a");
    const saved = JSON.parse(await readFile(store.filePath, "utf8"));
    expect(saved.enabled).toBe(false);
    expect(saved.entries.map((item: MemoryEntry) => item.id)).toEqual(["b"]);
  });
});
