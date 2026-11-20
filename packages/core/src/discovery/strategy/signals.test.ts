import { describe, expect, test } from "vitest";
import { clampToRails, type StrategyConfig } from "@basemate/shared";

import {
  evaluateOracleDiagnostics,
  evaluateOracleSignals,
  MIN_TRADEABLE_RANGE_PCT,
  smokeTestEntrySignal,
  TRUE_CHOP_RANGE_PCT,
  type PriceSample,
} from "./signals.js";

function baseConfig(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return clampToRails({
    enabledStrategies: ["breakout_continuation", "trend_pullback", "superburst"],
    pairs: ["ETH-USD"],
    riskPerTradePct: 0.5,
    maxLeverage: 10,
    maxNotionalPctEquity: 40,
    dailyDrawdownStopPct: 5,
    ...overrides,
  });
}

function samplesFromPrices(prices: number[], startTs = Date.now() - prices.length * 60_000): PriceSample[] {
  return prices.map((price, i) => ({ ts: startTs + i * 60_000, price }));
}

describe("evaluateOracleSignals", () => {
  test("returns null until 12 mark samples exist", () => {
    const prices = Array.from({ length: 11 }, () => 100);
    const signal = evaluateOracleSignals({
      pair: "ETH-USD",
      price: 100,
      samples: samplesFromPrices(prices),
      config: baseConfig(),
    });
    expect(signal).toBeNull();
  });

  test("fires superburst long on a sharp 5-sample rally", () => {
    const flat = Array.from({ length: 7 }, () => 100);
    const ramp = [100, 101, 102.2, 103.5, 105];
    const prices = [...flat, ...ramp];
    const signal = evaluateOracleSignals({
      pair: "ETH-USD",
      price: prices[prices.length - 1]!,
      samples: samplesFromPrices(prices),
      config: baseConfig(),
    });
    expect(signal?.mode).toBe("superburst");
    expect(signal?.side).toBe("long");
  });

  test("antiChop blocks true chop only (very flat tape)", () => {
    const prices = Array.from({ length: 12 }, () => 100);
    const signal = evaluateOracleSignals({
      pair: "ETH-USD",
      price: 100,
      samples: samplesFromPrices(prices),
      config: baseConfig(),
    });
    expect(signal).toBeNull();
    const diag = evaluateOracleDiagnostics({
      pair: "ETH-USD",
      price: 100,
      samples: samplesFromPrices(prices),
      config: baseConfig(),
    });
    expect(diag.blockReason).toBe("true_chop");
  });

  test("wicky range above true chop but below min tradeable is blocked", () => {
    const mid = 100;
    const swing = (mid * (TRUE_CHOP_RANGE_PCT + 0.02)) / 100;
    const prices = Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0 ? mid - swing : mid + swing,
    );
    const signal = evaluateOracleSignals({
      pair: "ETH-USD",
      price: prices[prices.length - 1]!,
      samples: samplesFromPrices(prices),
      config: baseConfig(),
    });
    expect(signal).toBeNull();
    const diag = evaluateOracleDiagnostics({
      pair: "ETH-USD",
      price: prices[prices.length - 1]!,
      samples: samplesFromPrices(prices),
      config: baseConfig(),
    });
    expect(diag.isTrueChop).toBe(false);
    expect(diag.blockReason).toBe("below_min_tradeable_range");
    expect(diag.range12Pct).toBeLessThan(MIN_TRADEABLE_RANGE_PCT);
  });

  test("breakdown short fires for adaptive on sharp breakdown", () => {
    const base = 100;
    const prices = Array.from({ length: 12 }, (_, i) => base - i * 0.08);
    prices[11] = prices[6]! * 0.998;
    const signal = evaluateOracleSignals({
      pair: "ETH-USD",
      price: prices[prices.length - 1]!,
      samples: samplesFromPrices(prices),
      config: baseConfig({
        enabledStrategies: ["breakout_continuation"],
        tradeDirection: "adaptive",
      }),
    });
    expect(signal?.side).toBe("short");
    expect(signal?.mode).toBe("breakout_continuation");
  });

  test("alpha crush short fires on crash dislocation", () => {
    const flat = Array.from({ length: 7 }, () => 100);
    const dump = [100, 99, 97.5, 96, 94];
    const prices = [...flat, ...dump];
    const signal = evaluateOracleSignals({
      pair: "ETH-USD",
      price: prices[prices.length - 1]!,
      samples: samplesFromPrices(prices),
      config: baseConfig({
        enabledStrategies: ["alpha_crush"],
        alphaCrush: true,
      }),
    });
    expect(signal?.mode).toBe("alpha_crush");
    expect(signal?.side).toBe("short");
  });
});

describe("smokeTestEntrySignal", () => {
  test("returns instant long when smokeTest is set", () => {
    const signal = smokeTestEntrySignal(
      baseConfig({ smokeTest: { side: "long", tpPercent: 5, slPercent: 3 } }),
      "ETH-USD",
    );
    expect(signal?.side).toBe("long");
    expect(signal?.reason).toContain("instant entry");
  });

  test("returns null without smokeTest", () => {
    expect(smokeTestEntrySignal(baseConfig(), "ETH-USD")).toBeNull();
  });
});
