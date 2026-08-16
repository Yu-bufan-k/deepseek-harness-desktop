import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/main/event-log.js";

const directories: string[] = [];
afterEach(() =>
  Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-log-"));
  directories.push(directory);
  return { directory, log: new EventLog({ directory: () => directory }) };
}

function dayStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

describe("EventLog", () => {
  it("appends structured JSONL entries to a per-day file", async () => {
    const { directory, log } = await fixture();
    await log.append("vision", "analyze", {
      backend: "智谱",
      model: "glm-4v-flash",
      durationMs: 842,
      ok: true,
    });
    await log.append("error", "vision-request", { status: 404 });
    const file = path.join(directory, `events-${dayStamp(new Date())}.jsonl`);
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.area).toBe("vision");
    expect(first.type).toBe("analyze");
    expect(first.seq).toBe(1);
    expect(first.backend).toBe("智谱");
    expect(first.model).toBe("glm-4v-flash");
    expect(typeof first.ts).toBe("string");
    const second = JSON.parse(lines[1]!);
    expect(second.seq).toBe(2);
    expect(second.status).toBe(404);
  });

  it("uses the directory resolved at append time", async () => {
    const firstDir = await mkdtemp(path.join(os.tmpdir(), "dsh-log-a-"));
    const secondDir = await mkdtemp(path.join(os.tmpdir(), "dsh-log-b-"));
    directories.push(firstDir, secondDir);
    let current = firstDir;
    const log = new EventLog({ directory: () => current });
    await log.append("ipc", "save-vision-image", { imageId: "one" });
    current = secondDir;
    await log.append("ipc", "save-vision-image", { imageId: "two" });
    const stamp = dayStamp(new Date());
    expect(
      await readFile(path.join(firstDir, `events-${stamp}.jsonl`), "utf8"),
    ).toContain("one");
    expect(
      await readFile(path.join(secondDir, `events-${stamp}.jsonl`), "utf8"),
    ).toContain("two");
  });

  it("prunes files older than the retention window", async () => {
    const { directory, log } = await fixture();
    const stamp = dayStamp(new Date());
    await log.append("ipc", "save-vision-image", {});
    await writeFile(
      path.join(directory, `events-2020-01-01.jsonl`),
      "old\n",
      "utf8",
    );
    await writeFile(
      path.join(directory, `events-2026-01-01.jsonl`),
      "older-than-retention\n",
      "utf8",
    );
    const removed = await log.prune();
    expect(removed).toBe(2);
    const entries = await import("node:fs/promises").then((m) =>
      m.readdir(directory),
    );
    expect(entries).toContain(`events-${stamp}.jsonl`);
    expect(entries).not.toContain("events-2020-01-01.jsonl");
    expect(entries).not.toContain("events-2026-01-01.jsonl");
  });
});
