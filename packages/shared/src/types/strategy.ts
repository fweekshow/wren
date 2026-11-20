/**
 * Bounded perps StrategyConfig for Prompt-a-Strategy. This is a parameterization
 * of the audited Tactical Alpha engine (see docs/tactical-alpha-strategy.md) —
 * NOT free-form code. Every field is clamped to the doc's §10–11 risk rails by
 * `clampToRails()`, so no prompted strategy can exceed Hedge limits.
 */

/** The §8 alpha modes. Alpha Crush is an advanced crisis/event mode (§8.7). */
export type StrategyId =
  | "breakout_continuation"
  | "trend_pullback"
  | "orderbook_impulse"
  | "funding_basis_momentum"
  | "superburst"
  | "tactical_to_trend"
  | "alpha_crush";

/** Modes the v1 oracle evaluator can run (no external CLOB). */
const ORACLE_EXECUTABLE_STRATEGIES: readonly StrategyId[] = [
  "breakout_continuation",
  "trend_pullback",
  "superburst",
  "funding_basis_momentum",
  "alpha_crush",
];

/** Modes that need an external order book — authored now, execution deferred. */
const ORDERBOOK_ONLY_STRATEGIES: readonly StrategyId[] = [
  "orderbook_impulse",
  "tactical_to_trend",
];

export function oracleExecutableModes(config: StrategyConfig): StrategyId[] {
  return config.enabledStrategies.filter((s) => ORACLE_EXECUTABLE_STRATEGIES.includes(s));
}

/** Human-readable metadata for each §8 Tactical Alpha mode (for UI/summaries). */
export const STRATEGY_MODE_META: Record<StrategyId, { label: string; blurb: string }> = {
  breakout_continuation: {
    label: "Breakout Continuation",
    blurb: "enters when price breaks a range and confirms the move",
  },
  trend_pullback: {
    label: "Trend Pullback",
    blurb: "buys pullbacks inside an established trend",
  },
  orderbook_impulse: {
    label: "Orderbook Impulse",
    blurb: "microstructure scalps from order-book pressure",
  },
  funding_basis_momentum: {
    label: "Funding/Basis Momentum",
    blurb: "momentum trades biased by funding/basis",
  },
  superburst: {
    label: "Superburst",
    blurb: "rides sharp velocity bursts",
  },
  tactical_to_trend: {
    label: "Tactical→Trend",
    blurb: "promotes a tactical scalp into a trend hold",
  },
  alpha_crush: {
    label: "Alpha Crush",
    blurb: "crisis/dislocation event playbook",
  },
};

export interface StrategyModeSummary {
  id: StrategyId;
  label: string;
  blurb: string;
  /** True when this mode actually executes in v1 (oracle-runnable, no external CLOB). */
  live: boolean;
}

/** Describe a config's active Tactical Alpha modes, flagging which run live in v1. */
export function describeStrategyModes(config: StrategyConfig): StrategyModeSummary[] {
  return config.enabledStrategies.map((id) => ({
    id,
    label: STRATEGY_MODE_META[id]?.label ?? id,
    blurb: STRATEGY_MODE_META[id]?.blurb ?? "",
    live: ORACLE_EXECUTABLE_STRATEGIES.includes(id),
  }));
}

export function hasOrderbookOnlyModes(config: StrategyConfig): boolean {
  return config.enabledStrategies.some((s) => ORDERBOOK_ONLY_STRATEGIES.includes(s));
}

const ALL_STRATEGY_IDS: readonly StrategyId[] = [
  "breakout_continuation",
  "trend_pullback",
  "orderbook_impulse",
  "funding_basis_momentum",
  "superburst",
  "tactical_to_trend",
  "alpha_crush",
];

/** Markets allowed in v1 (§2.2): SOL/ETH execute, BTC is context + optional. */
const ALLOWED_STRATEGY_PAIRS: readonly string[] = ["SOL-USD", "ETH-USD", "BTC-USD"];

/** Normalize a pair to `BASE-USD` and test it against the v1 executable set. */
export function isAllowedStrategyPair(pair: string): boolean {
  const normalized = String(pair).toUpperCase().trim();
  const withQuote = normalized.includes("-") ? normalized : `${normalized}-USD`;
  return ALLOWED_STRATEGY_PAIRS.includes(withQuote);
}

/** Dev smoke: fire one entry on the next runner tick (no price warmup). */
interface StrategySmokeTest {
  side: "long" | "short";
  /** Optional override; otherwise uses config tpPercent / slPercent. */
  tpPercent?: number;
  slPercent?: number;
}

export interface StrategyConfig {
  version: 1;
  /** Which §8 alpha modes are active. */
  enabledStrategies: StrategyId[];
  /** Execution markets, e.g. ["SOL-USD","ETH-USD"]. */
  pairs: string[];
  /** Risk per trade as % of equity (§10.2): 0.25 / 0.5 / 0.75 / 1.0. */
  riskPerTradePct: number;
  /** Max effective leverage (§10.4). Hard cap 10. */
  maxLeverage: number;
  /** Max notional exposure as % of equity for a single trade (§10.3). */
  maxNotionalPctEquity: number;
  /** Daily loss at which new entries pause (§10.5), 3–10. */
  dailyDrawdownStopPct: number;
  /** Loss-streak cooldowns (§10.6) — always on for safety. */
  lossStreakCooldown: boolean;
  /** Regime gating (§5): anti-chop on; trading chop is never allowed. */
  regimeFilters: { antiChop: boolean; tradeChop: false };
  /** Alpha Crush event mode (§8.7) — advanced crisis/dislocation playbook. */
  alphaCrush: boolean;
  /** Take-profit as % PRICE move from entry (long: above, short: below) — NOT ROI on margin. */
  tpPercent: number;
  /** Stop-loss as % PRICE move from entry (long: below, short: above) — NOT ROI on margin. */
  slPercent: number;
  /** USDC margin per automated entry (server wallet). */
  defaultCollateralUsdc: number;
  /**
   * Direction the user asked for, inferred from their prompt and surfaced in the
   * preview/detail UI. ENFORCED at runtime: "long" drops short signals and
   * "short" drops long signals (see `directionAllows` in signals.ts). "adaptive"
   * (or unset) lets the regime logic pick the side per entry.
   */
  tradeDirection?: "long" | "short" | "adaptive";
  /** When set, runner fires a single market entry on the next tick (no 12-sample warmup). */
  smokeTest?: StrategySmokeTest;
}

/**
 * Rails derived from §10–11. Nothing a user prompts may exceed these.
 * NOTE: leverage is intentionally a high SANITY ceiling here — the *real* cap is
 * each market's actual Avantis max, enforced in core via getAvantisPairMeta
 * (clampLeverageToPairMax). The other rails stay strict (risk, notional,
 * drawdown, anti-chop, loss-streak), so high leverage is allowed but still sits
 * inside disciplined risk + a cute "you sure?" warning.
 */
export const STRATEGY_RAILS = {
  riskPerTradePct: { min: 0.1, max: 1.0 },
  maxLeverage: { min: 1, max: 1000 },
  maxNotionalPctEquity: { min: 10, max: 100 },
  dailyDrawdownStopPct: { min: 3, max: 10 },
  tpPercent: { min: 0.3, max: 3.0 },
  slPercent: { min: 0.1, max: 2.0 },
  defaultCollateralUsdc: { min: 2, max: 500 },
} as const;

interface TpslBand {
  tpMin: number;
  tpMax: number;
  slMin: number;
  slMax: number;
}

const MIN_RR = 1.5;

/** Leverage-scoped TP/SL bands (quant-reviewed for 60s mark-price signals + Avantis fees). */
function tpslBandForLeverage(leverage: number): TpslBand {
  if (leverage <= 3) return { tpMin: 0.45, tpMax: 2.5, slMin: 0.3, slMax: 1.5 };
  if (leverage <= 5) return { tpMin: 0.45, tpMax: 2.2, slMin: 0.3, slMax: 1.2 };
  if (leverage <= 10) return { tpMin: 0.45, tpMax: 1.8, slMin: 0.3, slMax: 1.0 };
  if (leverage <= 20) return { tpMin: 0.45, tpMax: 1.5, slMin: 0.3, slMax: 0.8 };
  if (leverage <= 30) return { tpMin: 0.45, tpMax: 1.3, slMin: 0.3, slMax: 0.7 };
  if (leverage <= 50) return { tpMin: 0.45, tpMax: 1.2, slMin: 0.3, slMax: 0.6 };
  if (leverage <= 75) return { tpMin: 0.45, tpMax: 1.2, slMin: 0.3, slMax: 0.55 };
  return { tpMin: 0.45, tpMax: 1.2, slMin: 0.3, slMax: 0.5 };
}

/** Avantis min notional (~$100) — collateral × leverage must clear this. */
export const STRATEGY_MIN_NOTIONAL_USD = 100;

export function minStrategyCollateralUsdc(maxLeverage: number): number {
  return Math.ceil(STRATEGY_MIN_NOTIONAL_USD / Math.max(1, maxLeverage));
}

interface StrategyNotionalAdjustment {
  config: StrategyConfig;
  /** Human-readable note when collateral/leverage were auto-adjusted silently. */
  note?: string;
  /**
   * When set, the caller must pause and ask the user to pick a fix rather than
   * auto-adjusting silently. Pre-calculated option values:
   * - keepLeverageMargin: min collateral (USDC) needed to clear the min notional at the stated leverage
   * - keepMarginLeverage: min leverage needed to clear the min notional at the stated margin
   */
  needsChoice?: {
    keepLeverageMargin: number;
    keepMarginLeverage: number;
  };
}

/** Which sizing fields the user explicitly stated (and must not be silently overridden). */
interface StrategyNotionalLocks {
  /** User explicitly stated leverage (e.g. "20x") — keep it, adjust margin instead. */
  leverageLocked?: boolean;
  /** User explicitly stated margin (e.g. "$4") — keep it, adjust leverage instead. */
  collateralLocked?: boolean;
}

/**
 * Ensure collateral × leverage meets the ~$100 Avantis minimum notional.
 *
 * Behavior by lock state:
 * - BOTH locked (user said "20x with $4"): return needsChoice — pause and ask.
 * - only collateral locked (user said "$5", LLM chose leverage): return needsChoice — pause and ask.
 *   This prevents the 3x→20x beginner problem where a safety-motivated LLM leverage is silently overridden.
 * - only leverage locked (user said "20x", LLM chose margin): raise margin silently with a note.
 * - neither locked (pure LLM sizing): raise leverage first up to 10x, then raise margin if still short.
 *   The 10x cap avoids silently blasting a beginner-intended 3x strategy to 20x+.
 */
export function normalizeStrategyNotional(
  config: StrategyConfig,
  pairMaxLeverage: number,
  locks: StrategyNotionalLocks = {},
): StrategyNotionalAdjustment {
  const collateral = config.defaultCollateralUsdc;
  const leverage = config.maxLeverage;
  const notional = collateral * leverage;

  if (notional >= STRATEGY_MIN_NOTIONAL_USD) {
    return { config };
  }

  const cappedPairMax = Math.max(1, Math.floor(pairMaxLeverage));
  const needColl = Math.ceil(STRATEGY_MIN_NOTIONAL_USD / leverage);
  const needLev = Math.min(cappedPairMax, Math.ceil(STRATEGY_MIN_NOTIONAL_USD / collateral));

  // User stated collateral (with or without leverage) → always ask, never silently decide.
  if (locks.collateralLocked) {
    return {
      config,
      needsChoice: {
        keepLeverageMargin: needColl,
        keepMarginLeverage: needLev,
      },
    };
  }

  // User stated only leverage → keep it and raise margin silently with a note.
  if (locks.leverageLocked) {
    return {
      config: { ...config, defaultCollateralUsdc: needColl },
      note: `bumped your margin $${collateral} → $${needColl} to clear Avantis's $${STRATEGY_MIN_NOTIONAL_USD} minimum at ${leverage}x. tap Remix below to adjust 💙`,
    };
  }

  // Neither locked (pure LLM sizing): raise leverage up to 10x, then raise margin.
  // Hard cap at 10x prevents a safety-motivated 3x from being silently pushed to 20x+.
  const safeMaxLev = Math.min(cappedPairMax, 10);
  if (needLev <= safeMaxLev) {
    return {
      config: { ...config, maxLeverage: needLev },
      note: `raised leverage from ${leverage}x to ${needLev}x so $${collateral} margin clears the $${STRATEGY_MIN_NOTIONAL_USD} min notional`,
    };
  }

  // Even at the safe cap, notional is short — raise margin instead.
  const needCollAtSafeCap = Math.ceil(STRATEGY_MIN_NOTIONAL_USD / safeMaxLev);
  const finalLev = leverage < safeMaxLev ? safeMaxLev : leverage;
  const finalColl = Math.ceil(STRATEGY_MIN_NOTIONAL_USD / finalLev);
  return {
    config: { ...config, maxLeverage: finalLev, defaultCollateralUsdc: finalColl },
    note: `raised margin from $${collateral} to $${needCollAtSafeCap} so the position clears $${STRATEGY_MIN_NOTIONAL_USD} notional`,
  };
}

/**
 * Neutral TP/SL defaults before band clamp — trend-pullback midpoint per leverage band.
 */
function defaultTpslFromLeverage(maxLeverage: number): { tpPercent: number; slPercent: number } {
  if (maxLeverage <= 3) return { tpPercent: 1.2, slPercent: 0.6 };
  if (maxLeverage <= 5) return { tpPercent: 1.1, slPercent: 0.55 };
  if (maxLeverage <= 10) return { tpPercent: 1.0, slPercent: 0.5 };
  if (maxLeverage <= 20) return { tpPercent: 0.9, slPercent: 0.45 };
  if (maxLeverage <= 30) return { tpPercent: 0.85, slPercent: 0.45 };
  if (maxLeverage <= 50) return { tpPercent: 0.8, slPercent: 0.4 };
  if (maxLeverage <= 75) return { tpPercent: 0.8, slPercent: 0.4 };
  return { tpPercent: 0.75, slPercent: 0.38 };
}

/** @deprecated Use tpslBandForLeverage — kept for callers expecting max-only caps. */
function maxTpslPriceMoveForLeverage(maxLeverage: number): { tpPercent: number; slPercent: number } {
  const band = tpslBandForLeverage(maxLeverage);
  return { tpPercent: band.tpMax, slPercent: band.slMax };
}

/** Enforce minimum 1.5:1 reward:risk — raises tpPercent to meet the floor. */
export function enforceRR(config: {
  tpPercent: number;
  slPercent: number;
}): { tpPercent: number; slPercent: number } {
  const minTp = Math.round(config.slPercent * MIN_RR * 10_000) / 10_000;
  if (config.tpPercent >= minTp) return config;
  return { tpPercent: minTp, slPercent: config.slPercent };
}

/** Band clamp + R:R enforcement for automated strategy TP/SL. */
function clampStrategyTpsl(config: StrategyConfig): StrategyConfig {
  const band = tpslBandForLeverage(config.maxLeverage);

  let tp = Math.min(band.tpMax, Math.max(band.tpMin, config.tpPercent));
  let sl = Math.min(band.slMax, Math.max(band.slMin, config.slPercent));

  const enforced = enforceRR({ tpPercent: tp, slPercent: sl });
  tp = enforced.tpPercent;

  if (tp > band.tpMax) {
    tp = band.tpMax;
    sl = Math.round((tp / MIN_RR) * 10_000) / 10_000;
    sl = Math.max(sl, band.slMin);
  }

  return { ...config, tpPercent: tp, slPercent: sl };
}

/**
 * Tactical Alpha v1 baseline ("Normal Tactical Alpha", §10.2) — the proven
 * default a vague/empty prompt falls back to, and the starting point the AI
 * mutates. Conservative-to-moderate by design so nobody gets a degenerate
 * default.
 */
const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  version: 1,
  enabledStrategies: [
    "breakout_continuation",
    "trend_pullback",
    "funding_basis_momentum",
    "superburst",
  ],
  pairs: ["SOL-USD", "ETH-USD"],
  riskPerTradePct: 0.5,
  maxLeverage: 3,
  maxNotionalPctEquity: 40,
  dailyDrawdownStopPct: 5,
  lossStreakCooldown: true,
  regimeFilters: { antiChop: true, tradeChop: false },
  alphaCrush: false,
  tpPercent: 1.2,
  slPercent: 0.6,
  defaultCollateralUsdc: 25,
};

function clampNumber(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, v));
}

function parseSmokeTest(raw: unknown): StrategySmokeTest | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const side = o.side === "short" ? "short" : o.side === "long" ? "long" : undefined;
  if (!side) return undefined;
  const out: StrategySmokeTest = { side };
  if (typeof o.tpPercent === "number" && Number.isFinite(o.tpPercent)) {
    out.tpPercent = clampNumber(
      o.tpPercent,
      STRATEGY_RAILS.tpPercent.min,
      STRATEGY_RAILS.tpPercent.max,
      5,
    );
  }
  if (typeof o.slPercent === "number" && Number.isFinite(o.slPercent)) {
    out.slPercent = clampNumber(
      o.slPercent,
      STRATEGY_RAILS.slPercent.min,
      STRATEGY_RAILS.slPercent.max,
      3,
    );
  }
  return out;
}

/**
 * Clamp any (possibly AI-generated, possibly partial) config to the Tactical
 * Alpha rails and fill gaps from the baseline. Guarantees a safe, valid config
 * regardless of what the prompt asked for. Never throws.
 */
export function clampToRails(input: Partial<StrategyConfig> | null | undefined): StrategyConfig {
  const base = DEFAULT_STRATEGY_CONFIG;
  const cfg = input ?? {};

  const enabled = Array.isArray(cfg.enabledStrategies)
    ? cfg.enabledStrategies.filter((s): s is StrategyId => ALL_STRATEGY_IDS.includes(s as StrategyId))
    : [];
  const pairs = Array.isArray(cfg.pairs)
    ? cfg.pairs
        .map((p) => String(p).toUpperCase().trim())
        .map((p) => (p.includes("-") ? p : `${p}-USD`))
        .filter((p) => ALLOWED_STRATEGY_PAIRS.includes(p))
    : [];

  const enabledFinal = enabled.length ? Array.from(new Set(enabled)) : base.enabledStrategies;
  // Alpha Crush is on if explicitly flagged OR listed as an enabled mode.
  const alphaCrush = Boolean(cfg.alphaCrush) || enabledFinal.includes("alpha_crush");
  const smokeTest = parseSmokeTest(cfg.smokeTest);
  const tradeDirection: StrategyConfig["tradeDirection"] =
    cfg.tradeDirection === "long" || cfg.tradeDirection === "short"
      ? cfg.tradeDirection
      : cfg.tradeDirection === "adaptive"
        ? "adaptive"
        : undefined;

  const maxLeverage = clampNumber(
    cfg.maxLeverage,
    STRATEGY_RAILS.maxLeverage.min,
    STRATEGY_RAILS.maxLeverage.max,
    base.maxLeverage,
  );
  const tpslDefault = defaultTpslFromLeverage(maxLeverage);
  const tpPercent = clampNumber(
    cfg.tpPercent,
    STRATEGY_RAILS.tpPercent.min,
    STRATEGY_RAILS.tpPercent.max,
    tpslDefault.tpPercent,
  );
  const slPercent = clampNumber(
    cfg.slPercent,
    STRATEGY_RAILS.slPercent.min,
    STRATEGY_RAILS.slPercent.max,
    tpslDefault.slPercent,
  );
  const defaultCollateralUsdc = clampNumber(
    cfg.defaultCollateralUsdc,
    STRATEGY_RAILS.defaultCollateralUsdc.min,
    STRATEGY_RAILS.defaultCollateralUsdc.max,
    base.defaultCollateralUsdc,
  );

  const draft: StrategyConfig = {
    version: 1,
    enabledStrategies: enabledFinal,
    pairs: pairs.length ? Array.from(new Set(pairs)) : base.pairs,
    riskPerTradePct: clampNumber(
      cfg.riskPerTradePct,
      STRATEGY_RAILS.riskPerTradePct.min,
      STRATEGY_RAILS.riskPerTradePct.max,
      base.riskPerTradePct,
    ),
    maxLeverage,
    maxNotionalPctEquity: clampNumber(
      cfg.maxNotionalPctEquity,
      STRATEGY_RAILS.maxNotionalPctEquity.min,
      STRATEGY_RAILS.maxNotionalPctEquity.max,
      base.maxNotionalPctEquity,
    ),
    dailyDrawdownStopPct: clampNumber(
      cfg.dailyDrawdownStopPct,
      STRATEGY_RAILS.dailyDrawdownStopPct.min,
      STRATEGY_RAILS.dailyDrawdownStopPct.max,
      base.dailyDrawdownStopPct,
    ),
    lossStreakCooldown: true,
    regimeFilters: { antiChop: true, tradeChop: false },
    alphaCrush,
    tpPercent,
    slPercent,
    defaultCollateralUsdc,
    ...(tradeDirection ? { tradeDirection } : {}),
    ...(smokeTest ? { smokeTest } : {}),
  };

  return clampStrategyTpsl(draft);
}
