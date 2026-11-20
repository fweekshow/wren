import { describe, expect, it } from "vitest";

import {
  corridorCallingCodeMap,
  isUsdSendAsset,
  resolveCorridorStable,
} from "./corridorRouting.js";

describe("isUsdSendAsset", () => {
  it("treats empty / USDC / USD / $ as USD rail", () => {
    expect(isUsdSendAsset(null)).toBe(true);
    expect(isUsdSendAsset(undefined)).toBe(true);
    expect(isUsdSendAsset("")).toBe(true);
    expect(isUsdSendAsset("USDC")).toBe(true);
    expect(isUsdSendAsset("usd")).toBe(true);
    expect(isUsdSendAsset("$")).toBe(true);
  });

  it("rejects explicit local stables", () => {
    expect(isUsdSendAsset("XSGD")).toBe(false);
    expect(isUsdSendAsset("MXNB")).toBe(false);
    expect(isUsdSendAsset("ETH")).toBe(false);
  });
});

describe("resolveCorridorStable", () => {
  it("maps Singapore +65 to XSGD", () => {
    const stable = resolveCorridorStable("+6591234567");
    expect(stable?.symbol).toBe("XSGD");
    expect(stable?.address).toBeTruthy();
  });

  it("maps UK +44 to TGBP", () => {
    expect(resolveCorridorStable("+447700900123")?.symbol).toBe("TGBP");
  });

  it("maps Mexico +52 to MXNB", () => {
    expect(resolveCorridorStable("+5215512345678")?.symbol).toBe("MXNB");
  });

  it("returns null for unmapped country codes", () => {
    expect(resolveCorridorStable("+15551234567")).toBeNull();
    expect(resolveCorridorStable("+639171234567")).toBeNull();
  });

  it("returns null for invalid phones", () => {
    expect(resolveCorridorStable("91234567")).toBeNull();
    expect(resolveCorridorStable("+65")).toBeNull();
    expect(resolveCorridorStable("")).toBeNull();
  });

  it("uses longest-prefix calling codes from the map", () => {
    const map = corridorCallingCodeMap();
    expect(map["65"]).toBe("XSGD");
    expect(map["44"]).toBe("TGBP");
    expect(map["41"]).toBe("VCHF");
  });
});
