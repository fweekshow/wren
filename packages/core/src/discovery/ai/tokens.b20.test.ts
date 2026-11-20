import { describe, expect, it } from "vitest";

import { isB20StockAddress, resolveToken, resolveTokenAsync } from "./tokens.js";

const AAPLC = "0xb200000000000000000000C2e324d24d7eEcd1fb";

describe("B20 stock resolve", () => {
  it("maps Apple / AAPL / AAPLc to 8-decimal AAPLc", async () => {
    for (const raw of ["Apple", "AAPL", "AAPLc", "apple"]) {
      const token = await resolveTokenAsync(raw);
      expect(token.resolved).toBe(true);
      expect(token.symbol).toBe("AAPLc");
      expect(token.decimals).toBe(8);
      expect(token.address.toLowerCase()).toBe(AAPLC.toLowerCase());
    }
  });

  it("resolveToken is sync and the same", () => {
    const token = resolveToken("apple");
    expect(token.symbol).toBe("AAPLc");
    expect(token.decimals).toBe(8);
  });

  it("isB20StockAddress accepts AAPLc", () => {
    expect(isB20StockAddress(AAPLC)).toBe(true);
    expect(isB20StockAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")).toBe(false);
  });
});
