import { describe, expect, it, vi } from "vitest";

import { decodeTokenAmount } from "./amounts.js";
import { retryPortfolioRpc } from "@/portfolio-reviews/balances.js";

describe("decodeTokenAmount", () => {
  it("corrects broken zero-decimal metadata for stable-like tokens", () => {
    const decoded = decodeTokenAmount(25_000_000_000_000_000n, 0, {
      symbol: "USDOR",
      name: "USDOR",
      priceUsd: 1,
      change24hPct: null,
      liquidityUsd: 100_000,
    });

    expect(decoded).toEqual({ amount: 25, decimals: 15 });
  });
});

describe("retryPortfolioRpc", () => {
  it("recovers from transient provider failures", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValue(42);

    await expect(retryPortfolioRpc(operation, 2, 0)).resolves.toBe(42);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("rejects instead of converting an exhausted provider failure into an empty balance", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("RPC unavailable"));

    await expect(retryPortfolioRpc(operation, 2, 0)).rejects.toThrow("RPC unavailable");
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
