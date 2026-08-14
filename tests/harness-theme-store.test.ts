import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessThemeStore } from "../src/main/harness-theme-store.js";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("HarnessThemeStore", () => {
  it("shares ui-theme.preference without overwriting other Harness settings", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-theme-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "settings.yaml");
    await writeFile(filePath, "ui-onboarding:\n  welcomeNoticeVersion: 1\n", "utf8");
    const store = new HarnessThemeStore(directory);

    expect(store.getPreference()).toBe("system");
    await store.setPreference("dark");
    expect(store.getPreference()).toBe("dark");
    await store.setPreference("light");
    const content = await readFile(filePath, "utf8");
    expect(content).toContain("ui-onboarding:");
    expect(content).toContain("ui-theme:\n  preference: light");
  });
});
