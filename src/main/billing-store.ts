import { verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BillingCatalog, BillingPeakSchedule, BillingPriceRule, BillingSettings, BillingUpdateResult } from "../shared/billing.js";
import { SettingsStore } from "./settings-store.js";

const REMOTE_CATALOG_URLS = [
  "https://raw.githubusercontent.com/Yu-bufan-k/deepseek-harness-desktop/main/pricing/prices.signed.json",
  "https://cdn.jsdelivr.net/gh/Yu-bufan-k/deepseek-harness-desktop@main/pricing/prices.signed.json"
];
const MAX_CATALOG_BYTES = 2_000_000;

interface SignedCatalogEnvelope { algorithm: "Ed25519"; keyId: string; catalog: unknown; signature: string; }
interface BillingStoreOptions { remoteUrls?: string[]; fetcher?: typeof fetch; publicKeyPem?: string; }

function validRates(rates: unknown): boolean {
  if (!rates || typeof rates !== "object") return false;
  const value = rates as Record<string, unknown>;
  return [value.input, value.cacheRead, value.cacheWrite, value.output].every((rate) => typeof rate === "number" && Number.isFinite(rate) && rate >= 0);
}

function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return true; } catch { return false; }
}

function validSchedule(value: unknown): value is BillingPeakSchedule {
  if (!value || typeof value !== "object") return false;
  const schedule = value as Partial<BillingPeakSchedule>;
  return typeof schedule.id === "string" && schedule.id.length > 0 && typeof schedule.label === "string"
    && typeof schedule.timezone === "string" && validTimezone(schedule.timezone)
    && Array.isArray(schedule.windows) && schedule.windows.length > 0
    && schedule.windows.every((window) => Number.isInteger(window.startMinute) && window.startMinute >= 0 && window.startMinute < 1440
      && Number.isInteger(window.endMinute) && window.endMinute >= 0 && window.endMinute < 1440 && window.startMinute !== window.endMinute);
}

function validRule(value: unknown): value is BillingPriceRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Partial<BillingPriceRule>;
  const from = typeof rule.effectiveFrom === "string" ? Date.parse(rule.effectiveFrom) : Number.NaN;
  const to = rule.effectiveTo === undefined ? Number.POSITIVE_INFINITY : typeof rule.effectiveTo === "string" ? Date.parse(rule.effectiveTo) : Number.NaN;
  return typeof rule.id === "string" && rule.id.length > 0 && typeof rule.provider === "string" && rule.provider.trim().length > 0
    && typeof rule.model === "string" && rule.model.trim().length > 0 && typeof rule.label === "string"
    && typeof rule.currency === "string" && /^[A-Z]{3}$/i.test(rule.currency)
    && ["official", "custom", "free"].includes(rule.mode ?? "") && Number.isFinite(from) && to > from
    && validRates(rule.rates) && (rule.peakRates === undefined || validRates(rule.peakRates))
    && (rule.peakScheduleId === undefined || typeof rule.peakScheduleId === "string");
}

const legacyMinute = (clock: string): number => {
  const match = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!match) throw new Error("旧版峰谷时间格式无效");
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("旧版峰谷时间超出范围");
  return hour * 60 + minute;
};

function migrateCatalog(value: unknown): unknown {
  if (!value || typeof value !== "object" || (value as { schemaVersion?: unknown }).schemaVersion !== 1) return value;
  const legacy = value as { publishedAt: string; source: string; rules: Array<Record<string, unknown>> };
  if (!Array.isArray(legacy.rules)) return value;
  const scheduleMap = new Map<string, BillingPeakSchedule>();
  const rules = legacy.rules.map((entry) => {
    const rule = { ...entry };
    const windows = rule.peakWindows;
    delete rule.peakWindows;
    if (Array.isArray(windows) && windows.length) {
      const normalized = windows.map((window) => {
        const item = window as { start: string; end: string };
        return { startMinute: legacyMinute(item.start), endMinute: legacyMinute(item.end) };
      });
      const signature = JSON.stringify(normalized);
      let schedule = scheduleMap.get(signature);
      if (!schedule) {
        schedule = { id: `legacy-asia-shanghai-${scheduleMap.size + 1}`, label: "迁移的峰谷时段", timezone: "Asia/Shanghai", windows: normalized };
        scheduleMap.set(signature, schedule);
      }
      rule.peakScheduleId = schedule.id;
    }
    return rule;
  });
  for (const rule of rules) {
    if (rule.effectiveTo || typeof rule.provider !== "string" || typeof rule.model !== "string" || typeof rule.effectiveFrom !== "string") continue;
    const start = Date.parse(rule.effectiveFrom);
    const next = rules.filter((candidate) => candidate.provider === rule.provider && candidate.model === rule.model && typeof candidate.effectiveFrom === "string" && Date.parse(candidate.effectiveFrom) > start)
      .sort((left, right) => Date.parse(left.effectiveFrom as string) - Date.parse(right.effectiveFrom as string))[0];
    if (next) rule.effectiveTo = next.effectiveFrom;
  }
  return { schemaVersion: 2, publishedAt: legacy.publishedAt, source: legacy.source, peakSchedules: [...scheduleMap.values()], rules };
}

export function validateCatalog(input: unknown): BillingCatalog {
  const value = migrateCatalog(input);
  if (!value || typeof value !== "object") throw new Error("价格清单格式无效");
  const catalog = value as Partial<BillingCatalog>;
  if (catalog.schemaVersion !== 2 || typeof catalog.publishedAt !== "string" || !Number.isFinite(Date.parse(catalog.publishedAt))
    || typeof catalog.source !== "string" || !Array.isArray(catalog.peakSchedules) || !catalog.peakSchedules.every(validSchedule)
    || !Array.isArray(catalog.rules) || !catalog.rules.every(validRule)) throw new Error("价格清单字段不完整或包含无效单价");
  if (new Set(catalog.rules.map((rule) => rule.id)).size !== catalog.rules.length) throw new Error("价格清单包含重复规则 ID");
  if (new Set(catalog.peakSchedules.map((schedule) => schedule.id)).size !== catalog.peakSchedules.length) throw new Error("价格清单包含重复峰谷计划 ID");
  const scheduleIds = new Set(catalog.peakSchedules.map((schedule) => schedule.id));
  if (catalog.rules.some((rule) => rule.peakScheduleId && !scheduleIds.has(rule.peakScheduleId))) throw new Error("价格规则引用了不存在的峰谷计划");
  if (catalog.rules.some((rule) => Boolean(rule.peakRates) !== Boolean(rule.peakScheduleId))) throw new Error("峰值单价和峰谷计划必须同时设置");
  return structuredClone(catalog as BillingCatalog);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function scheduleFor(catalog: BillingCatalog, rule: BillingPriceRule): BillingPeakSchedule | null {
  return catalog.peakSchedules.find((schedule) => schedule.id === rule.peakScheduleId) ?? null;
}

function economicSignature(catalog: BillingCatalog, rule: BillingPriceRule): string {
  const { label: _label, source: _source, peakScheduleId: _scheduleId, ...economicRule } = rule;
  return canonicalJson({ ...economicRule, peakSchedule: scheduleFor(catalog, rule) && { timezone: scheduleFor(catalog, rule)!.timezone, windows: scheduleFor(catalog, rule)!.windows } });
}

export function assertAppendOnlyCatalog(current: BillingCatalog, remote: BillingCatalog): void {
  const remoteById = new Map(remote.rules.map((rule) => [rule.id, rule]));
  for (const rule of current.rules) {
    const next = remoteById.get(rule.id);
    if (!next || economicSignature(remote, next) !== economicSignature(current, rule)) throw new Error(`价格更新试图删除或修改历史规则：${rule.id}`);
  }
}

const validCustomRule = (value: unknown): value is BillingPriceRule => validRule(value)
  && value.mode !== "official" && !value.peakRates && !value.peakScheduleId;

function validateCustomRules(value: unknown): BillingPriceRule[] {
  if (!Array.isArray(value) || !value.every(validCustomRule)) throw new Error("自定义价格规则无效");
  if (new Set(value.map((rule) => rule.id)).size !== value.length) throw new Error("自定义价格规则包含重复 ID");
  return structuredClone(value);
}

export class BillingStore {
  private builtinCatalog!: BillingCatalog;
  private readonly remoteUrls: string[];
  private readonly fetcher: typeof fetch;
  private publicKeyPem = "";

  constructor(private readonly settings: SettingsStore, private readonly resourcesPath: string, private readonly options: BillingStoreOptions = {}) {
    this.remoteUrls = options.remoteUrls ?? REMOTE_CATALOG_URLS;
    this.fetcher = options.fetcher ?? fetch;
  }

  async load(): Promise<void> {
    this.builtinCatalog = validateCatalog(JSON.parse(await readFile(path.join(this.resourcesPath, "pricing", "prices.json"), "utf8")));
    this.publicKeyPem = this.options.publicKeyPem ?? await readFile(path.join(this.resourcesPath, "pricing", "catalog-public-key.pem"), "utf8");
    const stored = this.settings.get().billing;
    if (!stored) await this.settings.patch({ billing: this.defaults() });
    else {
      try { await this.saveInternal(stored); }
      catch {
        const recovered = this.defaults();
        if (Array.isArray((stored as BillingSettings).customRules)) {
          const unique = new Map<string, BillingPriceRule>();
          for (const rule of (stored as BillingSettings).customRules) if (validCustomRule(rule) && !unique.has(rule.id)) unique.set(rule.id, structuredClone(rule));
          recovered.customRules = [...unique.values()];
        }
        await this.settings.patch({ billing: recovered });
      }
    }
  }

  get(): BillingSettings { return structuredClone(this.settings.get().billing ?? this.defaults()); }

  async saveUserSettings(next: BillingSettings): Promise<BillingSettings> {
    const current = this.get();
    return this.saveInternal({ ...next, catalog: current.catalog, lastCheckedAt: current.lastCheckedAt });
  }

  async checkForUpdates(): Promise<BillingUpdateResult> {
    const remote = await this.fetchVerifiedCatalog();
    const current = this.get();
    const updated = Date.parse(remote.publishedAt) > Date.parse(current.catalog.publishedAt);
    if (updated) assertAppendOnlyCatalog(current.catalog, remote);
    const checkedAt = new Date().toISOString();
    const settings = await this.saveInternal({ ...current, lastCheckedAt: checkedAt, catalog: updated ? remote : current.catalog });
    return { updated, checkedAt, settings, message: updated ? "已验证签名并更新价格清单" : "价格清单签名有效，当前已是最新版" };
  }

  shouldAutoCheck(): boolean {
    const value = this.get();
    if (!value.autoUpdate) return false;
    const last = value.lastCheckedAt ? Date.parse(value.lastCheckedAt) : 0;
    return !Number.isFinite(last) || Date.now() - last >= value.checkIntervalHours * 3_600_000;
  }

  private async fetchVerifiedCatalog(): Promise<BillingCatalog> {
    const failures: string[] = [];
    for (const url of this.remoteUrls) {
      try {
        const response = await this.fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) throw new Error("响应过大");
        const envelope = JSON.parse(text) as Partial<SignedCatalogEnvelope>;
        if (envelope.algorithm !== "Ed25519" || typeof envelope.keyId !== "string" || typeof envelope.signature !== "string" || !envelope.catalog) throw new Error("签名清单格式无效");
        const signature = Buffer.from(envelope.signature, "base64");
        if (!signature.length || !verify(null, Buffer.from(canonicalJson(envelope.catalog)), this.publicKeyPem, signature)) throw new Error("价格清单签名验证失败");
        return validateCatalog(envelope.catalog);
      } catch (error) { failures.push(`${new URL(url).hostname}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    throw new Error(`无法获取可信价格清单；已继续使用本地价格。${failures.join("；")}`);
  }

  private async saveInternal(next: BillingSettings): Promise<BillingSettings> {
    const catalog = validateCatalog(next.catalog);
    const customRules = validateCustomRules(next.customRules);
    if (!Number.isInteger(next.checkIntervalHours) || next.checkIntervalHours < 1 || next.checkIntervalHours > 720) throw new Error("检查间隔应为 1–720 小时");
    if (next.lastCheckedAt !== null && (typeof next.lastCheckedAt !== "string" || !Number.isFinite(Date.parse(next.lastCheckedAt)))) throw new Error("价格检查时间无效");
    const value: BillingSettings = { autoUpdate: Boolean(next.autoUpdate), checkIntervalHours: next.checkIntervalHours, lastCheckedAt: next.lastCheckedAt, catalog, customRules };
    await this.settings.patch({ billing: value });
    return this.get();
  }

  private defaults(): BillingSettings { return { autoUpdate: true, checkIntervalHours: 24, lastCheckedAt: null, catalog: structuredClone(this.builtinCatalog), customRules: [] }; }
}
