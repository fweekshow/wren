import { afterEach, describe, expect, it } from "vitest";

import {
  B20_STOCK_DECIMALS,
  formatLaunchableSymbols,
  listLaunchableOffers,
  listSpotBuyableOffers,
} from "./stockCatalog.js";
import {
  assertStockNumeraireDecimals,
  isLaunchableStock,
  listLaunchableStockTokens,
  listStockTokens,
  normalizeStockSymbol,
  resetStockTokenCache,
  resolveStockToken,
} from "./stockRegistry.js";

describe("stockCatalog + registry", () => {
  afterEach(() => {
    delete process.env.STOCK_TOKENS_JSON;
    resetStockTokenCache();
  });

  it("resolves aliases to the c-suffix ticker", () => {
    expect(normalizeStockSymbol("AAPL")).toBe("AAPLc");
    expect(normalizeStockSymbol("apple")).toBe("AAPLc");
    expect(normalizeStockSymbol("$AAPLc")).toBe("AAPLc");
    expect(normalizeStockSymbol("NVIDIA")).toBe("NVDAc");
    expect(normalizeStockSymbol("MU")).toBe("MUc");
    expect(normalizeStockSymbol("micron")).toBe("MUc");
    expect(normalizeStockSymbol("PLTR")).toBe("PLTRc");
    expect(normalizeStockSymbol("Palantir")).toBe("PLTRc");
    expect(normalizeStockSymbol("roblox")).toBe("RBLXc");
    expect(normalizeStockSymbol("Eli Lilly")).toBe("LLYc");
    expect(normalizeStockSymbol("sk hynix")).toBe("SKHYc");
    expect(normalizeStockSymbol("paypal")).toBe("PYPLc");
    expect(resolveStockToken("LLY")?.address.toLowerCase()).toBe(
      "0xb200000000000000000000f1a0f91e34892e4718",
    );
    expect(resolveStockToken("AAPL")?.symbol).toBe("AAPLc");
    expect(resolveStockToken("Apple")?.symbol).toBe("AAPLc");
    expect(resolveStockToken("NVDAc")?.address.toLowerCase()).toBe(
      "0xb20000000000000000000078ee7ce2fe4908108c",
    );
    expect(resolveStockToken("MU")?.address.toLowerCase()).toBe(
      "0xb200000000000000000000fd2f87532b90095211",
    );
    expect(resolveStockToken("PLTR")?.address.toLowerCase()).toBe(
      "0xb2000000000000000000007d16372840df4dabbe",
    );
    expect(resolveStockToken("RBLX")?.feedAddress).toBeNull();
    // Still listed (resolves), but its book is too thin to offer.
    expect(resolveStockToken("Roblox")?.spotBuyable).toBe(false);
    expect(resolveStockToken("Uber")?.symbol).toBe("UBERc");
    expect(resolveStockToken("BRK.B")?.symbol).toBe("BRK.Bc");
    expect(resolveStockToken("Anthropic")?.spotBuyable).toBe(true);
  });

  it("rejects unknown tickers", () => {
    expect(resolveStockToken("NOTREAL")).toBeNull();
  });

  it("lists the Coinbase B20 tokens with launchable from the catalog", () => {
    expect(listStockTokens()).toHaveLength(52);
    expect(listLaunchableStockTokens().map((t) => t.symbol).sort()).toEqual([
      "AAPLc",
      "GOOGLc",
      "METAc",
      "NVDAc",
    ]);
    expect(listLaunchableOffers().map((t) => t.symbol).sort()).toEqual([
      "AAPLc",
      "GOOGLc",
      "METAc",
      "NVDAc",
    ]);
    expect(isLaunchableStock("TSLAc")).toBe(false);
    expect(isLaunchableStock("PLTRc")).toBe(false);
    expect(isLaunchableStock("NVDAc")).toBe(true);
    expect(formatLaunchableSymbols()).toContain("NVDAc");
    expect(listSpotBuyableOffers().map((t) => t.symbol).sort()).toEqual([
      "AAOIc",
      "AAPLc",
      "ADBEc",
      "AMDc",
      "AMZNc",
      "ANTc",
      "AVGOc",
      "BEc",
      "BRK.Bc",
      "CRCLc",
      "CRWVc",
      "GMEc",
      "GOOGLc",
      "HIMSc",
      "HOODc",
      "INTCc",
      "KOc",
      "LITEc",
      "LLYc",
      "MCDc",
      "METAc",
      "MRNAc",
      "MRVLc",
      "MSFTc",
      "MSTRc",
      "MUc",
      "NFLXc",
      "NOWc",
      "NVDAc",
      "ORCLc",
      "PLTRc",
      "SKHYc",
      "SNDKc",
      "SNOWc",
      "SPCXc",
      "TSLAc",
      "TTWOc",
      "UBERc",
      "WDCc",
    ]);
    expect(listStockTokens().every((t) => t.decimals === B20_STOCK_DECIMALS)).toBe(true);
  });

  it("rejects catalog/on-chain decimal mismatches so launches cannot silently mis-scale", () => {
    expect(
      assertStockNumeraireDecimals({
        symbol: "METAc",
        catalogDecimals: 8,
        onChainDecimals: 8,
      }),
    ).toBe(8);
    expect(() =>
      assertStockNumeraireDecimals({
        symbol: "METAc",
        catalogDecimals: 18,
        onChainDecimals: 8,
      }),
    ).toThrow(/mis-scaled curve/);
    expect(() =>
      assertStockNumeraireDecimals({
        symbol: "METAc",
        catalogDecimals: 8,
        onChainDecimals: 4,
      }),
    ).toThrow(/B20 range/);
  });

  it("lets STOCK_TOKENS_JSON override a built-in by symbol", () => {
    process.env.STOCK_TOKENS_JSON = JSON.stringify([
      {
        symbol: "AAPLc",
        address: "0xB200000000000000000000000000000000000001",
        decimals: 8,
        feedAddress: "0x1111111111111111111111111111111111111111",
        name: "Override Apple",
        launchable: false,
      },
    ]);
    resetStockTokenCache();
    expect(resolveStockToken("AAPL")?.address.toLowerCase()).toBe(
      "0xb200000000000000000000000000000000000001",
    );
    expect(resolveStockToken("AAPL")?.name).toBe("Override Apple");
    expect(resolveStockToken("AAPL")?.launchable).toBe(false);
    expect(resolveStockToken("AAPL")?.decimals).toBe(8);
  });

  it("skips STOCK_TOKENS_JSON entries that omit decimals instead of assuming 18", () => {
    process.env.STOCK_TOKENS_JSON = JSON.stringify([
      {
        symbol: "AAPLc",
        address: "0xB200000000000000000000000000000000000001",
        feedAddress: "0x1111111111111111111111111111111111111111",
        name: "No Decimals",
      },
    ]);
    resetStockTokenCache();
    expect(resolveStockToken("AAPL")?.address.toLowerCase()).toBe(
      "0xb200000000000000000000c2e324d24d7eecd1fb",
    );
    expect(resolveStockToken("AAPL")?.decimals).toBe(B20_STOCK_DECIMALS);
  });

  it("skips invalid env entries", () => {
    process.env.STOCK_TOKENS_JSON = JSON.stringify([
      { symbol: "FAKE", address: "not-an-address", decimals: 8 },
    ]);
    resetStockTokenCache();
    expect(resolveStockToken("FAKE")).toBeNull();
    expect(resolveStockToken("NVDAc")?.symbol).toBe("NVDAc");
  });
});
