import { realpath, stat } from "node:fs/promises";
import path from "node:path";

function argumentCandidates(argv: readonly string[], isPackaged: boolean): readonly string[] {
  // Packaged: [app.exe, ...files]. Development: [electron.exe, app-entry, ...files].
  return argv.slice(isPackaged ? 1 : 2);
}

export async function resolveLaunchDirectories(
  argv: readonly string[],
  workingDirectory: string,
  isPackaged: boolean,
): Promise<string[]> {
  const directories: string[] = [];
  const seen = new Set<string>();

  for (const argument of argumentCandidates(argv, isPackaged)) {
    if (!argument || argument.startsWith("-")) continue;
    const candidate = path.resolve(workingDirectory, argument);
    try {
      const info = await stat(candidate);
      if (!info.isDirectory()) continue;
      const canonical = await realpath(candidate);
      const key = process.platform === "win32" ? canonical.toLocaleLowerCase("en-US") : canonical;
      if (seen.has(key)) continue;
      seen.add(key);
      directories.push(canonical);
    } catch {
      // Shell arguments can include protocol/internal values. Only real directories qualify.
    }
  }

  return directories;
}
