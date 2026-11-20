import { describe, expect, it } from "vitest";

import { resolveAlertToken } from "./tokenResolver.js";

type Route = [string, unknown];

function makeFetch(routes: Route[]): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    for (const [frag, data] of routes) {
      if (u.includes(frag)) {
        return { ok: true, json: async () => data } as Response;
      }
    }
    return { ok: false, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
}

describe("resolveAlertToken", () => {
  it("routes mainstream symbols to CoinGecko", async () => {
    const fetchFn = makeFetch([
      ["simple/price", { ethereum: { usd: 1842.5, usd_market_cap: 2.2e11 } }],
    ]);
    const res = await resolveAlertToken("ETH", null, { fetchFn });
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.token.source).toBe("coingecko");
    expect(res.token.tokenId).toBe("ethereum");
    expect(res.quote.priceUsd).toBe(1842.5);
    expect(res.quote.marketCapUsd).toBe(2.2e11);
  });

  it("routes a mainstream full name (Bitcoin) to CoinGecko, not DexScreener", async () => {
    let dexHit = false;
    const fetchFn = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("dex/search") || u.includes("dex/tokens/")) {
        dexHit = true;
        return { ok: true, json: async () => ({ pairs: [] }) } as Response;
      }
      if (u.includes("simple/price")) {
        return {
          ok: true,
          json: async () => ({ bitcoin: { usd: 67000, usd_market_cap: 1.3e12 } }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const res = await resolveAlertToken("Bitcoin", null, { fetchFn });
    expect(dexHit).toBe(false);
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.token.source).toBe("coingecko");
    expect(res.token.tokenId).toBe("bitcoin");
    expect(res.token.symbol).toBe("BTC");
    expect(res.quote.priceUsd).toBe(67000);
  });

  it("matches multi-word mainstream names (bitcoin cash) to CoinGecko", async () => {
    const fetchFn = makeFetch([
      ["simple/price", { "bitcoin-cash": { usd: 480, usd_market_cap: 9.4e9 } }],
    ]);
    const res = await resolveAlertToken("bitcoin cash", null, { fetchFn });
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.token.tokenId).toBe("bitcoin-cash");
    expect(res.token.symbol).toBe("BCH");
  });

  it("routes long-tail symbols to DexScreener and resolves a single match", async () => {
    const fetchFn = makeFetch([
      [
        "dex/search",
        {
          pairs: [
            {
              chainId: "base",
              baseToken: { address: "0xabc", symbol: "BASEMATE", name: "Basemate" },
              liquidity: { usd: 50000 },
              priceUsd: "0.5",
              marketCap: 1_000_000,
            },
          ],
        },
      ],
      [
        "dex/tokens/",
        {
          pairs: [
            {
              chainId: "base",
              baseToken: { address: "0xabc", symbol: "BASEMATE", name: "Basemate" },
              liquidity: { usd: 50000 },
              priceUsd: "0.5",
              marketCap: 950_000,
            },
          ],
        },
      ],
    ]);
    const res = await resolveAlertToken("BASEMATE", null, { fetchFn });
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.token.source).toBe("dexscreener");
    expect(res.token.tokenAddress).toBe("0xabc");
    expect(res.quote.priceUsd).toBe(0.5);
    expect(res.quote.marketCapUsd).toBe(950_000);
  });

  it("flags ambiguity when a symbol maps to multiple contracts", async () => {
    const fetchFn = makeFetch([
      [
        "dex/search",
        {
          pairs: [
            {
              chainId: "base",
              baseToken: { address: "0xaaa", symbol: "BASEMATE", name: "Basemate One" },
              liquidity: { usd: 50000 },
              priceUsd: "0.5",
            },
            {
              chainId: "base",
              baseToken: { address: "0xbbb", symbol: "BASEMATE", name: "Basemate Two" },
              liquidity: { usd: 10000 },
              priceUsd: "0.4",
            },
          ],
        },
      ],
    ]);
    const res = await resolveAlertToken("BASEMATE", null, { fetchFn });
    expect(res.kind).toBe("ambiguous");
    if (res.kind !== "ambiguous") return;
    expect(res.candidates).toHaveLength(2);
  });

  it("resolves a contract address directly via DexScreener", async () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    const fetchFn = makeFetch([
      [
        "dex/tokens/",
        {
          pairs: [
            {
              chainId: "base",
              baseToken: { address: addr, symbol: "WIDGET", name: "Widget" },
              liquidity: { usd: 12345 },
              priceUsd: "1.23",
              marketCap: 4_560_000,
            },
          ],
        },
      ],
    ]);
    const res = await resolveAlertToken(addr, addr, { fetchFn });
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.token.tokenAddress).toBe(addr);
    expect(res.quote.priceUsd).toBe(1.23);
  });

  it("returns not_found when nothing matches", async () => {
    const fetchFn = makeFetch([["dex/search", { pairs: [] }]]);
    const res = await resolveAlertToken("NOPECOIN", null, { fetchFn });
    expect(res.kind).toBe("not_found");
  });
});
