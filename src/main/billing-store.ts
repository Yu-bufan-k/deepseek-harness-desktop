import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BillingCatalog, BillingPriceRule, BillingSettings, BillingUpdateResult } from "../shared/billing.js";
import { SettingsStore } from "./settings-store.js";

const REMOTE_CATALOG_URL = "https://raw.githubusercontent.com/Yu-bufan-k/deepseek-harness-desktop/main/pricing/prices.json";

function validRule(value: unknown): value is BillingPriceRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Partial<BillingPriceRule>;
  return typeof rule.id === "string" && typeof rule.provider === "string" && typeof rule.model === "string"
    && typeof rule.label === "string" && typeof rule.currency === "string"
    && ["official", "custom", "free"].includes(rule.mode ?? "")
    && typeof rule.effectiveFrom === "string" && Number.isFinite(Date.parse(rule.effectiveFrom))
    && validRates(rule.rates)
    && (rule.peakRates === undefined || validRates(rule.peakRates))
    && (rule.peakWindows === undefined || (Array.isArray(rule.peakWindows) && rule.peakWindows.every((window) => /^\d{2}:\d{2}$/.test(window.start) && /^\d{2}:\d{2}$/.test(window.end))));
}

function validRates(rates: unknown): boolean {
  if (!rates || typeof rates !== "object") return false;
  const value = rates as Record<string, unknown>;
  return [value.input, value.cacheRead, value.cacheWrite, value.output]
    .every((rate) => typeof rate === "number" && Number.isFinite(rate) && rate >= 0);
}

export function validateCatalog(value: unknown): BillingCatalog {
  if (!value || typeof value !== "object") throw new Error("价格清单格式无效");
  const catalog = value as Partial<BillingCatalog>;
  if (catalog.schemaVersion !== 1 || typeof catalog.publishedAt !== "string" || typeof catalog.source !== "string"
    || !Array.isArray(catalog.rules) || !catalog.rules.every(validRule)) {
    throw new Error("价格清单字段不完整或包含无效单价");
  }
  return structuredClone(catalog as BillingCatalog);
}

export class BillingStore {
  private builtinCatalog!: BillingCatalog;

  constructor(private readonly settings: SettingsStore, private readonly resourcesPath: string) {}

  async load(): Promise<void> {
    const catalogPath = path.join(this.resourcesPath, "pricing", "prices.json");
    this.builtinCatalog = validateCatalog(JSON.parse(await readFile(catalogPath, "utf8")));
    if (!this.settings.get().billing) await this.settings.patch({ billing: this.defaults() });
  }

  get(): BillingSettings {
    return structuredClone(this.settings.get().billing ?? this.defaults());
  }

  async save(next: BillingSettings): Promise<BillingSettings> {
    const catalog = validateCatalog(next.catalog);
    if (!Array.isArray(next.customRules) || !next.customRules.every(validRule)) throw new Error("自定义价格规则无效");
    if (!Number.isInteger(next.checkIntervalHours) || next.checkIntervalHours < 1 || next.checkIntervalHours > 720) throw new Error("检查间隔应为 1–720 小时");
    const value: BillingSettings = {
      autoUpdate: Boolean(next.autoUpdate),
      checkIntervalHours: next.checkIntervalHours,
      lastCheckedAt: next.lastCheckedAt,
      catalog,
      customRules: structuredClone(next.customRules)
    };
    await this.settings.patch({ billing: value });
    return this.get();
  }

  async checkForUpdates(): Promise<BillingUpdateResult> {
    const response = await fetch(REMOTE_CATALOG_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`价格更新服务返回 HTTP ${response.status}`);
    const remote = validateCatalog(await response.json());
    const current = this.get();
    const updated = Date.parse(remote.publishedAt) > Date.parse(current.catalog.publishedAt);
    const checkedAt = new Date().toISOString();
    const settings = await this.save({ ...current, lastCheckedAt: checkedAt, catalog: updated ? remote : current.catalog });
    return { updated, checkedAt, settings, message: updated ? "已更新到最新官方价格清单" : "当前已是最新价格清单" };
  }

  shouldAutoCheck(): boolean {
    const value = this.get();
    if (!value.autoUpdate) return false;
    const last = value.lastCheckedAt ? Date.parse(value.lastCheckedAt) : 0;
    return !Number.isFinite(last) || Date.now() - last >= value.checkIntervalHours * 3_600_000;
  }

  private defaults(): BillingSettings {
    return { autoUpdate: true, checkIntervalHours: 24, lastCheckedAt: null, catalog: structuredClone(this.builtinCatalog), customRules: [] };
  }
}
