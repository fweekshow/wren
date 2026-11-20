import { describe, expect, it } from "vitest";

import { clampToRails } from "@basemate/shared";

import { inferTradeDirectionFromText, resolveStrategyDirection } from "./promptStrategy.js";

describe("inferTradeDirectionFromText", () => {
  it("recovers short / long lean from prompt text", () => {
    expect(inferTradeDirectionFromText("fade the pop on sol")).toBe("short");
    expect(inferTradeDirectionFromText("short eth on dumps")).toBe("short");
    expect(inferTradeDirectionFromText("ride the breakout")).toBe("long");
    expect(inferTradeDirectionFromText("go long btc")).toBe("long");
  });

  it("returns adaptive for mixed and undefined for neutral prompts", () => {
    expect(inferTradeDirectionFromText("long breakouts and short crashes")).toBe("adaptive");
    expect(inferTradeDirectionFromText("a balanced sol strategy")).toBeUndefined();
  });
});

describe("resolveStrategyDirection", () => {
  it("prefers the stored config field when present", () => {
    const cfg = clampToRails({ tradeDirection: "short" });
    expect(resolveStrategyDirection(cfg, "ride the breakout")).toBe("short");
  });

  it("recovers from the original prompt for legacy strategies (no field)", () => {
    const cfg = clampToRails({});
    expect(cfg.tradeDirection).toBeUndefined();
    expect(resolveStrategyDirection(cfg, "i want to short sol")).toBe("short");
  });

  it("falls back to adaptive when nothing is known", () => {
    const cfg = clampToRails({});
    expect(resolveStrategyDirection(cfg, "")).toBe("adaptive");
  });
});
