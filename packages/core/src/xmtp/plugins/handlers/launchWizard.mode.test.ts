import { describe, expect, it } from "vitest";

import type { LaunchState } from "./launchWizard.handler.js";

describe("launch wizard modes", () => {
  it("keeps Bankr path free of pair requirements", () => {
    const state: LaunchState = {
      name: "Pizza",
      symbol: "PIZZA",
      imagePromptDone: true,
      mode: "bankr",
    };
    expect(state.mode).not.toBe("b20_stock");
    expect(state.pairSymbol).toBeUndefined();
  });

  it("marks B20 stock path and carries pairSymbol", () => {
    const state: LaunchState = {
      name: "Pizza",
      symbol: "PIZZA",
      imagePromptDone: true,
      mode: "b20_stock",
      pairSymbol: "AAPL",
    };
    expect(state.mode).toBe("b20_stock");
    expect(state.pairSymbol).toBe("AAPL");
  });

  it("does not mix Bankr confirm with B20 pair fields by default", () => {
    const bankr: LaunchState = { name: "A", symbol: "A", imagePromptDone: true };
    const b20: LaunchState = {
      name: "A",
      symbol: "A",
      imagePromptDone: true,
      mode: "b20_stock",
      pairSymbol: "TSLA",
    };
    expect(bankr.mode ?? "bankr").toBe("bankr");
    expect(b20.mode).toBe("b20_stock");
    expect(Boolean(bankr.pairSymbol)).toBe(false);
    expect(Boolean(b20.pairSymbol)).toBe(true);
  });
});
