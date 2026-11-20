import { describe, expect, it } from "vitest";

import { isSupportIntent } from "./ai.js";

describe("isSupportIntent", () => {
  it("matches bug reports", () => {
    expect(isSupportIntent("I found a bug")).toBe(true);
    expect(isSupportIntent("@askbasemate I found a bug")).toBe(true);
    expect(isSupportIntent("reporting a bug with swaps")).toBe(true);
  });

  it("matches broken / not working", () => {
    expect(isSupportIntent("something is broken")).toBe(true);
    expect(isSupportIntent("basemate isn't working")).toBe(true);
  });

  it("does not match generic how-to questions", () => {
    expect(isSupportIntent("how do swaps work")).toBe(false);
    expect(isSupportIntent("what perps can I trade")).toBe(false);
  });
});
