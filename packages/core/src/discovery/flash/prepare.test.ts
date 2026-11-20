import { describe, expect, it } from "vitest";

import { formatFlashOrderPreview, amountUsdFromPrepared } from "./prepare.js";
import type { FlashPreparedOrder } from "./types.js";

const basePrepared = (): FlashPreparedOrder => ({
  quoteId: "q_test",
  orderType: "limit",
  side: "buy",
  targetAsset: "0x4200000000000000000000000000000000000006",
  contraAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  targetSymbol: "WETH",
  contraSymbol: "USDC",
  qty: "100",
  funderAddress: "0x1111111111111111111111111111111111111111",
  orderTypedData: "{}",
  approveTx: null,
  estimatedFeeNotional: "1.25",
  fromNotional: "100",
  toNotional: "0.04",
  fromAmount: "100",
  toAmount: "0.04",
  limitNotionalPrice: "2500",
});

describe("formatFlashOrderPreview", () => {
  it("formats a limit buy without fee/est clutter", () => {
    const text = formatFlashOrderPreview(basePrepared());
    expect(text).toBe("Limit buy 100 USDC of WETH @ $2500");
    expect(text).not.toContain("fees");
    expect(text).not.toContain("est.");
    expect(text).not.toContain("WETH/USDC");
  });

  it("formats a market buy as a single line", () => {
    const prepared = basePrepared();
    prepared.orderType = "market";
    prepared.limitNotionalPrice = undefined;
    prepared.targetSymbol = "BASEMATE";
    prepared.qty = ".1";
    expect(formatFlashOrderPreview(prepared)).toBe("Buy .1 USDC of BASEMATE");
  });

  it("mentions first-time approval when approveTx is present", () => {
    const prepared = basePrepared();
    prepared.approveTx = { to: "0xabc", data: "0x1234" };
    expect(formatFlashOrderPreview(prepared)).toContain("first time for this token");
  });
});

describe("amountUsdFromPrepared", () => {
  it("parses fromNotional", () => {
    expect(amountUsdFromPrepared(basePrepared())).toBe(100);
  });
});
