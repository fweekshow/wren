import { describe, expect, it } from "vitest";

import { isVibeTradingIntent } from "./vibeTradingIntent.util.js";

describe("isVibeTradingIntent", () => {
  it("does not route vibe trading or strategy phrases", () => {
    expect(isVibeTradingIntent("vibe trading")).toBe(false);
    expect(isVibeTradingIntent("VibeTrading")).toBe(false);
    expect(isVibeTradingIntent("Vibe-Trading")).toBe(false);
    expect(isVibeTradingIntent("vibe trade")).toBe(false);
    expect(isVibeTradingIntent("prompt a strategy")).toBe(false);
    expect(isVibeTradingIntent("perpmate")).toBe(false);
    expect(isVibeTradingIntent("perp menu")).toBe(false);
    expect(isVibeTradingIntent("perps menu!")).toBe(false);
    expect(isVibeTradingIntent("how does vibe trading work?")).toBe(false);
    expect(isVibeTradingIntent("long eth")).toBe(false);
  });
});
