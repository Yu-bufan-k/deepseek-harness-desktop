import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  applyPatch,
  diffLines,
  formatPatch,
  reversePatch,
  structuredPatch,
  type StructuredPatch,
} from "diff";
import type {
  ChangeBatch,
  DiffHunk,
  FileChange,
  FileDiff,
  ReviewState,
} from "../shared/contracts.js";

const execFileAsync = promisify(execFile);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const EXCLUDED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "release",
  ".pack-app",
  ".cache",
]);

interface SnapshotEntry {
  hash: string;
  size: number;
  binary: boolean;
}
interface StoredBatch extends ChangeBatch {
  baseline: Record<string, SnapshotEntry>;
}

function hash(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
function normalized(relativePath: string): string {
  return relativePath.replaceAll("\\", "/");
}
function isExcluded(relativePath: string): boolean {
  return normalized(relativePath)
    .split("/")
    .some((part) => EXCLUDED_SEGMENTS.has(part));
}
function isBinary(buffer: Buffer): boolean {
  return buffer.includes(0) || buffer.length > MAX_TEXT_BYTES;
}

function languageFor(filePath: string): string {
  return (
    (
      {
        ".ts": "typescript",
        ".tsx": "typescript",
        ".js": "javascript",
        ".jsx": "javascript",
        ".json": "json",
        ".css": "css",
        ".html": "html",
        ".md": "markdown",
        ".py": "python",
        ".rs": "rust",
        ".go": "go",
        ".java": "java",
        ".yml": "yaml",
        ".yaml": "yaml",
      } as Record<string, string>
    )[path.extname(filePath).toLowerCase()] ?? "plaintext"
  );
}

export class ChangeSetService {
  private readonly root: string;
  private readonly batchesDirectory: string;
  private readonly blobsDirectory: string;

  constructor(userDataPath: string) {
    this.root = path.join(userDataPath, "change-batches");
    this.batchesDirectory = path.join(this.root, "batches");
    this.blobsDirectory = path.join(this.root, "blobs");
  }

  private batchPath(id: string): string {
    return path.join(this.batchesDirectory, `${id}.json`);
  }
  private blobPath(value: string): string {
    return path.join(this.blobsDirectory, value);
  }

  private async save(batch: StoredBatch): Promise<void> {
    await mkdir(this.batchesDirectory, { recursive: true });
    await writeFile(
      this.batchPath(batch.id),
      `${JSON.stringify(batch, null, 2)}\n`,
      "utf8",
    );
  }

  private async load(id: string): Promise<StoredBatch> {
    const batch = JSON.parse(
      await readFile(this.batchPath(id), "utf8"),
    ) as StoredBatch;
    if (!batch.workspacePath || !path.isAbsolute(batch.workspacePath))
      throw new Error("变更批次的工作区无效");
    return batch;
  }

  private async workspaceFiles(workspacePath: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        [
          "-C",
          workspacePath,
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
        ],
        { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
      );
      return stdout
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map(normalized)
        .filter((entry) => !isExcluded(entry));
    } catch {
      const files: string[] = [];
      const visit = async (
        directory: string,
        prefix: string,
      ): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const relative = normalized(path.join(prefix, entry.name));
          if (isExcluded(relative) || entry.isSymbolicLink()) continue;
          if (entry.isDirectory())
            await visit(path.join(directory, entry.name), relative);
          else if (entry.isFile()) files.push(relative);
        }
      };
      await visit(workspacePath, "");
      return files;
    }
  }

  private async dirtyPaths(workspacePath: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        [
          "-C",
          workspacePath,
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ],
        { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
      );
      const fields = stdout.toString("utf8").split("\0").filter(Boolean);
      const result = new Set<string>();
      for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index]!;
        const status = field.slice(0, 2);
        const value = field.length > 3 ? field.slice(3) : field;
        result.add(normalized(value));
        if (/[RC]/.test(status) && fields[index + 1])
          result.add(normalized(fields[++index]!));
      }
      return [...result].sort();
    } catch {
      return [];
    }
  }

  private async snapshot(
    workspacePath: string,
  ): Promise<Record<string, SnapshotEntry>> {
    await mkdir(this.blobsDirectory, { recursive: true });
    const result: Record<string, SnapshotEntry> = {};
    for (const relativePath of await this.workspaceFiles(workspacePath)) {
      const absolutePath = path.resolve(workspacePath, relativePath);
      if (!absolutePath.startsWith(path.resolve(workspacePath) + path.sep))
        continue;
      let data: Buffer;
      try {
        const info = await lstat(absolutePath);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        data = await readFile(absolutePath);
      } catch {
        continue;
      }
      const value = hash(data);
      const binary = isBinary(data);
      result[relativePath] = { hash: value, size: data.length, binary };
      try {
        await stat(this.blobPath(value));
      } catch {
        await writeFile(this.blobPath(value), data);
      }
    }
    return result;
  }

  async create(title: string, workspacePath: string): Promise<ChangeBatch> {
    const resolved = path.resolve(workspacePath);
    if (!(await stat(resolved)).isDirectory())
      throw new Error("工作区目录不存在");
    const batch: StoredBatch = {
      id: randomUUID(),
      title: title.trim().slice(0, 240) || "未命名任务",
      workspacePath: resolved,
      createdAt: new Date().toISOString(),
      closedAt: null,
      state: "capturing",
      preexistingDirtyPaths: await this.dirtyPaths(resolved),
      files: [],
      baseline: await this.snapshot(resolved),
    };
    await this.save(batch);
    return this.publicBatch(batch);
  }

  private publicBatch(batch: StoredBatch): ChangeBatch {
    const { baseline: _baseline, ...value } = batch;
    return value;
  }

  private async textFor(entry: SnapshotEntry | undefined): Promise<string> {
    if (!entry || entry.binary) return "";
    return readFile(this.blobPath(entry.hash), "utf8");
  }

  private hunksFor(
    filePath: string,
    original: string,
    modified: string,
    oldStates = new Map<string, ReviewState>(),
  ): DiffHunk[] {
    const patch = structuredPatch(
      filePath,
      filePath,
      original,
      modified,
      "",
      "",
      { context: 3 },
    );
    return patch.hunks.map((hunk) => {
      const id = hash(
        JSON.stringify([
          hunk.oldStart,
          hunk.oldLines,
          hunk.newStart,
          hunk.newLines,
          hunk.lines,
        ]),
      );
      return {
        id,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        reviewState: oldStates.get(id) ?? "unreviewed",
      };
    });
  }

  private async refresh(batch: StoredBatch): Promise<StoredBatch> {
    const current = await this.snapshot(batch.workspacePath);
    const oldChanges = new Map(batch.files.map((entry) => [entry.path, entry]));
    const removed = new Set(
      Object.keys(batch.baseline).filter((entry) => !current[entry]),
    );
    const added = new Set(
      Object.keys(current).filter((entry) => !batch.baseline[entry]),
    );
    const renames = new Map<string, string>();
    for (const oldPath of removed) {
      const match = [...added].find(
        (newPath) => current[newPath]!.hash === batch.baseline[oldPath]!.hash,
      );
      if (match) {
        renames.set(match, oldPath);
        removed.delete(oldPath);
        added.delete(match);
      }
    }
    const candidates = new Set([
      ...Object.keys(batch.baseline),
      ...Object.keys(current),
    ]);
    const files: FileChange[] = [];
    for (const filePath of [...candidates].sort()) {
      const before = batch.baseline[filePath];
      const after = current[filePath];
      if (before?.hash === after?.hash) continue;
      if (!before && !added.has(filePath) && !renames.has(filePath)) continue;
      if (!after && !removed.has(filePath)) continue;
      const previousPath = renames.get(filePath) ?? null;
      const originalEntry = previousPath
        ? batch.baseline[previousPath]
        : before;
      const binary = Boolean(originalEntry?.binary || after?.binary);
      const original = await this.textFor(originalEntry);
      const modified = await this.textFor(after);
      const old = oldChanges.get(filePath);
      const oldStates = new Map(
        old?.hunks.map((entry) => [entry.id, entry.reviewState]) ?? [],
      );
      const hunks = binary
        ? []
        : this.hunksFor(filePath, original, modified, oldStates);
      let additions = 0,
        deletions = 0;
      if (!binary)
        for (const part of diffLines(original, modified)) {
          if (part.added) additions += part.count ?? 0;
          else if (part.removed) deletions += part.count ?? 0;
        }
      files.push({
        path: filePath,
        previousPath,
        kind: binary
          ? "binary"
          : previousPath
            ? "renamed"
            : !originalEntry
              ? "added"
              : !after
                ? "deleted"
                : "modified",
        binary,
        originalHash: originalEntry?.hash ?? null,
        currentHash: after?.hash ?? null,
        additions,
        deletions,
        reviewState: old?.reviewState ?? "unreviewed",
        hunks,
      });
    }
    batch.files = files;
    batch.closedAt ??= new Date().toISOString();
    batch.state = "ready";
    await this.save(batch);
    return batch;
  }

  async close(id: string): Promise<ChangeBatch> {
    return this.publicBatch(await this.refresh(await this.load(id)));
  }

  async list(): Promise<ChangeBatch[]> {
    let names: string[];
    try {
      names = await readdir(this.batchesDirectory);
    } catch {
      return [];
    }
    const batches = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(
          async (name) =>
            JSON.parse(
              await readFile(path.join(this.batchesDirectory, name), "utf8"),
            ) as StoredBatch,
        ),
    );
    return batches
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50)
      .map((entry) => this.publicBatch(entry));
  }

  private change(batch: StoredBatch, filePath: string): FileChange {
    const value = batch.files.find(
      (entry) => entry.path === normalized(filePath),
    );
    if (!value) throw new Error("变更文件不存在或批次尚未结束");
    return value;
  }

  async diff(id: string, filePath: string): Promise<FileDiff> {
    const batch = await this.load(id);
    const change = this.change(batch, filePath);
    const originalEntry = change.previousPath
      ? batch.baseline[change.previousPath]
      : batch.baseline[change.path];
    const original = await this.textFor(originalEntry);
    let modified = "";
    if (change.currentHash && !change.binary)
      modified = await readFile(
        path.join(batch.workspacePath, change.path),
        "utf8",
      );
    if (
      change.currentHash &&
      !change.binary &&
      hash(Buffer.from(modified)) !== change.currentHash
    ) {
      batch.state = "stale";
      await this.save(batch);
      throw new Error("文件在批次结束后又被修改，请重新建立变更批次后审阅");
    }
    return {
      batchId: id,
      path: change.path,
      language: languageFor(change.path),
      original,
      modified,
      change,
    };
  }

  async markReviewed(
    id: string,
    filePath: string,
    hunkId?: string,
  ): Promise<ChangeBatch> {
    const batch = await this.load(id);
    const change = this.change(batch, filePath);
    if (hunkId) {
      const hunk = change.hunks.find((entry) => entry.id === hunkId);
      if (!hunk) throw new Error("Diff 代码块不存在");
      hunk.reviewState = "reviewed";
      if (change.hunks.every((entry) => entry.reviewState !== "unreviewed"))
        change.reviewState = "reviewed";
    } else {
      change.reviewState = "reviewed";
      for (const hunk of change.hunks) hunk.reviewState = "reviewed";
    }
    await this.save(batch);
    return this.publicBatch(batch);
  }

  private async verifyCurrent(
    batch: StoredBatch,
    change: FileChange,
  ): Promise<string> {
    if (!change.currentHash) return "";
    const data = await readFile(path.join(batch.workspacePath, change.path));
    if (hash(data) !== change.currentHash)
      throw new Error("文件已在审阅后发生变化，为避免覆盖内容已停止撤销");
    return data.toString("utf8");
  }

  async revertFile(id: string, filePath: string): Promise<ChangeBatch> {
    const batch = await this.load(id);
    const change = this.change(batch, filePath);
    await this.verifyCurrent(batch, change);
    const target = path.join(batch.workspacePath, change.path);
    const originalEntry = change.previousPath
      ? batch.baseline[change.previousPath]
      : batch.baseline[change.path];
    if (!originalEntry) await rm(target, { force: true });
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(
        target,
        await readFile(this.blobPath(originalEntry.hash)),
      );
    }
    if (change.previousPath && change.previousPath !== change.path) {
      const oldTarget = path.join(batch.workspacePath, change.previousPath);
      await mkdir(path.dirname(oldTarget), { recursive: true });
      await writeFile(
        oldTarget,
        await readFile(this.blobPath(originalEntry!.hash)),
      );
      await rm(target, { force: true });
    }
    return this.publicBatch(await this.refresh(batch));
  }

  async revertHunk(
    id: string,
    filePath: string,
    hunkId: string,
  ): Promise<ChangeBatch> {
    const batch = await this.load(id);
    const change = this.change(batch, filePath);
    if (change.binary || !change.currentHash)
      throw new Error("此文件不支持代码块撤销");
    const current = await this.verifyCurrent(batch, change);
    const originalEntry = change.previousPath
      ? batch.baseline[change.previousPath]
      : batch.baseline[change.path];
    const original = await this.textFor(originalEntry);
    const patch = structuredPatch(
      change.path,
      change.path,
      original,
      current,
      "",
      "",
      { context: 3 },
    );
    const index = change.hunks.findIndex((entry) => entry.id === hunkId);
    if (index < 0 || !patch.hunks[index]) throw new Error("Diff 代码块已失效");
    const single: StructuredPatch = { ...patch, hunks: [patch.hunks[index]] };
    const reverted = applyPatch(current, formatPatch(reversePatch(single)), {
      autoConvertLineEndings: true,
    });
    if (reverted === false)
      throw new Error("无法安全撤销此代码块，请重新载入 Diff");
    await writeFile(
      path.join(batch.workspacePath, change.path),
      reverted,
      "utf8",
    );
    return this.publicBatch(await this.refresh(batch));
  }
}
