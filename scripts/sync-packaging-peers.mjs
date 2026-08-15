import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const scanDir = path.join(root, ".peer-scan");
await rm(scanDir, { recursive: true, force: true });
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const deployed = spawnSync(
  pnpm,
  ["--filter", "deepseek-harness-desktop", "deploy", "--prod", scanDir],
  {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);
if (deployed.status !== 0) process.exit(deployed.status ?? 1);

const store = path.join(scanDir, "node_modules", ".pnpm");
const manifests = [];
for (const entry of await readdir(store, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const modules = path.join(store, entry.name, "node_modules");
  let packages;
  try {
    packages = await readdir(modules, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const item of packages) {
    if (!item.isDirectory() && !item.isSymbolicLink()) continue;
    if (item.name.startsWith("@")) {
      let scoped;
      try {
        scoped = await readdir(path.join(modules, item.name), {
          withFileTypes: true,
        });
      } catch {
        continue;
      }
      for (const child of scoped) {
        if (!child.isDirectory() && !child.isSymbolicLink()) continue;
        try {
          manifests.push(
            JSON.parse(
              await readFile(
                path.join(modules, item.name, child.name, "package.json"),
                "utf8",
              ),
            ),
          );
        } catch {
          // 该子包没有 package.json，跳过。
        }
      }
    } else {
      try {
        manifests.push(
          JSON.parse(
            await readFile(
              path.join(modules, item.name, "package.json"),
              "utf8",
            ),
          ),
        );
      } catch {
        // 该包没有 package.json，跳过。
      }
    }
  }
}

const versions = new Map(
  manifests
    .filter((pkg) => pkg.name && pkg.version)
    .map((pkg) => [pkg.name, pkg.version]),
);
const pinnedNames = new Set(
  manifests
    .filter((pkg) => pkg.name?.startsWith("@deepseek-ai/"))
    .map((pkg) => pkg.name),
);
for (const pkg of manifests) {
  for (const name of Object.keys(pkg.peerDependencies ?? {})) {
    if (versions.has(name)) pinnedNames.add(name);
  }
}

const manifestPath = path.join(root, "packaging", "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
for (const name of pinnedNames)
  manifest.dependencies[name] = versions.get(name);
manifest.dependencies = Object.fromEntries(
  Object.entries(manifest.dependencies).sort(([a], [b]) => a.localeCompare(b)),
);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await rm(scanDir, { recursive: true, force: true });
console.log(
  `Pinned ${pinnedNames.size} production and peer packages for desktop packaging.`,
);
