import type { HarnessUpdateState } from "../shared/contracts.js";
import { redactSensitive } from "../shared/security.js";

const LATEST_DSH_URL = "https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest";

function parts(version: string): { core: number[]; prerelease: string[] | null } {
  const clean = version.trim().replace(/^v/, "");
  const [core = "0", prerelease = ""] = clean.split("-", 2);
  return { core: core.split(".").map((part) => Number(part)), prerelease: prerelease ? prerelease.split(".") : null };
}

export function isNewerHarnessVersion(latest: string, current: string): boolean {
  const left = parts(latest);
  const right = parts(current);
  for (let index = 0; index < Math.max(left.core.length, right.core.length); index += 1) {
    const a = left.core[index] ?? 0;
    const b = right.core[index] ?? 0;
    if (a === b) continue;
    return a > b;
  }
  if (left.prerelease === null || right.prerelease === null) return left.prerelease === null && right.prerelease !== null;
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) return b === undefined;
    if (a === b) continue;
    return a.localeCompare(b, "en", { numeric: true }) > 0;
  }
  return false;
}

export async function checkHarnessUpdate(currentVersion: string): Promise<HarnessUpdateState> {
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetch(LATEST_DSH_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
    const value = await response.json() as { version?: unknown };
    if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)) throw new Error("npm registry returned an invalid Harness version");
    return { phase: "ready", currentVersion, latestVersion: value.version, updateAvailable: isNewerHarnessVersion(value.version, currentVersion), checkedAt, errorSummary: null };
  } catch (error) {
    return { phase: "error", currentVersion, latestVersion: null, updateAvailable: false, checkedAt, errorSummary: redactSensitive(error instanceof Error ? error.message : String(error)) };
  }
}
