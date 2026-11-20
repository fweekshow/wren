import { describe, expect, it } from "vitest";
import { WREN_SEND_FEE_USD, wrenSendCharge, wrenSendFeeUsd } from "./giftStock.service.js";

describe("Wren pricing", () => {
  it("charges a flat $2.99 to send", () => {
    expect(WREN_SEND_FEE_USD).toBe(2.99);
    expect(wrenSendFeeUsd({ firstSend: false })).toBe(2.99);
  });

  it("makes the first send free", () => {
    expect(wrenSendFeeUsd({ firstSend: true })).toBe(0);
    const c = wrenSendCharge(50, { firstSend: true });
    expect(c.feeUsd).toBe(0);
    expect(c.usdcNeeded).toBe(50);
  });

  it("passes the card cost through on top of stock + fee", () => {
    const c = wrenSendCharge(50, { firstSend: false });
    expect(c.usdcNeeded).toBe(52.99);
    // Coinbase keeps ~2.5% of the card charge, so the card total covers it.
    expect(c.totalUsd).toBeGreaterThan(c.usdcNeeded);
    expect(c.totalUsd * 0.975).toBeGreaterThanOrEqual(c.usdcNeeded - 0.005);
    expect(c.cardUsd).toBeCloseTo(c.totalUsd - c.usdcNeeded, 2);
  });

  it("is flat whatever the amount", () => {
    expect(wrenSendCharge(10, { firstSend: false }).feeUsd).toBe(2.99);
    expect(wrenSendCharge(5000, { firstSend: false }).feeUsd).toBe(2.99);
  });

  it("never charges a card less than $2", () => {
    expect(wrenSendCharge(0.5, { firstSend: true }).totalUsd).toBe(2);
  });
});
