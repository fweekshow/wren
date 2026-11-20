/**
 * Basemate performance fee (bps of profit above the high-water mark). Mirror of
 * `STRATEGY_PROFIT_FEE_BPS` in strategyFee.ts — inlined here to avoid a module
 * cycle (and to keep this pure cost model independent of on-chain fee logic).
 */
const PROFIT_FEE_BPS = 1000;

/**
 * Conservative execution-cost model shared by paper simulation and previews.
 *
 * Avantis does not expose its live open/close fee, spread, price-impact, or
 * hourly margin fee through our client (see the avantis-integration asks), so
 * this model uses deliberately CONSERVATIVE assumptions — it should never make
 * paper look better than live. Every assumption is env-overridable so the
 * `avantis-validation` work can pin real, fixture-backed values without a code
 * change, and `COST_MODEL_VERSION` is stamped onto anything we persist so old
 * simulations remain reproducible.
 *
 * All bps are applied to NOTIONAL (collateral × leverage) unless noted.
 */
export const COST_MODEL_VERSION = "cm-2026-07-v1";

function envBps(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Conservative default assumptions (bps of notional unless noted). */
export function costModelAssumptions() {
  return {
    /** Avantis taker open fee. Conservative vs published crypto fixed fee. */
    openFeeBps: envBps("STRATEGY_COST_OPEN_FEE_BPS", 10),
    /** Avantis taker close fee. */
    closeFeeBps: envBps("STRATEGY_COST_CLOSE_FEE_BPS", 10),
    /** Half-spread paid on entry + exit, combined. */
    spreadBps: envBps("STRATEGY_COST_SPREAD_BPS", 4),
    /** Conservative execution slippage vs the mark, combined entry + exit. */
    slippageBps: envBps("STRATEGY_COST_SLIPPAGE_BPS", 6),
    /** Hourly margin/borrow fee on notional, charged per hold hour. */
    hourlyMarginBps: envBps("STRATEGY_COST_HOURLY_MARGIN_BPS", 1),
    /** Basemate performance fee on profit above the high-water mark. */
    profitFeeBps: PROFIT_FEE_BPS,
  };
}

export interface ExecutionCostBreakdown {
  openFeeUsd: number;
  closeFeeUsd: number;
  spreadUsd: number;
  slippageUsd: number;
  marginFeeUsd: number;
  /** Sum of all venue/execution costs (excludes the Basemate profit fee). */
  totalCostUsd: number;
  notionalUsd: number;
  modelVersion: string;
}

/** Estimate venue + execution costs for a round-trip position. */
export function estimateExecutionCosts(input: {
  collateralUsdc: number;
  leverage: number;
  holdSeconds?: number;
}): ExecutionCostBreakdown {
  const a = costModelAssumptions();
  const notionalUsd = Math.max(0, input.collateralUsdc) * Math.max(1, input.leverage);
  const holdHours = Math.max(0, (input.holdSeconds ?? 0) / 3600);

  const bpsUsd = (bps: number) => (notionalUsd * bps) / 10_000;
  const openFeeUsd = bpsUsd(a.openFeeBps);
  const closeFeeUsd = bpsUsd(a.closeFeeBps);
  const spreadUsd = bpsUsd(a.spreadBps);
  const slippageUsd = bpsUsd(a.slippageBps);
  const marginFeeUsd = bpsUsd(a.hourlyMarginBps) * holdHours;

  const totalCostUsd = openFeeUsd + closeFeeUsd + spreadUsd + slippageUsd + marginFeeUsd;
  return {
    openFeeUsd,
    closeFeeUsd,
    spreadUsd,
    slippageUsd,
    marginFeeUsd,
    totalCostUsd,
    notionalUsd,
    modelVersion: COST_MODEL_VERSION,
  };
}

export interface PaperTradeOutcome {
  grossPnlUsd: number;
  costs: ExecutionCostBreakdown;
  /** Gross PnL minus venue/execution costs — the on-chain-equivalent net. */
  netProtocolPnlUsd: number;
}

/**
 * Net a paper position's gross PnL by the modeled execution costs. This is the
 * dominant paper↔live divergence today (paper previously reported frictionless
 * gross), so folding costs into the stored close PnL makes paper a conservative
 * simulator. The Basemate 10% profit fee is applied separately at the strategy
 * level (high-water-mark), matching live settlement — see `paperProfitFeeUsd`.
 */
export function computePaperTradeOutcome(input: {
  grossPnlUsd: number;
  collateralUsdc: number;
  leverage: number;
  holdSeconds?: number;
}): PaperTradeOutcome {
  const costs = estimateExecutionCosts(input);
  return {
    grossPnlUsd: input.grossPnlUsd,
    costs,
    netProtocolPnlUsd: input.grossPnlUsd - costs.totalCostUsd,
  };
}
