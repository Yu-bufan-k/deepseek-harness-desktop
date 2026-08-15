import { readFile } from "node:fs/promises";
import path from "node:path";

const SAFE_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

function parseScalar(raw: string): string | null {
  const value = raw.trim();
  if (!value || value === "null" || value === "~" || value.startsWith("|") || value.startsWith(">")) return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    try { const parsed = JSON.parse(value); return typeof parsed === "string" ? parsed : null; } catch { return null; }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  // Harness credential values are single-line scalars. Reject whitespace/comments
  // rather than attempting to implement the full YAML grammar around a secret.
  return /[\s#]/.test(value) ? null : value;
}

export async function readHarnessCredential(dshHome: string, name: string): Promise<string | null> {
  if (!SAFE_NAME.test(name)) throw new Error("Credential name must be an uppercase environment variable name");
  try {
    const contents = await readFile(path.join(dshHome, ".credentials.yaml"), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^([A-Z][A-Z0-9_]{1,63}):\s*(.*)$/);
      if (match?.[1] === name) return parseScalar(match[2] ?? "");
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
