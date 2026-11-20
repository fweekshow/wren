import { describe, expect, it } from "vitest";
import { clampToRails } from "@basemate/shared";

import { directionAllows, evaluateOracleSignals, type PriceSample } from "./signals.js";

describe("directionAllows", () => {
  it("long-only rejects shorts, allows longs", () => {
    expect(directionAllows({ tradeDirection: "long" }, "short")).toBe(false);
    expect(directionAllows({ tradeDirection: "long" }, "long")).toBe(true);
  });
  it("short-only rejects longs, allows shorts", () => {
    expect(directionAllows({ tradeDirection: "short" }, "long")).toBe(false);
    expect(directionAllows({ tradeDirection: "short" }, "short")).toBe(true);
  });
  it("adaptive / unset allows both", () => {
    expect(directionAllows({ tradeDirection: "adaptive" }, "long")).toBe(true);
    expect(directionAllows({ tradeDirection: undefined }, "short")).toBe(true);
  });
});

/** Build a sharp downward crash series that would normally fire an alpha-crush short. */
function crashSamples(): PriceSample[] {
  const out: PriceSample[] = [];
  let price = 100;
  for (let i = 0; i < 12; i++) {
    out.push({ ts: i * 60_000, price });
    price *= 0.99; // steady decline
  }
  // sharp last-leg drop to trigger CRASH / move5 <= -2
  out[out.length - 1] = { ts: 12 * 60_000, price: out[6]!.price * 0.95 };
  return out;
}

describe("evaluateOracleSignals direction enforcement", () => {
  it("suppresses a short signal for a long-only strategy", () => {
    const samples = crashSamples();
    const price = samples[samples.length - 1]!.price;
    const longOnly = clampToRails({
      enabledStrategies: ["alpha_crush"],
      alphaCrush: true,
      pairs: ["ETH-USD"],
      tradeDirection: "long",
    });
    const signal = evaluateOracleSignals({ pair: "ETH-USD", price, samples, config: longOnly });
    expect(signal?.side).not.toBe("short");
  });
});
