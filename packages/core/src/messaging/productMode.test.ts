import { describe, expect, it } from "vitest";

import {
  productModeForIntentAction,
  productModeForPendingState,
} from "./productMode.js";

describe("iMessage product mode mapping", () => {
  it("maps trading, perps, and yield actions to the trading mode", () => {
    expect(productModeForIntentAction("swap")).toBe("trading");
    expect(productModeForIntentAction("perp_trade")).toBe("trading");
    expect(productModeForIntentAction("yield")).toBe("trading");
  });

  it("maps money movement and ramp actions to the money mode", () => {
    expect(productModeForIntentAction("send_token")).toBe("money");
    expect(productModeForIntentAction("main_wallet_fund")).toBe("money");
    expect(productModeForIntentAction("main_wallet_transfer")).toBe("money");
    expect(productModeForIntentAction("main_wallet_offramp")).toBe("money");
  });

  it("maps active pending flows to their product modes", () => {
    expect(productModeForPendingState({ pendingPerp: true })).toBe("trading");
    expect(productModeForPendingState({ pendingYieldChoice: true })).toBe("trading");
    expect(productModeForPendingState({ pendingAmountChoice: true })).toBe("trading");
    expect(productModeForPendingState({ pendingSwapDraft: true })).toBe("trading");
    expect(productModeForPendingState({ pendingFundAmount: true })).toBe("money");
    expect(productModeForPendingState({ pendingOnramp: true })).toBe("money");
  });

  it("ignores unrelated actions and empty pending state", () => {
    expect(productModeForIntentAction("main_wallet_balance")).toBeUndefined();
    expect(productModeForPendingState({})).toBeUndefined();
  });
});
