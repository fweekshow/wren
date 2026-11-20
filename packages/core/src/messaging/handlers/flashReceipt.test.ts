import { describe, expect, it } from "vitest";

import type { FlashPreparedOrder } from "@/discovery/flash/index.js";

import {
  formatFlashAmount,
  formatFlashReceipt,
  friendlyFlashPlaceError,
} from "./flashReceipt.js";

const buy = (): FlashPreparedOrder => ({
  quoteId: "q",
  orderType: "market",
  side: "buy",
  targetAsset: "0x07e61d8a4e197dfc269e90d7ece1df0d26702ba3",
  contraAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  targetSymbol: "BASEMATE",
  contraSymbol: "USDC",
  qty: "1",
  funderAddress: "0xC5b7653AF1570Ba70ebCBb542962a59c108Bdbf7",
  orderTypedData: "{}",
  approveTx: null,
  estimatedFeeNotional: "0.01",
  fromNotional: "1",
  toNotional: "0.98",
  fromAmount: "1",
  toAmount: "547687.12",
});

describe("formatFlashAmount", () => {
  it("compacts large token amounts without mangling whole numbers", () => {
    expect(formatFlashAmount("547687.12")).toBe("548k");
    expect(formatFlashAmount("100")).toBe("100");
    expect(formatFlashAmount("1")).toBe("1");
    expect(formatFlashAmount("0.01")).toBe("0.01");
  });
});

describe("formatFlashReceipt", () => {
  it("matches swap-style confirm when filled", () => {
    const text = formatFlashReceipt(buy(), {
      status: "ORDER_STATUS_FILLED",
      filled: { targetAmount: "547687.12", contraAmount: "1" },
    });
    expect(text).toBe(
      "✅ Swap confirmed\n\nSpent: $1 USDC\nGot: 548k Basemate\n\nview your activity in the app",
    );
    expect(text).not.toContain("flash");
    expect(text).not.toContain("Bought");
  });

  it("uses placed + watch copy when resting advanced order", () => {
    const p = buy();
    p.orderType = "limit";
    p.limitNotionalPrice = "2500";
    p.targetSymbol = "ETH";
    p.qty = "100";
    const text = formatFlashReceipt(p, { status: "ORDER_STATUS_ACCEPTED" });
    expect(text).toContain("✅ Limit buy 100 USDC of ETH @ $2500 — placed.");
    expect(text).toContain("i'll ping you when it fills");
    expect(text).toContain("view your activity in the app");
  });

  it("sells show token spent and dollar USDC received", () => {
    const sell = buy();
    sell.side = "sell";
    sell.qty = "2940000";
    sell.fromNotional = "5.01";
    sell.toAmount = "5.01";
    const text = formatFlashReceipt(sell, { status: "ORDER_STATUS_FILLED" });
    expect(text).toBe(
      "✅ Swap confirmed\n\nSpent: 2.94M Basemate\nGot: $5.01 USDC\n\nview your activity in the app",
    );
  });

  it("uses swap line + submitted for unfilled markets", () => {
    const text = formatFlashReceipt(buy(), { status: "ORDER_STATUS_ACCEPTED" });
    expect(text).toBe(
      "✅ Swap submitted\n\nSpent: $1 USDC\nGot: 548k Basemate\n\nview your activity in the app",
    );
    expect(text).not.toContain("i'll ping you");
  });
});

describe("friendlyFlashPlaceError", () => {
  it("rewrites minimum notional rejections", () => {
    expect(
      friendlyFlashPlaceError(
        "Flash rejected the order: flash order submission failed: order below minimum notional size requirement: $0.0100 is below minimum $0.1000 for chain base",
      ),
    ).toBe("that trade's too small — need at least $0.10. try a bigger amount.");
  });
});
