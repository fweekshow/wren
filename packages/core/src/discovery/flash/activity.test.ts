import { describe, expect, it } from "vitest";

import {
  flashActivityAmountAsset,
  flashFillTxHash,
  formatFlashActivityLabel,
  isFlashOrderFilled,
  isFlashOrderTerminalFail,
} from "./activity.js";
import type { FlashOrderDetail, FlashPreparedOrder } from "./types.js";

const prepared = (): FlashPreparedOrder => ({
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
  toAmount: "500000",
});

describe("formatFlashActivityLabel", () => {
  it("formats a market buy like a swap confirm", () => {
    expect(formatFlashActivityLabel(prepared())).toBe(
      "Swap 1 USDC ($1) → BASEMATE",
    );
  });

  it("formats a sell as Swap token → USDC", () => {
    const p = prepared();
    p.side = "sell";
    p.orderType = "limit";
    p.qty = "1000";
    expect(formatFlashActivityLabel(p)).toBe("Swap 1000 BASEMATE ($1) → USDC");
  });
});

describe("flashActivityAmountAsset", () => {
  it("uses contra on buy and target on sell", () => {
    expect(flashActivityAmountAsset(prepared())).toEqual({ amount: "1", asset: "USDC" });
    const sell = prepared();
    sell.side = "sell";
    sell.qty = "42";
    expect(flashActivityAmountAsset(sell)).toEqual({ amount: "42", asset: "BASEMATE" });
  });
});

describe("flashFillTxHash", () => {
  it("reads the first fill transactionId", () => {
    const detail: FlashOrderDetail = {
      orderId: "o1",
      status: "ORDER_STATUS_FILLED",
      fills: [
        {
          transactionId: "0x4531a7e9db25be45c4e0dbc0db97180464c13045b412c7f96783471addd96e1d",
          venues: ["Balancer V2"],
        },
      ],
    };
    expect(flashFillTxHash(detail)).toBe(
      "0x4531a7e9db25be45c4e0dbc0db97180464c13045b412c7f96783471addd96e1d",
    );
  });

  it("returns null when no fills", () => {
    expect(flashFillTxHash({ orderId: "o", status: "ORDER_STATUS_ACCEPTED" })).toBeNull();
  });
});

describe("status helpers", () => {
  it("detects filled and terminal fail", () => {
    expect(isFlashOrderFilled("ORDER_STATUS_FILLED")).toBe(true);
    expect(isFlashOrderFilled("ORDER_STATUS_ACCEPTED")).toBe(false);
    expect(isFlashOrderTerminalFail("ORDER_STATUS_CANCELLED")).toBe(true);
    expect(isFlashOrderTerminalFail("ORDER_STATUS_FILLED")).toBe(false);
  });
});
