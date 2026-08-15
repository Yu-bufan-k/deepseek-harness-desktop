import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function yamlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function writeDesktopOverlay(
  directory: string,
  pluginPath: string,
  billingPluginPath?: string,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const overlayPath = path.join(directory, "desktop.cordis.patch.yml");
  const pluginUrl = pathToFileURL(pluginPath).href;
  const billingPluginUrl = billingPluginPath
    ? pathToFileURL(billingPluginPath).href
    : null;
  const contents = [
    "# 由 DeepSeek Harness Desktop 管理。请勿手动编辑。",
    "# 使用 Electron 主进程提供的系统目录选择器，替代 Web Host 的原生 Worker。",
    "- id: directory-picker",
    "  disabled: true",
    "- insert:",
    "    - id: directory-picker-desktop",
    `      name: ${yamlString(pluginUrl)}`,
    "    - id: directory-picker-desktop-surface",
    "      name: '@deepseek-ai/dsh-client-ui-directory-picker-native'",
    ...(billingPluginUrl
      ? [
          "    - id: desktop-billing",
          `      name: ${yamlString(billingPluginUrl)}`,
        ]
      : []),
    "",
  ].join("\n");
  await writeFile(overlayPath, contents, "utf8");
  return overlayPath;
}
