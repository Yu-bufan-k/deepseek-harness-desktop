import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import type { HarnessInfo, HarnessStatus } from "../shared/contracts.js";
import { redactSensitive, sanitizedEnvironment } from "../shared/security.js";
import { findAvailablePort, waitForHttp } from "./port.js";
import { terminateProcessTree } from "./process-tree.js";

const require = createRequire(__filename);
const DSH_VERSION = "0.1.0-rc.6";

export interface HarnessManagerOptions {
  dshHome: string;
  workspace: () => string | null;
  credentials: () => Promise<Record<string, string>>;
  log: (message: string) => void;
  desktopOverlayPath: string;
  directoryPickerBridge: { port: number; token: string };
}

export class HarnessManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private readonly intentionalStops = new WeakSet<ChildProcess>();
  private info: HarnessInfo = {
    status: "stopped", version: DSH_VERSION, port: null, pid: null,
    startedAt: null, errorSummary: null
  };
  readonly sessionToken = randomBytes(32).toString("hex");

  constructor(private readonly options: HarnessManagerOptions) { super(); }

  getInfo(): HarnessInfo { return structuredClone(this.info); }

  private setStatus(status: HarnessStatus, patch: Partial<HarnessInfo> = {}): void {
    this.info = { ...this.info, ...patch, status };
    this.emit("changed", this.getInfo());
  }

  private dshEntry(): string {
    const resolvedPackageJson = require.resolve("@deepseek-ai/dsh/package.json");
    const unpackedPackageJson = resolvedPackageJson.replace(
      /([\\/])app\.asar\1/,
      `$1app.asar.unpacked$1`,
    );
    const packageJson = fs.existsSync(unpackedPackageJson) ? unpackedPackageJson : resolvedPackageJson;
    return path.join(path.dirname(packageJson), "lib", "bin.js");
  }

  async start(): Promise<HarnessInfo> {
    if (this.child && this.child.exitCode === null) return this.getInfo();
    const port = await findAvailablePort();
    this.setStatus("starting", { port, pid: null, startedAt: new Date().toISOString(), errorSummary: null });
    const workspace = this.options.workspace() ?? process.cwd();
    fs.mkdirSync(this.options.dshHome, { recursive: true });
    const secrets = await this.options.credentials();
    const environment = {
      ...sanitizedEnvironment(process.env),
      ...secrets,
      DSH_HOME: this.options.dshHome,
      DSH_DESKTOP_SESSION_TOKEN: this.sessionToken,
      DSH_DESKTOP_BRIDGE_PORT: String(this.options.directoryPickerBridge.port),
      DSH_DESKTOP_BRIDGE_TOKEN: this.options.directoryPickerBridge.token,
      ELECTRON_RUN_AS_NODE: "1"
    };

    const child = spawn(process.execPath, [
      "--expose-internals", this.dshEntry(), "web", "--patch", this.options.desktopOverlayPath,
      "--host", "127.0.0.1", "--port", String(port)
    ], {
      cwd: workspace,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });
    this.child = child;
    this.setStatus("starting", { pid: child.pid ?? null });
    child.stdout?.on("data", (chunk) => this.options.log(`[dsh] ${redactSensitive(String(chunk)).trimEnd()}`));
    child.stderr?.on("data", (chunk) => this.options.log(`[dsh:err] ${redactSensitive(String(chunk)).trimEnd()}`));
    child.once("exit", (code, signal) => {
      const intentional = this.intentionalStops.has(child);
      this.intentionalStops.delete(child);
      // A delayed exit from a previous restart must never clear or fail the
      // replacement child that is already starting or ready.
      if (this.child !== child) return;
      this.child = null;
      if (intentional) this.setStatus("stopped", { pid: null, port: null });
      else this.setStatus("failed", {
        pid: null,
        errorSummary: `Harness exited unexpectedly (code ${String(code)}, signal ${String(signal)})`
      });
    });

    try {
      const exitedEarly = new Promise<never>((_resolve, reject) => {
        child.once("exit", (code, signal) => reject(new Error(`Harness exited before becoming ready (code ${String(code)}, signal ${String(signal)})`)));
      });
      await Promise.race([waitForHttp(`http://127.0.0.1:${port}/`), exitedEarly]);
      this.setStatus("ready");
      return this.getInfo();
    } catch (error) {
      this.setStatus("failed", { errorSummary: redactSensitive(String(error)) });
      await terminateProcessTree(child);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.child) { this.setStatus("stopped"); return; }
    const child = this.child;
    this.intentionalStops.add(child);
    this.setStatus("stopping");
    await terminateProcessTree(child);
    if (this.child === child) {
      this.child = null;
      this.setStatus("stopped", { pid: null, port: null });
    }
  }

  async restart(): Promise<HarnessInfo> {
    await this.stop();
    return await this.start();
  }
}
