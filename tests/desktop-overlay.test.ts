import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeDesktopOverlay } from "../src/main/desktop-overlay.js";

const temporaryDirectories: string[] = [];
const require = createRequire(import.meta.url);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("writeDesktopOverlay", () => {
  it("使用独立桌面 capability 替换自动原生后端", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-desktop-overlay-"));
    temporaryDirectories.push(directory);
    const overlayPath = await writeDesktopOverlay(directory, "D:\\Desktop App\\picker.js");
    const contents = await readFile(overlayPath, "utf8");

    expect(contents).toContain("id: directory-picker");
    expect(contents).toContain("disabled: true");
    expect(contents).toContain("- insert:");
    expect(contents).toContain("id: directory-picker-desktop");
    expect(contents).toContain("file:///D:/Desktop%20App/picker.js");
    expect(contents).toContain("@deepseek-ai/dsh-client-ui-directory-picker-native");
    expect(contents).not.toContain("dsh-host-directory-picker-native");
  });

  it("可插入桌面计费插件文件 URL", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-desktop-billing-"));
    temporaryDirectories.push(directory);
    const overlayPath = await writeDesktopOverlay(directory, "D:\\Desktop App\\picker.js", "D:\\Desktop App\\billing\\index.js");
    const contents = await readFile(overlayPath, "utf8");

    expect(contents).toContain("id: desktop-billing");
    expect(contents).toContain("file:///D:/Desktop%20App/billing/index.js");
  });

  it("在 Harness 最终配置中禁用 auto 后端并插入桌面后端", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-desktop-compose-"));
    temporaryDirectories.push(directory);
    const overlayPath = await writeDesktopOverlay(directory, "D:\\Desktop App\\picker.js");
    const dshPackage = require.resolve("@deepseek-ai/dsh/package.json");
    const dshEntry = path.join(path.dirname(dshPackage), "lib", "bin.js");
    const result = spawnSync(process.execPath, [dshEntry, "web", "--patch", overlayPath, "--dump-config"], {
      encoding: "utf8",
      env: { ...process.env, DSH_HOME: path.join(directory, "dsh-home") }
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/name mismatch|not found/i);
    expect(result.stdout).toMatch(/id: directory-picker[\s\S]*?disabled: true/);
    expect(result.stdout).toContain("id: directory-picker-desktop");
    expect(result.stdout).toContain("file:///D:/Desktop%20App/picker.js");
  }, 15_000);
});
