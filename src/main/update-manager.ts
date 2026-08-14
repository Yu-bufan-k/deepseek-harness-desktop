import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateChannel, UpdateState } from "../shared/contracts.js";
import { redactSensitive } from "../shared/security.js";

export class UpdateManager extends EventEmitter {
  private state: UpdateState = { phase: "idle", configured: false, version: null, percent: null, errorSummary: null };
  private configured = false;

  constructor(private channel: UpdateChannel, repository: string | null) {
    super();
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    this.configure(repository);
    autoUpdater.on("checking-for-update", () => this.set({ phase: "checking" }));
    autoUpdater.on("update-available", (info) => this.set({ phase: "available", version: info.version }));
    autoUpdater.on("update-not-available", () => this.set({ phase: "idle", version: null, percent: null }));
    autoUpdater.on("download-progress", (progress) => this.set({ phase: "downloading", percent: progress.percent }));
    autoUpdater.on("update-downloaded", (info) => this.set({ phase: "ready", version: info.version, percent: 100 }));
    autoUpdater.on("error", (error) => this.set({ phase: "error", errorSummary: redactSensitive(error.message) }));
  }

  private configure(repository: string | null): void {
    const candidate = repository ?? process.env.GITHUB_REPOSITORY ?? null;
    if (!candidate || !/^[\w.-]+\/[\w.-]+$/.test(candidate)) {
      // Release builds receive app-update.yml from electron-builder. Let
      // electron-updater consume that generated configuration directly.
      this.configured = app.isPackaged && existsSync(path.join(process.resourcesPath, "app-update.yml"));
      this.state.configured = this.configured;
      autoUpdater.channel = this.channel;
      autoUpdater.allowPrerelease = this.channel === "beta";
      return;
    }
    const [owner, repo] = candidate.split("/") as [string, string];
    autoUpdater.setFeedURL({ provider: "github", owner, repo, channel: this.channel });
    autoUpdater.allowPrerelease = this.channel === "beta";
    this.configured = true;
    this.state.configured = true;
  }

  getState(): UpdateState { return structuredClone(this.state); }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, errorSummary: null, ...patch };
    this.emit("changed", this.getState());
  }

  async setChannel(channel: UpdateChannel): Promise<UpdateState> {
    this.channel = channel;
    autoUpdater.channel = channel;
    autoUpdater.allowPrerelease = channel === "beta";
    this.set({ phase: "idle", version: null, percent: null });
    return this.getState();
  }

  async check(): Promise<UpdateState> {
    if (!this.configured) {
      this.set({ phase: "idle", errorSummary: null });
      return this.getState();
    }
    try { await autoUpdater.checkForUpdates(); } catch (error) {
      this.set({ phase: "error", errorSummary: redactSensitive(String(error)) });
    }
    return this.getState();
  }

  async download(): Promise<UpdateState> {
    if (this.state.phase !== "available") throw new Error("No update is ready to download");
    this.set({ phase: "downloading", percent: 0 });
    await autoUpdater.downloadUpdate();
    return this.getState();
  }

  install(): void {
    if (this.state.phase !== "ready") throw new Error("No downloaded update is ready to install");
    this.set({ phase: "installing" });
    autoUpdater.quitAndInstall(false, true);
  }
}
