import { describe, expect, it, vi } from "vitest";

import { fetchDexScreenerMarkets } from "./dexscreener.js";

describe("fetchDexScreenerMarkets", () => {
  it("prices multiple Base tokens with one batch request", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([
        {
          chainId: "base",
          baseToken: { address: "0xAAA", symbol: "AAA", name: "Token A" },
          priceUsd: "1.25",
          liquidity: { usd: 10_000 },
        },
        {
          chainId: "base",
          baseToken: { address: "0xBBB", symbol: "BBB", name: "Token B" },
          priceUsd: "0.5",
          liquidity: { usd: 20_000 },
        },
      ]), { status: 200 }),
    );

    const markets = await fetchDexScreenerMarkets(["0xAAA", "0xBBB"], { fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toContain("/tokens/v1/base/0xaaa,0xbbb");
    expect(markets.get("0xaaa")?.priceUsd).toBe(1.25);
    expect(markets.get("0xbbb")?.priceUsd).toBe(0.5);
  });

  it("retries a rate-limited batch", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));

    await fetchDexScreenerMarkets(["0xAAA"], { fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
