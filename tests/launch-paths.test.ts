import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLaunchDirectories } from "../src/main/launch-paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("resolveLaunchDirectories", () => {
  it("提取安装版命令行中的文件夹并忽略文件和参数", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dsh-launch-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "项目 A");
    await mkdir(workspace);
    await writeFile(path.join(root, "readme.txt"), "test");

    await expect(
      resolveLaunchDirectories(
        [
          "DeepSeek Harness Desktop.exe",
          workspace,
          "--ignored",
          path.join(root, "readme.txt"),
        ],
        root,
        true,
      ),
    ).resolves.toEqual([await realpath(workspace)]);
  });

  it("开发模式跳过 Electron 与应用入口并去除重复目录", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dsh-launch-dev-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);

    await expect(
      resolveLaunchDirectories(
        ["electron.exe", ".", workspace, workspace],
        root,
        false,
      ),
    ).resolves.toEqual([await realpath(workspace)]);
  });
});
