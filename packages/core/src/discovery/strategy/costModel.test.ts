import { afterEach, describe, expect, it } from "vitest";

import {
  computePaperTradeOutcome,
  costModelAssumptions,
  estimateExecutionCosts,
} from "./costModel.js";

const COST_ENV = [
  "STRATEGY_COST_OPEN_FEE_BPS",
  "STRATEGY_COST_CLOSE_FEE_BPS",
  "STRATEGY_COST_SPREAD_BPS",
  "STRATEGY_COST_SLIPPAGE_BPS",
  "STRATEGY_COST_HOURLY_MARGIN_BPS",
];

afterEach(() => {
  for (const k of COST_ENV) delete process.env[k];
});

describe("estimateExecutionCosts", () => {
  it("charges every cost component on notional (BTC/ETH/SOL golden)", () => {
    // notional = 100 * 10 = 1000; default bps = open10 close10 spread4 slippage6 = 30bps → $3.00
    const c = estimateExecutionCosts({ collateralUsdc: 100, leverage: 10, holdSeconds: 0 });
    expect(c.notionalUsd).toBe(1000);
    expect(c.openFeeUsd).toBeCloseTo(1.0, 9);
    expect(c.closeFeeUsd).toBeCloseTo(1.0, 9);
    expect(c.spreadUsd).toBeCloseTo(0.4, 9);
    expect(c.slippageUsd).toBeCloseTo(0.6, 9);
    expect(c.marginFeeUsd).toBe(0);
    expect(c.totalCostUsd).toBeCloseTo(3.0, 9);
  });

  it("adds hourly margin fee proportional to hold time", () => {
    // 1 bps/hr on 1000 notional = $0.10/hr; 2h → $0.20
    const c = estimateExecutionCosts({ collateralUsdc: 100, leverage: 10, holdSeconds: 7200 });
    expect(c.marginFeeUsd).toBeCloseTo(0.2, 9);
    expect(c.totalCostUsd).toBeCloseTo(3.2, 9);
  });

  it("is env-tunable so avantis-validation can pin real values", () => {
    process.env.STRATEGY_COST_OPEN_FEE_BPS = "0";
    process.env.STRATEGY_COST_CLOSE_FEE_BPS = "0";
    process.env.STRATEGY_COST_SPREAD_BPS = "0";
    process.env.STRATEGY_COST_SLIPPAGE_BPS = "0";
    process.env.STRATEGY_COST_HOURLY_MARGIN_BPS = "0";
    const c = estimateExecutionCosts({ collateralUsdc: 100, leverage: 10 });
    expect(c.totalCostUsd).toBe(0);
  });

  it("stamps the model version for reproducibility", () => {
    expect(estimateExecutionCosts({ collateralUsdc: 50, leverage: 2 }).modelVersion).toMatch(/^cm-/);
    expect(costModelAssumptions().profitFeeBps).toBe(1000);
  });
});

describe("computePaperTradeOutcome", () => {
  it("nets costs off a winning trade (paper is conservative, never frictionless)", () => {
    const o = computePaperTradeOutcome({ grossPnlUsd: 6, collateralUsdc: 100, leverage: 5 });
    // notional 500, 30bps = $1.50 → net 4.50
    expect(o.netProtocolPnlUsd).toBeCloseTo(4.5, 9);
    expect(o.netProtocolPnlUsd).toBeLessThan(o.grossPnlUsd);
  });

  it("makes a loss worse by the cost drag", () => {
    const o = computePaperTradeOutcome({ grossPnlUsd: -3, collateralUsdc: 100, leverage: 5 });
    expect(o.netProtocolPnlUsd).toBeCloseTo(-4.5, 9);
  });
});
