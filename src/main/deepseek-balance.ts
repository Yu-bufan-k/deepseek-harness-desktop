import type { DeepSeekBalanceSnapshot } from "../shared/contracts.js";
import { createHash } from "node:crypto";
import { formatDecimalBillingMoney } from "../shared/billing.js";

const ENDPOINT = "https://api.deepseek.com/user/balance";
const MAX_RESPONSE_BYTES = 64_000;
const CACHE_MS = 5 * 60_000;
const DECIMAL = /^\d+(?:\.\d+)?$/;

interface BalanceServiceOptions {
  credential: () => Promise<string | null>;
  fetcher?: typeof fetch;
  now?: () => number;
}

export class DeepSeekBalanceService {
  private snapshot: DeepSeekBalanceSnapshot = { configured: false, isAvailable: null, balances: [], checkedAt: null, stale: false, errorSummary: null };
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private credentialFingerprint = "";

  constructor(private readonly options: BalanceServiceOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async get(force = false): Promise<DeepSeekBalanceSnapshot> {
    const key = await this.options.credential();
    if (!key) {
      this.credentialFingerprint = "";
      this.snapshot = { configured: false, isAvailable: null, balances: [], checkedAt: null, stale: false, errorSummary: null };
      return structuredClone(this.snapshot);
    }
    const fingerprint = createHash("sha256").update(key).digest("base64url");
    if (fingerprint !== this.credentialFingerprint) {
      this.credentialFingerprint = fingerprint;
      this.snapshot = { configured: true, isAvailable: null, balances: [], checkedAt: null, stale: false, errorSummary: null };
    }
    const checked = this.snapshot.checkedAt ? Date.parse(this.snapshot.checkedAt) : 0;
    if (!force && checked && this.now() - checked < CACHE_MS) return structuredClone(this.snapshot);
    try {
      const response = await this.fetcher(ENDPOINT, { headers: { accept: "application/json", authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(response.status === 401 ? "DeepSeek API Key 无效或已失效" : `DeepSeek 余额接口返回 HTTP ${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("DeepSeek 余额响应过大");
      const value = JSON.parse(text) as { is_available?: unknown; balance_infos?: unknown };
      if (typeof value.is_available !== "boolean" || !Array.isArray(value.balance_infos)) throw new Error("DeepSeek 余额响应格式无效");
      const balances = value.balance_infos.map((entry) => {
        if (!entry || typeof entry !== "object") throw new Error("DeepSeek 余额响应格式无效");
        const item = entry as Record<string, unknown>;
        if ((item.currency !== "CNY" && item.currency !== "USD") || ![item.total_balance, item.granted_balance, item.topped_up_balance].every((amount) => typeof amount === "string" && DECIMAL.test(amount))) throw new Error("DeepSeek 余额响应格式无效");
        const currency = item.currency as "CNY" | "USD";
        const totalBalance = item.total_balance as string, grantedBalance = item.granted_balance as string, toppedUpBalance = item.topped_up_balance as string;
        return {
          currency, totalBalance, grantedBalance, toppedUpBalance,
          totalDisplay: formatDecimalBillingMoney(currency, totalBalance),
          grantedDisplay: formatDecimalBillingMoney(currency, grantedBalance),
          toppedUpDisplay: formatDecimalBillingMoney(currency, toppedUpBalance),
          warning: false, warningThreshold: null, warningThresholdDisplay: null
        };
      });
      this.snapshot = { configured: true, isAvailable: value.is_available, balances, checkedAt: new Date(this.now()).toISOString(), stale: false, errorSummary: null };
    } catch (error) {
      this.snapshot = { ...this.snapshot, configured: true, stale: Boolean(this.snapshot.checkedAt), errorSummary: error instanceof Error ? error.message : String(error) };
    }
    return structuredClone(this.snapshot);
  }

  /** Credential changes must never retain another account's balance. */
  invalidate(): void { this.credentialFingerprint = ""; this.snapshot = { configured: false, isAvailable: null, balances: [], checkedAt: null, stale: false, errorSummary: null }; }
}
