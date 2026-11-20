import { describe, expect, it } from "vitest";

import {
  analyzeBaseContentTokenLink,
  type DexScreenerPair,
  extractAnalysisContractAddress,
  extractBaseContentUrl,
  extractStandaloneContractAddress,
  fetchContractAddressFromBaseContent,
  formatBaseContentTokenReport,
  selectBestDexScreenerPair,
} from "./baseContentToken.service.js";

const TOKEN = "0x940a319B75861014A220d9c6C144d108552B089B";
const OTHER_TOKEN = "0x1111111111111111111111111111111111111111";
const TOKEN_IMAGE = "https://cdn.dexscreener.com/token.png";

function htmlResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );
}

describe("extractBaseContentUrl", () => {
  it("returns only Base App content URLs", () => {
    expect(
      extractBaseContentUrl(
        `check https://base.app/content/abc123 and https://evil.example/content/abc`,
      ),
    ).toBe("https://base.app/content/abc123");
  });

  it("ignores other Base App paths", () => {
    expect(extractBaseContentUrl("https://base.app/profile/abc")).toBeNull();
  });
});

describe("extractStandaloneContractAddress", () => {
  it("accepts a bare Base contract address", () => {
    expect(extractStandaloneContractAddress(` ${TOKEN} `)).toBe(TOKEN);
  });

  it("ignores messages that are not just a contract address", () => {
    expect(extractStandaloneContractAddress(`rug check ${TOKEN}`)).toBeNull();
  });
});

describe("extractAnalysisContractAddress", () => {
  it("accepts a bare contract address", () => {
    expect(extractAnalysisContractAddress(` ${TOKEN} `)).toBe(TOKEN);
  });

  it("accepts an address with analysis intent", () => {
    expect(extractAnalysisContractAddress(`Analyze ${TOKEN}`)).toBe(TOKEN);
    expect(extractAnalysisContractAddress(`rug check ${TOKEN}`)).toBe(TOKEN);
    expect(extractAnalysisContractAddress(`is ${TOKEN} legit?`)).toBe(TOKEN);
  });

  it("ignores addresses inside Avantis wallet-position messages", () => {
    const wallet = "0x22209CFC1397832f32160239C902B10A624cAB1A";

    expect(
      extractAnalysisContractAddress(
        `i want to see avantis positions for the wallet ${wallet}`,
      ),
    ).toBeNull();
    expect(extractAnalysisContractAddress(`show avantis open trades for ${wallet}`)).toBeNull();
  });

  it("ignores addresses inside transactional messages", () => {
    expect(extractAnalysisContractAddress(`send 5 usdc to ${TOKEN}`)).toBeNull();
    expect(extractAnalysisContractAddress(`buy $10 of ${TOKEN}`)).toBeNull();
  });
});

describe("fetchContractAddressFromBaseContent", () => {
  it("finds contractAddress across streamed chunk boundaries", async () => {
    const fetchFn: typeof fetch = async () =>
      htmlResponse([
        "<html>contractAdd",
        `ress=${TOKEN.slice(0, 12)}`,
        `${TOKEN.slice(12)}</html>`,
      ]);

    await expect(
      fetchContractAddressFromBaseContent("https://base.app/content/example", {
        fetchFn,
        maxBytes: 1024,
      }),
    ).resolves.toBe(TOKEN);
  });

  it("rejects non Base App content origins", async () => {
    const fetchFn: typeof fetch = async () => htmlResponse([`contractAddress=${TOKEN}`]);

    await expect(
      fetchContractAddressFromBaseContent("https://example.com/content/example", { fetchFn }),
    ).resolves.toBeNull();
  });
});

describe("selectBestDexScreenerPair", () => {
  it("chooses the highest-liquidity Base pair containing the token", () => {
    const pairs: DexScreenerPair[] = [
      {
        chainId: "base",
        baseToken: { address: TOKEN, name: "Low", symbol: "LOW" },
        quoteToken: { address: OTHER_TOKEN, symbol: "USDC" },
        liquidity: { usd: 100 },
      },
      {
        chainId: "ethereum",
        baseToken: { address: TOKEN, name: "Wrong Chain", symbol: "BAD" },
        liquidity: { usd: 100_000 },
      },
      {
        chainId: "base",
        baseToken: { address: TOKEN, name: "DEUS Token", symbol: "DEUS" },
        quoteToken: { address: OTHER_TOKEN, symbol: "WETH" },
        liquidity: { usd: 50_000 },
      },
    ];

    expect(selectBestDexScreenerPair(TOKEN, pairs)?.baseToken?.symbol).toBe("DEUS");
  });
});

describe("formatBaseContentTokenReport", () => {
  it("formats a concise markdown token card with image, socials, range, and metrics", () => {
    const report = formatBaseContentTokenReport({
      address: TOKEN,
      pair: {
        chainId: "base",
        dexId: "uniswap",
        url: "https://dexscreener.com/base/pair",
        baseToken: { address: TOKEN, name: "DEUS Token", symbol: "DEUS" },
        quoteToken: { address: OTHER_TOKEN, symbol: "WETH" },
        priceUsd: "0.04632",
        liquidity: { usd: 22_900_000 },
        marketCap: 10_000_000,
        fdv: 12_000_000,
        volume: { h24: 1_250_000 },
        txns: { h24: { buys: 42, sells: 21 } },
        priceChange: { h1: 2, h6: -8, h24: 12 },
        pairCreatedAt: Date.now() - 25 * 60 * 60 * 1000,
        info: {
          imageUrl: TOKEN_IMAGE,
          websites: [{ url: "https://example.com" }],
          socials: [{ platform: "twitter", handle: "deus" }],
        },
      },
    });

    expect(report).not.toContain("<img");
    expect(report).toContain("**DEUS Token ($DEUS)**");
    expect(report).toContain("**Price:** **$0.04632**");
    expect(report).toContain("**24h:** **+12.00% up**");
    expect(report).toContain("**Support:** **~$0.04076**");
    expect(report).toContain("**Resistance:** **~$0.05188**");
    expect(report).toContain("**DexScreener:**\nhttps://dexscreener.com/base/pair");
    expect(report).toContain("twitter: deus");
    expect(report).toContain("**Liquidity:** **$22.90M**");
    expect(report).toContain("**Txns:** **63 (42B/21S)**");
    expect(report).not.toContain("Launcher:");
    expect(report).not.toContain("Note:");
  });

  it("reports missing DexScreener indexing without inventing metrics", () => {
    const report = formatBaseContentTokenReport({ address: TOKEN, pair: null });

    expect(report).toContain("**Base token found**");
    expect(report).toContain(TOKEN);
    expect(report).toContain("not indexed");
    expect(report).toContain("`n/a`");
  });
});

describe("analyzeBaseContentTokenLink", () => {
  it("returns handled token analysis with image metadata so downstream Bankr analysis stays suppressed", async () => {
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.startsWith("https://base.app/content/")) {
        return htmlResponse([`<html>contractAddress=${TOKEN}</html>`]);
      }

      return new Response(
        JSON.stringify([
          {
            chainId: "base",
            dexId: "uniswap",
            url: "https://dexscreener.com/base/pair",
            baseToken: { address: TOKEN, name: "DEUS Token", symbol: "DEUS" },
            quoteToken: { address: OTHER_TOKEN, symbol: "WETH" },
            priceUsd: "0.04632",
            liquidity: { usd: 22_900_000 },
            priceChange: { h24: 12 },
            info: { imageUrl: TOKEN_IMAGE },
          },
        ]),
        { status: 200 },
      );
    };

    const result = await analyzeBaseContentTokenLink("rug check https://base.app/content/example", {
      fetchFn,
    });

    expect(result.handled).toBe(true);
    if (!result.handled) throw new Error("expected handled Base content token");
    expect(result.address).toBe(TOKEN);
    expect(result.tokenSymbol).toBe("DEUS");
    expect(result.imageUrl).toBe(TOKEN_IMAGE);
    expect(result.report).toContain("**DEUS Token ($DEUS)**");
  });
});
