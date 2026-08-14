import { cp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const projectDir = process.cwd();
const stageDir = path.join(projectDir, ".pack-app");
const packagingDir = path.join(projectDir, "packaging");

await rm(stageDir, { recursive: true, force: true });
await mkdir(stageDir, { recursive: true });
await cp(path.join(projectDir, "dist"), path.join(stageDir, "dist"), { recursive: true });
await cp(path.join(packagingDir, "package.json"), path.join(stageDir, "package.json"));
await cp(path.join(packagingDir, "package-lock.json"), path.join(stageDir, "package-lock.json"));
await cp(path.join(projectDir, "README.md"), path.join(stageDir, "README.md"));
await cp(path.join(projectDir, "LICENSE"), path.join(stageDir, "LICENSE"));

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(
  npm,
  ["ci", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"],
  { cwd: stageDir, env: process.env, stdio: "inherit", shell: process.platform === "win32" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
