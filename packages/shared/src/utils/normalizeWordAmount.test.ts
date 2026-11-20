import { describe, expect, it } from "vitest";

import { normalizeWordAmount, resolveSendAmount } from "./normalizeWordAmount.js";

describe("normalizeWordAmount", () => {
  it("maps penny/cent phrases to 0.01", () => {
    expect(normalizeWordAmount("a penny")).toBe("0.01");
    expect(normalizeWordAmount("one cent")).toBe("0.01");
    expect(normalizeWordAmount("1 cent")).toBe("0.01");
    expect(normalizeWordAmount("a cent")).toBe("0.01");
    expect(normalizeWordAmount("penny")).toBe("0.01");
  });

  it("rejects unknown prose", () => {
    expect(normalizeWordAmount("lots")).toBeNull();
    expect(normalizeWordAmount("0.01")).toBeNull();
  });
});

describe("resolveSendAmount", () => {
  it("prefers word amounts then numerics", () => {
    expect(resolveSendAmount("a penny")).toBe("0.01");
    expect(resolveSendAmount(".01")).toBe(".01");
    expect(resolveSendAmount("0.01")).toBe("0.01");
    expect(resolveSendAmount(".010")).toBe(".010");
    expect(resolveSendAmount("0.0100")).toBe("0.0100");
  });
});
