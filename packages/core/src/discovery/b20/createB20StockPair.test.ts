import { describe, expect, it } from "vitest";
import { getAddress, keccak256, toBytes } from "viem";

import {
  B20_ASSET_CREATE_PARAMS_VERSION,
  B20_FACTORY,
  MINT_ROLE,
  PERMIT2,
  V4_POOL_MANAGER,
  V4_POSITION_MANAGER,
} from "./addresses.js";
import {
  buildB20StockPairCalls,
  buildInitCalls,
  cleanTicker,
  encodeAssetCreateParams,
  sortCurrencies,
} from "./createB20StockPair.js";
import {
  encodeSqrtRatioX96,
  pickSingleSidedRange,
  snapTick,
  usdToTokenRaw,
} from "./math.js";

const USER = getAddress("0x1111111111111111111111111111111111111111");
const PREDICTED = getAddress("0xb20000000000000000000000000000000000aaaa");
const STOCK = getAddress("0xb20000000000000000000000000000000000bbbb");

describe("b20 create params", () => {
  it("encodes version-prefixed asset create params", () => {
    const encoded = encodeAssetCreateParams("Pizza Coin", "PIZZA", USER, 18);
    expect(encoded.startsWith("0x")).toBe(true);
    expect(parseInt(encoded.slice(2, 66), 16)).toBe(B20_ASSET_CREATE_PARAMS_VERSION);
  });

  it("MINT_ROLE matches keccak256(MINT_ROLE)", () => {
    expect(MINT_ROLE).toBe(keccak256(toBytes("MINT_ROLE")));
  });

  it("initCalls include grant, cap, mint, and optional URI", () => {
    expect(buildInitCalls({ userAddress: USER, totalSupply: 1n }).length).toBe(3);
    expect(
      buildInitCalls({
        userAddress: USER,
        totalSupply: 1n,
        contractURI: "https://example.com/meta.json",
      }).length,
    ).toBe(4);
  });

  it("rejects short tickers", () => {
    expect(() => cleanTicker("$")).toThrow(/2–10/);
    expect(cleanTicker("$pizza")).toBe("PIZZA");
  });
});

describe("b20 pool math", () => {
  it("sorts currencies by address", () => {
    const [a, b] = sortCurrencies(STOCK, PREDICTED);
    expect(a.toLowerCase() < b.toLowerCase()).toBe(true);
  });

  it("puts new-token-as-token0 liquidity above current tick", () => {
    const range = pickSingleSidedRange({ newIsCurrency0: true, currentTick: 120 });
    expect(range.tickLower).toBe(snapTick(120));
    expect(range.tickUpper).toBeGreaterThan(range.tickLower);
  });

  it("puts new-token-as-token1 liquidity below current tick", () => {
    const range = pickSingleSidedRange({ newIsCurrency0: false, currentTick: 120 });
    expect(range.tickUpper).toBe(snapTick(120));
    expect(range.tickLower).toBeLessThan(range.tickUpper);
  });

  it("encodeSqrtRatioX96 is monotonic in amount1", () => {
    const low = encodeSqrtRatioX96(1n, 100n);
    const high = encodeSqrtRatioX96(10n, 100n);
    expect(high).toBeGreaterThan(low);
  });

  it("usdToTokenRaw converts mcap into stock raw units", () => {
    const raw18 = usdToTokenRaw(50_000, 200, 18);
    expect(raw18).toBe(250n * 10n ** 18n);
    const raw8 = usdToTokenRaw(50_000, 200, 8);
    expect(raw8).toBe(250n * 10n ** 8n);
  });
});

describe("b20 wallet_sendCalls batch", () => {
  it("builds a 5-call create/approve/permit2/init/lp batch", () => {
    const salt =
      "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
    const { calls, tickLower, tickUpper } = buildB20StockPairCalls({
      name: "Pizza Coin",
      symbol: "PIZZA",
      userAddress: USER,
      predictedToken: PREDICTED,
      pair: { symbol: "GOOGLC", address: STOCK, decimals: 8 },
      salt,
      totalSupply: 1_000_000_000n * 10n ** 18n,
      launchMcapUsd: 50_000,
      numerairePriceUsd: 180,
    });

    expect(calls).toHaveLength(5);
    expect(calls[0]?.to).toBe(B20_FACTORY);
    expect(calls[1]?.to).toBe(PREDICTED);
    expect(calls[2]?.to).toBe(PERMIT2);
    expect(calls[3]?.to).toBe(V4_POOL_MANAGER);
    expect(calls[4]?.to).toBe(V4_POSITION_MANAGER);
    expect(tickUpper).toBeGreaterThan(tickLower);
    expect(calls[0]?.metadata?.transactionType).toBe("b20_create");
  });
});
