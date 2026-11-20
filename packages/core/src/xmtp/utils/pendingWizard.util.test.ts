import { describe, expect, it } from "vitest";

import { shouldAbandonPendingWizard } from "./pendingWizard.util.js";

describe("shouldAbandonPendingWizard", () => {
  it("keeps valid launch name input", () => {
    expect(shouldAbandonPendingWizard("Pizza Coin", "launch_name")).toBe(false);
  });

  it("abandons launch name step on unrelated question", () => {
    expect(shouldAbandonPendingWizard("what perps can I trade?", "launch_name")).toBe(true);
  });

  it("keeps valid launch symbol input", () => {
    expect(shouldAbandonPendingWizard("PIZZA", "launch_symbol")).toBe(false);
    expect(shouldAbandonPendingWizard("$PIZZA", "launch_symbol")).toBe(false);
  });

  it("abandons launch symbol step when user pivots with a question", () => {
    expect(shouldAbandonPendingWizard("how do I swap eth?", "launch_symbol")).toBe(true);
  });

  it("does not abandon on plain cancel-like ticker without intent signals", () => {
    expect(shouldAbandonPendingWizard("cancel", "launch_symbol")).toBe(false);
  });

  it("abandons perp token step on support question", () => {
    expect(shouldAbandonPendingWizard("something is broken, help?", "perp_token")).toBe(true);
  });

  it("does not abandon without intent signals", () => {
    expect(shouldAbandonPendingWizard("COIN", "perp_token")).toBe(false);
  });
});
