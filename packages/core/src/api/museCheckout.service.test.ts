import { describe, expect, it } from "vitest";

import { assertMusePayUrl, listPublicMuseStocks } from "./museCheckout.service.js";

describe("listPublicMuseStocks", () => {
  it("includes AAPL and no invented tickers", () => {
    const items = listPublicMuseStocks();
    expect(items.some((s) => s.symbol === "AAPLc")).toBe(true);
    expect(items.map((s) => s.symbol).sort()).toEqual(
      expect.arrayContaining(["MUc", "PLTRc", "RBLXc"]),
    );
    expect(items.every((s) => s.symbol.endsWith("c"))).toBe(true);
  });
});

describe("assertMusePayUrl", () => {
  it("rejects a host that is not the fund page", () => {
    expect(() => assertMusePayUrl("https://evil.example/pay?s=abc")).toThrow(
      /allowlisted Apple Pay page/,
    );
  });
});
