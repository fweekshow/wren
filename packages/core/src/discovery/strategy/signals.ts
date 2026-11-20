import type { StrategyConfig, StrategyId } from "@basemate/shared";

export type MarketRegime =
  | "TREND_UP"
  | "TREND_DOWN"
  | "CHOP"
  | "BREAKOUT"
  | "BREAKDOWN"
  | "SUPERBURST"
  | "CRASH";

export interface PriceSample {
  ts: number;
  price: number;
}

export interface SignalContext {
  pair: string;
  price: number;
  samples: PriceSample[];
  config: StrategyConfig;
}

export interface TradeSignal {
  pair: string;
  side: "long" | "short";
  mode: StrategyId;
  reason: string;
  confidence: number;
  /** Market regime active when this signal fired — persisted as entry_regime for Improve diagnostics. */
  regime?: MarketRegime;
}

export const ORACLE_MIN_SAMPLES = 12;

/** Below this 12-tick range the tape is dead flat — antiChop blocks entries. */
export const TRUE_CHOP_RANGE_PCT = Number(process.env.TRUE_CHOP_RANGE_PCT ?? 0.06);

/** Minimum range to clear modeled round-trip costs (~30bps). */
export const MIN_TRADEABLE_RANGE_PCT = Number(process.env.MIN_TRADEABLE_RANGE_PCT ?? 0.28);

/** Breakout/breakdown need a confirming 5-bar move. */
export const BREAK_MOVE5_CONFIRM_PCT = 0.15;

const MIN_SAMPLES = ORACLE_MIN_SAMPLES;

export type SignalBlockReason =
  | "warmup"
  | "no_executable_modes"
  | "true_chop"
  | "below_min_tradeable_range"
  | "direction_blocked"
  | "no_mode_match";

export interface OracleDiagnostics {
  pair: string;
  price: number;
  sampleCount: number;
  range12Pct: number;
  move5Pct: number;
  regime: MarketRegime;
  isTrueChop: boolean;
  blockReason: SignalBlockReason | null;
  signal: TradeSignal | null;
  /** Whether the runner evaluates this pair each tick (all pairs after multi-pair fix). */
  pairTicked: boolean;
}

/**
 * Enforce the user's requested `tradeDirection`. When a strategy is configured
 * long-only or short-only, signals on the opposite side are dropped. "adaptive"
 * (or unset) lets the regime logic pick the side per entry. This makes
 * `tradeDirection` a real runtime constraint rather than informational copy.
 */
export function directionAllows(
  config: Pick<StrategyConfig, "tradeDirection">,
  side: "long" | "short",
): boolean {
  const dir = config.tradeDirection;
  if (dir === "long") return side === "long";
  if (dir === "short") return side === "short";
  return true;
}

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

export function pctChange(from: number, to: number): number {
  if (from <= 0) return 0;
  return ((to - from) / from) * 100;
}

export function range12Pct(prices: number[]): number {
  if (prices.length < MIN_SAMPLES) return 0;
  const window = prices.slice(-12);
  const windowHigh = Math.max(...window);
  const windowLow = Math.min(...window);
  return windowLow > 0 ? ((windowHigh - windowLow) / windowLow) * 100 : 0;
}

export function isTrueChop(rangePct: number): boolean {
  return rangePct < TRUE_CHOP_RANGE_PCT;
}

export function detectRegime(prices: number[]): MarketRegime {
  if (prices.length < MIN_SAMPLES) return "CHOP";
  const fast = sma(prices, 5);
  const slow = sma(prices, 12);
  const last = prices[prices.length - 1]!;
  const windowHigh = Math.max(...prices.slice(-12));
  const windowLow = Math.min(...prices.slice(-12));
  const rangePct = range12Pct(prices);
  const move5 = pctChange(prices[prices.length - 6] ?? last, last);

  if (Math.abs(move5) >= 2.5) return move5 > 0 ? "SUPERBURST" : "CRASH";
  if (isTrueChop(rangePct)) return "CHOP";
  if (fast != null && slow != null) {
    if (fast > slow * 1.0015 && last >= windowHigh * 0.997) return "BREAKOUT";
    if (fast < slow * 0.9985 && last <= windowLow * 1.003) return "BREAKDOWN";
    if (fast > slow * 1.001) return "TREND_UP";
    if (fast < slow * 0.999) return "TREND_DOWN";
  }
  return "CHOP";
}

const EXECUTABLE_MODES = [
  "breakout_continuation",
  "trend_pullback",
  "superburst",
  "funding_basis_momentum",
  "alpha_crush",
] as const;

function oracleMetrics(ctx: SignalContext): {
  prices: number[];
  regime: MarketRegime;
  rangePct: number;
  move5: number;
  windowHigh: number;
  windowLow: number;
  fast: number | null;
  slow: number | null;
  modes: StrategyId[];
} {
  const { config, price, samples } = ctx;
  const prices = samples.map((s) => s.price);
  const regime = detectRegime(prices);
  const rangePct = range12Pct(prices);
  const move5 = pctChange(prices[prices.length - 6] ?? price, price);
  const windowHigh = Math.max(...prices.slice(-12));
  const windowLow = Math.min(...prices.slice(-12));
  const fast = sma(prices, 5);
  const slow = sma(prices, 12);
  const modes = config.enabledStrategies.filter((m) =>
    (EXECUTABLE_MODES as readonly string[]).includes(m),
  );
  return { prices, regime, rangePct, move5, windowHigh, windowLow, fast, slow, modes };
}

function evaluateSignalCore(ctx: SignalContext): {
  signal: TradeSignal | null;
  blockReason: SignalBlockReason | null;
  regime: MarketRegime;
  rangePct: number;
  move5: number;
} {
  const { config, price, pair, samples } = ctx;
  if (samples.length < MIN_SAMPLES) {
    return { signal: null, blockReason: "warmup", regime: "CHOP", rangePct: 0, move5: 0 };
  }

  const { regime, rangePct, move5, windowHigh, windowLow, fast, slow, modes } = oracleMetrics(ctx);

  if (!modes.length) {
    return { signal: null, blockReason: "no_executable_modes", regime, rangePct, move5 };
  }

  if (config.regimeFilters.antiChop && isTrueChop(rangePct)) {
    return { signal: null, blockReason: "true_chop", regime, rangePct, move5 };
  }

  const emit = (signal: TradeSignal): TradeSignal | null => {
    if (!directionAllows(config, signal.side)) return null;
    return signal;
  };

  const isEventRegime = regime === "SUPERBURST" || regime === "CRASH";
  if (!isEventRegime && rangePct < MIN_TRADEABLE_RANGE_PCT) {
    return { signal: null, blockReason: "below_min_tradeable_range", regime, rangePct, move5 };
  }

  if (modes.includes("alpha_crush") && config.alphaCrush && regime === "CRASH" && move5 <= -2) {
    const signal = emit({
      pair,
      side: "short",
      mode: "alpha_crush",
      reason: "crash dislocation — alpha crush short bias",
      confidence: 0.72,
      regime,
    });
    if (!signal) return { signal: null, blockReason: "direction_blocked", regime, rangePct, move5 };
    return { signal, blockReason: null, regime, rangePct, move5 };
  }

  if (modes.includes("superburst") && regime === "SUPERBURST" && move5 >= 2) {
    const signal = emit({
      pair,
      side: "long",
      mode: "superburst",
      reason: "velocity burst continuation",
      confidence: 0.68,
      regime,
    });
    if (!signal) return { signal: null, blockReason: "direction_blocked", regime, rangePct, move5 };
    return { signal, blockReason: null, regime, rangePct, move5 };
  }

  if (
    modes.includes("breakout_continuation") &&
    regime === "BREAKOUT" &&
    move5 >= BREAK_MOVE5_CONFIRM_PCT &&
    price >= windowHigh * 0.997
  ) {
    const signal = emit({
      pair,
      side: "long",
      mode: "breakout_continuation",
      reason: "range breakout with trend alignment",
      confidence: 0.65,
      regime,
    });
    if (!signal) return { signal: null, blockReason: "direction_blocked", regime, rangePct, move5 };
    return { signal, blockReason: null, regime, rangePct, move5 };
  }

  if (
    modes.includes("breakout_continuation") &&
    regime === "BREAKDOWN" &&
    move5 <= -BREAK_MOVE5_CONFIRM_PCT &&
    price <= windowLow * 1.003
  ) {
    const signal = emit({
      pair,
      side: "short",
      mode: "breakout_continuation",
      reason: "range breakdown with trend alignment",
      confidence: 0.65,
      regime,
    });
    if (!signal) return { signal: null, blockReason: "direction_blocked", regime, rangePct, move5 };
    return { signal, blockReason: null, regime, rangePct, move5 };
  }

  if (
    modes.includes("trend_pullback") &&
    (regime === "TREND_UP" || regime === "TREND_DOWN") &&
    fast != null &&
    slow != null
  ) {
    const side = regime === "TREND_UP" ? "long" : "short";
    const pulledBack =
      regime === "TREND_UP" ? price <= fast && price >= slow : price >= fast && price <= slow;
    if (pulledBack) {
      const signal = emit({
        pair,
        side,
        mode: "trend_pullback",
        reason: "trend pullback continuation",
        confidence: 0.6,
        regime,
      });
      if (!signal) return { signal: null, blockReason: "direction_blocked", regime, rangePct, move5 };
      return { signal, blockReason: null, regime, rangePct, move5 };
    }
  }

  if (modes.includes("funding_basis_momentum") && regime === "TREND_UP" && move5 > 0.4) {
    const signal = emit({
      pair,
      side: "long",
      mode: "funding_basis_momentum",
      reason: "positive drift with funding bias",
      confidence: 0.55,
      regime,
    });
    if (!signal) return { signal: null, blockReason: "direction_blocked", regime, rangePct, move5 };
    return { signal, blockReason: null, regime, rangePct, move5 };
  }

  return { signal: null, blockReason: "no_mode_match", regime, rangePct, move5 };
}

/**
 * Oracle/price-only signal evaluation for v1 execution modes.
 * Uses mark-price samples collected by the strategy runner — no order book.
 */
export function evaluateOracleSignals(ctx: SignalContext): TradeSignal | null {
  return evaluateSignalCore(ctx).signal;
}

/** Runtime diagnostics for Technicals and dry-run tooling. */
export function evaluateOracleDiagnostics(
  ctx: SignalContext,
  opts: { pairTicked?: boolean } = {},
): OracleDiagnostics {
  const { pair, price, samples } = ctx;
  const core = evaluateSignalCore(ctx);
  return {
    pair,
    price,
    sampleCount: samples.length,
    range12Pct: core.rangePct,
    move5Pct: core.move5,
    regime: core.regime,
    isTrueChop: isTrueChop(core.rangePct),
    blockReason: core.signal ? null : core.blockReason,
    signal: core.signal,
    pairTicked: opts.pairTicked ?? true,
  };
}

/** Instant entry for smoke-test strategies (no sample warmup). */
export function smokeTestEntrySignal(
  config: StrategyConfig,
  pair: string,
): TradeSignal | null {
  const smoke = config.smokeTest;
  if (!smoke) return null;
  return {
    pair,
    side: smoke.side,
    mode: "superburst",
    reason: "instant entry — configured one-shot trigger",
    confidence: 1,
  };
}
