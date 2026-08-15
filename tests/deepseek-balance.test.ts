import { describe, expect, it, vi } from "vitest";
import { DeepSeekBalanceService } from "../src/main/deepseek-balance.js";

describe("DeepSeekBalanceService", () => {
  it("does not call the network without an official API key", async () => {
    const fetcher = vi.fn();
    const service = new DeepSeekBalanceService({ credential: async () => null, fetcher });
    expect(await service.get()).toMatchObject({ configured: false, balances: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates and caches official balance fields", async () => {
    let now = Date.parse("2026-08-15T00:00:00Z");
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }] }), { status: 200 }));
    const service = new DeepSeekBalanceService({ credential: async () => "secret", fetcher, now: () => now });
    expect(await service.get()).toMatchObject({ configured: true, isAvailable: true, balances: [{ totalBalance: "110.00", grantedBalance: "10.00", toppedUpBalance: "100.00", totalDisplay: "¥110.00", warning: false }] });
    now += 60_000;
    await service.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.deepseek.com/user/balance");
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ authorization: "Bearer secret" });
  });

  it("keeps the last successful balance when refresh fails", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "2.50", granted_balance: "0.50", topped_up_balance: "2.00" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    const service = new DeepSeekBalanceService({ credential: async () => "secret", fetcher });
    await service.get(true);
    expect(await service.get(true)).toMatchObject({ stale: true, errorSummary: "DeepSeek API Key 无效或已失效", balances: [{ totalBalance: "2.50" }] });
  });
});
