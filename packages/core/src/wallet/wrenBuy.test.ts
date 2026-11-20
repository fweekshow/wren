import { describe, expect, it } from "vitest";
import { wrenBuyCharge } from "./wrenBuy.js";

describe("Wren buy pricing", () => {
  it("charges no Wren fee on a buy", () => {
    expect(wrenBuyCharge(50)).toEqual({ stockUsd: 50, feeUsd: 0, totalUsd: 50 });
  });

  it("rounds to the cent and never goes negative", () => {
    expect(wrenBuyCharge(10.005).totalUsd).toBe(10.01);
    expect(wrenBuyCharge(-5).totalUsd).toBe(0);
  });
});
