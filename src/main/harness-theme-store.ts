import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ThemePreference } from "../shared/contracts.js";

const validPreferences = new Set<ThemePreference>(["light", "dark", "system"]);

export class HarnessThemeStore {
  readonly filePath: string;

  constructor(dshHome: string) {
    this.filePath = path.join(dshHome, "settings.yaml");
  }

  getPreference(): ThemePreference {
    try {
      const lines = readFileSync(this.filePath, "utf8").split(/\r?\n/);
      let inThemeSection = false;
      for (const line of lines) {
        if (/^ui-theme:\s*(?:#.*)?$/.test(line)) {
          inThemeSection = true;
          continue;
        }
        if (inThemeSection && /^\S/.test(line) && !/^#/.test(line)) break;
        if (!inThemeSection) continue;
        const match = line.match(
          /^\s+preference:\s*(light|dark|system)\s*(?:#.*)?$/,
        );
        if (match && validPreferences.has(match[1] as ThemePreference))
          return match[1] as ThemePreference;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return "system";
  }

  async setPreference(preference: ThemePreference): Promise<ThemePreference> {
    if (!validPreferences.has(preference))
      throw new Error("Invalid theme preference");
    let content = "";
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const themeIndex = lines.findIndex((line) =>
      /^ui-theme:\s*(?:#.*)?$/.test(line),
    );
    if (themeIndex === -1) {
      while (lines.at(-1) === "") lines.pop();
      if (lines.length) lines.push("");
      lines.push("ui-theme:", `  preference: ${preference}`);
    } else {
      let end = themeIndex + 1;
      while (end < lines.length) {
        const line = lines[end]!;
        if (/^\S/.test(line) && !/^#/.test(line)) break;
        end += 1;
      }
      const preferenceIndex = lines.findIndex(
        (line, index) =>
          index > themeIndex && index < end && /^\s+preference:/.test(line),
      );
      if (preferenceIndex === -1)
        lines.splice(themeIndex + 1, 0, `  preference: ${preference}`);
      else
        lines[preferenceIndex] =
          `${lines[preferenceIndex]!.match(/^\s*/)?.[0] ?? "  "}preference: ${preference}`;
    }
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${lines.join("\n").replace(/\n+$/, "")}\n`,
      "utf8",
    );
    return preference;
  }
}
