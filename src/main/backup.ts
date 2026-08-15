import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const BACKUP_NAMES = ["profiles", "skills", "sessions", "cordis.patch.yml"];

export async function createBackup(
  dshHome: string,
  backupRoot: string,
  metadata: object,
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(backupRoot, stamp);
  await mkdir(destination, { recursive: true });
  for (const name of BACKUP_NAMES) {
    const source = path.join(dshHome, name);
    try {
      await stat(source);
      await cp(source, path.join(destination, name), {
        recursive: true,
        force: false,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await writeFile(
    path.join(destination, "backup.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  await pruneBackups(backupRoot, 3);
  return destination;
}

export async function pruneBackups(
  backupRoot: string,
  keep: number,
): Promise<void> {
  let entries: string[];
  try {
    entries = (await readdir(backupRoot)).sort().reverse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(
    entries
      .slice(keep)
      .map((name) => rm(path.join(backupRoot, name), { recursive: true })),
  );
}
