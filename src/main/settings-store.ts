import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { UpdateChannel, VisionSettings } from "../shared/contracts.js";
import type { BillingSettings } from "../shared/billing.js";

export interface DesktopSettings {
  workspacePath: string | null;
  updateChannel: UpdateChannel;
  updateRepository: string | null;
  lastGoodVersion: string | null;
  pendingVersion: string | null;
  failedStarts: number;
  billing?: BillingSettings;
  vision?: VisionSettings;
}

const defaults: DesktopSettings = {
  workspacePath: null,
  updateChannel: "stable",
  updateRepository: null,
  lastGoodVersion: null,
  pendingVersion: null,
  failedStarts: 0,
};

export class SettingsStore {
  readonly filePath: string;
  private value: DesktopSettings = { ...defaults };

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "desktop-settings.json");
  }

  async load(): Promise<DesktopSettings> {
    try {
      const raw = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<DesktopSettings>;
      this.value = { ...defaults, ...raw };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return this.get();
  }

  get(): DesktopSettings {
    return structuredClone(this.value);
  }

  async patch(update: Partial<DesktopSettings>): Promise<DesktopSettings> {
    this.value = { ...this.value, ...update };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify(this.value, null, 2)}\n`,
      "utf8",
    );
    return this.get();
  }
}
