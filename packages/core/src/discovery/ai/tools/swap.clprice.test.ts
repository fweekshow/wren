import { describe, expect, it } from "vitest";

import { priceUsdFromSqrtPriceX96 } from "@/discovery/ai/tools/swap.js";

/** sqrtPriceX96 for raw token1-per-token0 ratio `r`. */
function sqrtX96(r: number): bigint {
  return BigInt(Math.round(Math.sqrt(r) * 2 ** 96));
}

describe("priceUsdFromSqrtPriceX96", () => {
  it("prices an 8-decimal stock that sorts after USDC (USDC is token0)", () => {
    // $66.80 per share: 1e8 raw stock per 66.8e6 raw USDC → token1/token0 = 1e8 / 66.8e6
    const p = priceUsdFromSqrtPriceX96({
      sqrtPriceX96: sqrtX96(1e8 / 66.8e6),
      tokenIsToken0: false,
      tokenDecimals: 8,
    });
    expect(p).toBeCloseTo(66.8, 4);
  });

  it("prices a token that sorts before USDC (token is token0)", () => {
    // $2.50 per 18-decimal token: token1/token0 = 2.5e6 / 1e18
    const p = priceUsdFromSqrtPriceX96({
      sqrtPriceX96: sqrtX96(2.5e6 / 1e18),
      tokenIsToken0: true,
      tokenDecimals: 18,
    });
    expect(p).toBeCloseTo(2.5, 4);
  });

  it("returns 0 for an empty pool", () => {
    expect(priceUsdFromSqrtPriceX96({ sqrtPriceX96: 0n, tokenIsToken0: false, tokenDecimals: 8 })).toBe(0);
  });
});
