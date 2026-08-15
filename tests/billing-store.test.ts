import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BillingCatalog, BillingSettings } from "../src/shared/billing.js";
import {
  assertAppendOnlyCatalog,
  BillingStore,
  canonicalJson,
  validateCatalog,
} from "../src/main/billing-store.js";
import { SettingsStore } from "../src/main/settings-store.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const rates = { input: 1, cacheRead: 0.02, cacheWrite: 0.4, output: 2 };
const catalog = (publishedAt = "2026-08-14T00:00:00Z"): BillingCatalog => ({
  schemaVersion: 2,
  publishedAt,
  source: "test",
  peakSchedules: [],
  rules: [
    {
      id: "v1",
      provider: "p",
      model: "m",
      label: "M",
      currency: "CNY",
      mode: "official",
      effectiveFrom: "2026-01-01T00:00:00Z",
      rates,
    },
  ],
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-billing-store-"));
  roots.push(root);
  await mkdir(path.join(root, "pricing"));
  await writeFile(
    path.join(root, "pricing", "prices.json"),
    JSON.stringify(catalog()),
  );
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const settings = new SettingsStore(path.join(root, "user"));
  await settings.load();
  return { root, keys, publicKeyPem, settings };
}

const envelope = (
  value: BillingCatalog,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
) => ({
  algorithm: "Ed25519",
  keyId: "test",
  catalog: value,
  signature: sign(null, Buffer.from(canonicalJson(value)), privateKey).toString(
    "base64",
  ),
});

describe("BillingStore", () => {
  it("migrates schema v1 peak windows into a shared timezone schedule", () => {
    const migrated = validateCatalog({
      schemaVersion: 1,
      publishedAt: "2026-01-01T00:00:00Z",
      source: "legacy",
      rules: [
        {
          ...catalog().rules[0],
          peakRates: rates,
          peakWindows: [{ start: "22:00", end: "02:00" }],
        },
        {
          ...catalog().rules[0],
          id: "v2",
          effectiveFrom: "2027-01-01T00:00:00Z",
          peakRates: rates,
          peakWindows: [{ start: "22:00", end: "02:00" }],
        },
      ],
    });
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.peakSchedules).toHaveLength(1);
    expect(migrated.rules[0]?.peakScheduleId).toBe(
      migrated.rules[1]?.peakScheduleId,
    );
    expect(migrated.peakSchedules[0]?.timezone).toBe("Asia/Shanghai");
    expect(migrated.rules[0]?.effectiveTo).toBe("2027-01-01T00:00:00Z");
  });

  it("rejects ambiguous zero-length peak windows", () => {
    expect(() =>
      validateCatalog({
        ...catalog(),
        peakSchedules: [
          {
            id: "bad",
            label: "Bad",
            timezone: "Asia/Shanghai",
            windows: [{ startMinute: 60, endMinute: 60 }],
          },
        ],
      }),
    ).toThrow(/价格清单/);
  });

  it("rejects deleting or changing historical economics, but permits labels", () => {
    const current = catalog();
    expect(() =>
      assertAppendOnlyCatalog(current, {
        ...catalog("2026-08-15T00:00:00Z"),
        rules: [],
      }),
    ).toThrow(/删除或修改/);
    expect(() =>
      assertAppendOnlyCatalog(current, {
        ...catalog("2026-08-15T00:00:00Z"),
        rules: [{ ...current.rules[0]!, rates: { ...rates, output: 99 } }],
      }),
    ).toThrow(/删除或修改/);
    expect(() =>
      assertAppendOnlyCatalog(current, {
        ...catalog("2026-08-15T00:00:00Z"),
        rules: [{ ...current.rules[0]!, label: "Renamed" }],
      }),
    ).not.toThrow();
  });

  it("treats an inferred successor boundary and the same explicit effectiveTo as identical economics", () => {
    const current = catalog();
    current.rules.push({
      ...current.rules[0]!,
      id: "v2",
      effectiveFrom: "2026-08-17T00:00:00Z",
    });
    const remote = structuredClone(current);
    remote.rules[0]!.effectiveTo = "2026-08-17T00:00:00Z";
    expect(() => assertAppendOnlyCatalog(current, remote)).not.toThrow();
  });

  it("does not let renderer settings replace the official catalog", async () => {
    const { root, settings, publicKeyPem } = await fixture();
    const store = new BillingStore(settings, root, { publicKeyPem });
    await store.load();
    const before = store.get();
    const malicious = {
      ...before,
      lastCheckedAt: "2099-01-01T00:00:00Z",
      catalog: {
        ...before.catalog,
        rules: [
          { ...before.catalog.rules[0]!, rates: { ...rates, output: 999 } },
        ],
      },
    };
    const saved = await store.saveUserSettings(malicious);
    expect(saved.catalog).toEqual(before.catalog);
    expect(saved.lastCheckedAt).toBe(before.lastCheckedAt);
  });

  it("normalizes provider bindings and rejects duplicate routes", async () => {
    const { root, settings, publicKeyPem } = await fixture();
    const store = new BillingStore(settings, root, { publicKeyPem });
    await store.load();
    const saved = await store.saveUserSettings({
      ...store.get(),
      providerBindings: [
        { provider: " custom-route ", catalogProvider: " deepseek-official " },
      ],
    });
    expect(saved.providerBindings).toEqual([
      { provider: "custom-route", catalogProvider: "deepseek-official" },
    ]);
    await expect(
      store.saveUserSettings({
        ...saved,
        providerBindings: [
          ...saved.providerBindings,
          { provider: "CUSTOM-ROUTE", catalogProvider: "other" },
        ],
      }),
    ).rejects.toThrow(/重复路由/);
  });

  it("migrates and validates balance warning settings", async () => {
    const { root, settings, publicKeyPem } = await fixture();
    const store = new BillingStore(settings, root, { publicKeyPem });
    await store.load();
    expect(store.get().balanceWarning).toEqual({
      enabled: false,
      thresholds: { CNY: "10", USD: "2" },
    });
    const saved = await store.saveUserSettings({
      ...store.get(),
      balanceWarning: { enabled: true, thresholds: { CNY: "5.5", USD: "1" } },
    });
    expect(saved.balanceWarning.enabled).toBe(true);
    await expect(
      store.saveUserSettings({
        ...saved,
        balanceWarning: { enabled: true, thresholds: { CNY: "-1", USD: "1" } },
      }),
    ).rejects.toThrow(/CNY/);
  });

  it("uses a signed fallback source and preserves append-only history", async () => {
    const { root, settings, keys, publicKeyPem } = await fixture();
    const next = catalog("2026-08-15T00:00:00Z");
    next.rules.push({
      ...next.rules[0]!,
      id: "v2",
      effectiveFrom: "2026-09-01T00:00:00Z",
      rates: { ...rates, output: 3 },
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            encoding: "base64",
            content: Buffer.from(
              JSON.stringify(envelope(next, keys.privateKey)),
            ).toString("base64"),
          }),
          { status: 200 },
        ),
      );
    const store = new BillingStore(settings, root, {
      publicKeyPem,
      remoteUrls: [
        "https://primary.test/catalog",
        "https://fallback.test/catalog",
      ],
      fetcher,
    });
    await store.load();
    const result = await store.checkForUpdates();
    expect(result.updated).toBe(true);
    expect(result.settings.catalog.rules).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid signature and keeps the local catalog", async () => {
    const { root, settings, publicKeyPem } = await fixture();
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          algorithm: "Ed25519",
          keyId: "bad",
          catalog: catalog("2027-01-01T00:00:00Z"),
          signature: Buffer.alloc(64).toString("base64"),
        }),
        { status: 200 },
      ),
    );
    const store = new BillingStore(settings, root, {
      publicKeyPem,
      remoteUrls: ["https://bad.test/catalog"],
      fetcher,
    });
    await store.load();
    const result = await store.checkForUpdates();
    expect(result.updated).toBe(false);
    expect(result.message).toMatch(/内置签名价格仍可正常计费/);
    expect(store.get().catalog.publishedAt).toBe(catalog().publishedAt);
  });

  it("returns a safe fallback result instead of throwing when a signed update rewrites history", async () => {
    const { root, settings, keys, publicKeyPem } = await fixture();
    const changed = catalog("2026-08-15T00:00:00Z");
    changed.rules[0]!.rates.output = 99;
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(envelope(changed, keys.privateKey)), {
        status: 200,
      }),
    );
    const store = new BillingStore(settings, root, {
      publicKeyPem,
      remoteUrls: ["https://signed.test/catalog"],
      fetcher,
    });
    await store.load();
    const result = await store.checkForUpdates();
    expect(result.updated).toBe(false);
    expect(result.errorSummary).toMatch(/删除或修改历史规则/);
    expect(store.get().catalog.rules[0]!.rates.output).toBe(2);
  });

  it("recovers defaults while retaining only valid custom rules", async () => {
    const { root, settings, publicKeyPem } = await fixture();
    const validCustom = {
      ...catalog().rules[0]!,
      id: "custom",
      mode: "custom" as const,
    };
    await settings.patch({
      billing: {
        autoUpdate: true,
        checkIntervalHours: 24,
        lastCheckedAt: null,
        catalog: { broken: true },
        customRules: [validCustom, { broken: true }],
      } as unknown as BillingSettings,
    });
    const store = new BillingStore(settings, root, { publicKeyPem });
    await store.load();
    expect(store.get().catalog).toEqual(catalog());
    expect(store.get().customRules).toEqual([validCustom]);
  });

  it("respects automatic check throttling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    const { root, settings, publicKeyPem } = await fixture();
    const store = new BillingStore(settings, root, { publicKeyPem });
    await store.load();
    expect(store.shouldAutoCheck()).toBe(true);
    await settings.patch({
      billing: { ...store.get(), lastCheckedAt: "2026-08-14T23:30:00Z" },
    });
    expect(store.shouldAutoCheck()).toBe(false);
  });
});
