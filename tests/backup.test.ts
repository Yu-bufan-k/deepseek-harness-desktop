import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup } from "../src/main/backup.js";

const directories: string[] = [];
afterEach(() => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("backup", () => {
  it("copies supported user data and records metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dsh-desktop-backup-"));
    directories.push(root);
    const home = path.join(root, "dsh");
    await mkdir(path.join(home, "profiles"), { recursive: true });
    await writeFile(path.join(home, "profiles", "profile.json"), "{}\n");
    const destination = await createBackup(home, path.join(root, "backups"), { version: "1.0.0" });
    expect(await readFile(path.join(destination, "profiles", "profile.json"), "utf8")).toBe("{}\n");
    expect(JSON.parse(await readFile(path.join(destination, "backup.json"), "utf8")).version).toBe("1.0.0");
  });
});
