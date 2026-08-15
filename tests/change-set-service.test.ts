import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeSetService } from "../src/main/change-set-service.js";

const directories: string[] = [];
afterEach(() =>
  Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-changes-workspace-"));
  const data = await mkdtemp(path.join(os.tmpdir(), "dsh-changes-data-"));
  directories.push(root, data);
  await writeFile(
    path.join(root, "alpha.ts"),
    "export const alpha = 1;\n",
    "utf8",
  );
  return { root, service: new ChangeSetService(data) };
}

describe("ChangeSetService", () => {
  it("captures a task baseline and safely reverts a modified file", async () => {
    const { root, service } = await fixture();
    const batch = await service.create("修改 alpha", root);
    await writeFile(
      path.join(root, "alpha.ts"),
      "export const alpha = 2;\nexport const beta = 3;\n",
      "utf8",
    );
    const closed = await service.close(batch.id);
    expect(closed.files).toHaveLength(1);
    expect(closed.files[0]).toMatchObject({
      path: "alpha.ts",
      kind: "modified",
      additions: 2,
      deletions: 1,
    });
    const diff = await service.diff(batch.id, "alpha.ts");
    expect(diff.original).toContain("alpha = 1");
    expect(diff.modified).toContain("beta = 3");
    await service.revertFile(batch.id, "alpha.ts");
    expect(await readFile(path.join(root, "alpha.ts"), "utf8")).toBe(
      "export const alpha = 1;\n",
    );
  });

  it("does not overwrite a file changed after review", async () => {
    const { root, service } = await fixture();
    const batch = await service.create("冲突保护", root);
    await writeFile(
      path.join(root, "alpha.ts"),
      "export const alpha = 2;\n",
      "utf8",
    );
    await service.close(batch.id);
    await writeFile(
      path.join(root, "alpha.ts"),
      "export const alpha = 99;\n",
      "utf8",
    );
    await expect(service.revertFile(batch.id, "alpha.ts")).rejects.toThrow(
      "发生变化",
    );
    expect(await readFile(path.join(root, "alpha.ts"), "utf8")).toContain("99");
  });

  it("removes files that were added by the task", async () => {
    const { root, service } = await fixture();
    const batch = await service.create("新增文件", root);
    await writeFile(path.join(root, "new.ts"), "export {};\n", "utf8");
    const closed = await service.close(batch.id);
    expect(closed.files.find((file) => file.path === "new.ts")?.kind).toBe(
      "added",
    );
    await service.revertFile(batch.id, "new.ts");
    await expect(
      readFile(path.join(root, "new.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reverts one hunk without discarding a separate change", async () => {
    const { root, service } = await fixture();
    const original =
      Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join("\n") +
      "\n";
    await writeFile(path.join(root, "alpha.ts"), original, "utf8");
    const batch = await service.create("分块撤销", root);
    const changed = original
      .replace("line 2", "line two")
      .replace("line 22", "line twenty-two");
    await writeFile(path.join(root, "alpha.ts"), changed, "utf8");
    const closed = await service.close(batch.id);
    expect(closed.files[0]?.hunks).toHaveLength(2);
    await service.revertHunk(
      batch.id,
      "alpha.ts",
      closed.files[0]!.hunks[0]!.id,
    );
    const result = await readFile(path.join(root, "alpha.ts"), "utf8");
    expect(result).toContain("line 2\n");
    expect(result).toContain("line twenty-two");
  });
});
