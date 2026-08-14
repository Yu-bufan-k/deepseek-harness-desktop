import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../src/main/settings-store.js";

const directories: string[] = [];
afterEach(() => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("SettingsStore", () => {
  it("loads defaults and persists updates", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-desktop-settings-"));
    directories.push(directory);
    const store = new SettingsStore(directory);
    expect((await store.load()).updateChannel).toBe("stable");
    await store.patch({ updateChannel: "beta", workspacePath: "C:\\work" });
    const saved = JSON.parse(await readFile(store.filePath, "utf8"));
    expect(saved.updateChannel).toBe("beta");
    expect(saved.workspacePath).toBe("C:\\work");
  });
});
