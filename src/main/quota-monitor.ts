import type {
  QuotaPlan,
  QuotaSettings,
  QuotaSnapshot,
  QuotaWarning,
} from "../shared/quota.js";
import type { QuotaSource } from "./quota-source.js";

export function computeQuotaWarnings(
  plans: QuotaPlan[],
  threshold: number,
): QuotaWarning[] {
  const warnings: QuotaWarning[] = [];
  for (const plan of plans) {
    for (const window of plan.windows) {
      if (window.limit <= 0) continue;
      const ratio = window.remaining / window.limit;
      if (window.remaining <= 0) {
        warnings.push({
          provider: plan.provider,
          windowId: window.id,
          kind: "exhausted",
          remaining: window.remaining,
          limit: window.limit,
          threshold,
        });
      } else if (ratio <= threshold) {
        warnings.push({
          provider: plan.provider,
          windowId: window.id,
          kind: "near-limit",
          remaining: window.remaining,
          limit: window.limit,
          threshold,
        });
      }
    }
  }
  return warnings;
}

export interface QuotaMonitorOptions {
  sources: () => QuotaSource[];
  settings: () => QuotaSettings;
  broadcast: (snapshot: QuotaSnapshot) => void;
  now?: () => number;
}

export class QuotaMonitor {
  private snapshot: QuotaSnapshot = {
    fetchedAt: "",
    plans: [],
    warnings: [],
    errors: {},
    needsKey: [],
  };
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly options: QuotaMonitorOptions) {
    this.now = options.now ?? Date.now;
  }

  get(): QuotaSnapshot {
    return structuredClone(this.snapshot);
  }

  /** 轮询所有活跃源并广播；未启用时返回空快照。 */
  async refresh(force = false): Promise<QuotaSnapshot> {
    if (!this.options.settings().enabled) {
      this.snapshot = {
        fetchedAt: "",
        plans: [],
        warnings: [],
        errors: {},
        needsKey: [],
      };
      this.broadcast();
      return structuredClone(this.snapshot);
    }
    const plans: QuotaPlan[] = [];
    const errors: Record<string, string> = {};
    const needsKey: string[] = [];
    for (const source of this.options.sources()) {
      try {
        const plan = await source.poll(force);
        if (plan) plans.push(plan);
        else needsKey.push(source.provider);
      } catch (error) {
        errors[source.provider] =
          error instanceof Error ? error.message : String(error);
      }
    }
    this.snapshot = {
      fetchedAt: new Date(this.now()).toISOString(),
      plans,
      warnings: computeQuotaWarnings(
        plans,
        this.options.settings().warningThreshold,
      ),
      errors,
      needsKey,
    };
    this.broadcast();
    return structuredClone(this.snapshot);
  }

  /** 启动/重置定时轮询（用当前设置，自动清理旧定时器）。 */
  start(): void {
    this.stop();
    const minutes = this.options.settings().pollIntervalMinutes;
    this.timer = setInterval(() => void this.refresh(), minutes * 60_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 凭证变更后清空快照，避免广播上个账号的数据。 */
  invalidate(): void {
    this.snapshot = {
      fetchedAt: "",
      plans: [],
      warnings: [],
      errors: {},
      needsKey: [],
    };
  }

  private broadcast(): void {
    this.options.broadcast(structuredClone(this.snapshot));
  }
}
