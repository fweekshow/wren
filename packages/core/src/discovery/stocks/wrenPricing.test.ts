import { describe, expect, it } from "vitest";
import { WREN_SEND_FEE_MIN_USD, wrenSendCharge, wrenSendFeeUsd } from "./giftStock.service.js";

describe("Wren pricing", () => {
  it("charges 1.5% to send, at least $0.99", () => {
    expect(WREN_SEND_FEE_MIN_USD).toBe(0.99);
    expect(wrenSendFeeUsd({ firstSend: false, stockUsd: 10 })).toBe(0.99);
    expect(wrenSendFeeUsd({ firstSend: false, stockUsd: 50 })).toBe(0.99);
    expect(wrenSendFeeUsd({ firstSend: false, stockUsd: 66 })).toBe(0.99);
    expect(wrenSendFeeUsd({ firstSend: false, stockUsd: 100 })).toBe(1.5);
    expect(wrenSendFeeUsd({ firstSend: false, stockUsd: 500 })).toBe(7.5);
    expect(wrenSendFeeUsd({ firstSend: false, stockUsd: 123.45 })).toBe(1.85);
  });

  it("makes the first send free", () => {
    expect(wrenSendFeeUsd({ firstSend: true, stockUsd: 500 })).toBe(0);
    const c = wrenSendCharge(50, { firstSend: true });
    expect(c.feeUsd).toBe(0);
    expect(c.usdcNeeded).toBe(50);
  });

  it("adds the send fee to what's needed from cash", () => {
    expect(wrenSendCharge(50, { firstSend: false }).usdcNeeded).toBe(50.99);
    expect(wrenSendCharge(200, { firstSend: false }).usdcNeeded).toBe(203);
  });

  it("passes the card cost through on top of stock + fee", () => {
    const c = wrenSendCharge(50, { firstSend: false });
    expect(c.totalUsd).toBeGreaterThan(c.usdcNeeded);
    expect(c.totalUsd * 0.975).toBeGreaterThanOrEqual(c.usdcNeeded - 0.005);
    expect(c.cardUsd).toBeCloseTo(c.totalUsd - c.usdcNeeded, 2);
  });

  it("never charges a card less than $2", () => {
    expect(wrenSendCharge(0.5, { firstSend: true }).totalUsd).toBe(2);
  });
});
