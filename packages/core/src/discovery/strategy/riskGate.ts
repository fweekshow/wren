import {
  isAllowedStrategyPair,
  STRATEGY_MIN_NOTIONAL_USD,
  type StrategyConfig,
} from "@basemate/shared";

import { directionAllows } from "./signals.js";

/** Consecutive live losses that trip the loss-streak cooldown. */
export const LOSS_STREAK_LIMIT = 3;
/** How long new entries stay paused after the loss streak trips. */
export const LOSS_STREAK_COOLDOWN_MS = 60 * 60 * 1000;
/** Minimum time between entries on the same pair. */
export const ENTRY_COOLDOWN_MS = 15 * 60 * 1000;
/** Max new entries per strategy per UTC day (paper + live). */
export const MAX_ENTRIES_PER_DAY = 8;

export type RiskGateCode =
  | "ok"
  | "direction_mismatch"
  | "pair_not_configured"
  | "pair_not_allowed"
  | "min_notional"
  | "max_notional_pct_equity"
  | "daily_drawdown_stop"
  | "loss_streak_cooldown"
  | "duplicate_exposure"
  | "entry_cooldown"
  | "max_entries_per_day";

export interface RiskGateClosedTrade {
  pnlUsd: number;
  closedAt: Date | null;
}

export interface RiskGateInputs {
  config: StrategyConfig;
  signal: { pair: string; side: "long" | "short" };
  collateralUsdc: number;
  /** Strategy execution-wallet USDC equity. `null` when unknown (equity checks are skipped). */
  equityUsd: number | null;
  /** Sum of realized PnL for live trades closed since UTC midnight (losses are negative). */
  todayRealizedPnlUsd: number;
  /** Most-recent-first realized PnL + close time of closed live trades. */
  recentClosedTrades: RiskGateClosedTrade[];
  /** Pairs that already have an open live position for this strategy. */
  openPairs: string[];
  /** Most recent entry (open) on this pair — for entry cooldown. */
  lastEntryAtMs?: number | null;
  /** Entries opened today (UTC) — for daily cap. */
  entriesToday?: number;
  /** Evaluation time (injectable for tests). */
  now?: number;
}

export interface RiskGateDecision {
  ok: boolean;
  code: RiskGateCode;
  reason?: string;
}

const PASS: RiskGateDecision = { ok: true, code: "ok" };

function normalizePair(pair: string): string {
  const p = pair.toUpperCase().trim();
  return p.includes("-") ? p : `${p}-USD`;
}

/**
 * Pre-entry risk gate — the single source of truth for whether a live entry is
 * allowed. Pure and deterministic: the runner gathers inputs (equity, today's
 * PnL, recent closes, open pairs) and this decides. Every advertised control is
 * enforced here so the UI never promises something execution ignores.
 */
export function evaluateEntryRiskGate(input: RiskGateInputs): RiskGateDecision {
  const { config, signal, collateralUsdc } = input;
  const now = input.now ?? Date.now();
  const pair = normalizePair(signal.pair);

  // 1) Direction (long-only / short-only). Defense-in-depth vs signals.ts.
  if (!directionAllows(config, signal.side)) {
    return {
      ok: false,
      code: "direction_mismatch",
      reason: `strategy is ${config.tradeDirection}-only; ${signal.side} signal blocked`,
    };
  }

  // 2) Pair must be configured for this strategy and executable in v1.
  const configuredPairs = config.pairs.map(normalizePair);
  if (!configuredPairs.includes(pair)) {
    return { ok: false, code: "pair_not_configured", reason: `${pair} not in strategy pairs` };
  }
  if (!isAllowedStrategyPair(pair)) {
    return { ok: false, code: "pair_not_allowed", reason: `${pair} not executable in v1` };
  }

  // 3) No second live position on a pair we already hold.
  if (input.openPairs.map(normalizePair).includes(pair)) {
    return { ok: false, code: "duplicate_exposure", reason: `live position already open on ${pair}` };
  }

  const freq = evaluateEntryFrequencyGate({
    pair,
    lastEntryAtMs: input.lastEntryAtMs,
    entriesToday: input.entriesToday,
    openPairs: [],
    now,
  });
  if (!freq.ok) return freq;

  // 4) Minimum notional (~$100 Avantis floor).
  const leverage = Math.max(1, config.maxLeverage);
  const notional = collateralUsdc * leverage;
  if (notional < STRATEGY_MIN_NOTIONAL_USD) {
    return {
      ok: false,
      code: "min_notional",
      reason: `notional $${notional.toFixed(0)} < $${STRATEGY_MIN_NOTIONAL_USD} min`,
    };
  }

  // 5) Loss-streak cooldown: N consecutive losing closes within the window.
  if (config.lossStreakCooldown) {
    const streak = leadingLossStreak(input.recentClosedTrades);
    if (streak.count >= LOSS_STREAK_LIMIT && streak.mostRecentCloseMs != null) {
      const elapsed = now - streak.mostRecentCloseMs;
      if (elapsed < LOSS_STREAK_COOLDOWN_MS) {
        const mins = Math.ceil((LOSS_STREAK_COOLDOWN_MS - elapsed) / 60000);
        return {
          ok: false,
          code: "loss_streak_cooldown",
          reason: `${streak.count} losses in a row — cooling down ~${mins}m`,
        };
      }
    }
  }

  // Equity-relative checks only run when we know the wallet balance.
  if (input.equityUsd != null && Number.isFinite(input.equityUsd) && input.equityUsd > 0) {
    // 6) Max notional as % of equity.
    const maxNotional = (config.maxNotionalPctEquity / 100) * input.equityUsd;
    if (notional > maxNotional) {
      return {
        ok: false,
        code: "max_notional_pct_equity",
        reason: `notional $${notional.toFixed(0)} > ${config.maxNotionalPctEquity}% of $${input.equityUsd.toFixed(0)} equity`,
      };
    }

    // 7) Daily drawdown stop. Approximate day-start equity by adding back today's
    //    realized loss to current equity, then block if the loss breaches the pct.
    const lossToday = Math.max(0, -input.todayRealizedPnlUsd);
    if (lossToday > 0) {
      const dayStartEquity = input.equityUsd + lossToday;
      const drawdownPct = dayStartEquity > 0 ? (lossToday / dayStartEquity) * 100 : 0;
      if (drawdownPct >= config.dailyDrawdownStopPct) {
        return {
          ok: false,
          code: "daily_drawdown_stop",
          reason: `down ${drawdownPct.toFixed(1)}% today ≥ ${config.dailyDrawdownStopPct}% stop`,
        };
      }
    }
  }

  return PASS;
}

/** Count leading consecutive losses (pnl < 0) from the most-recent-first list. */
function leadingLossStreak(trades: RiskGateClosedTrade[]): {
  count: number;
  mostRecentCloseMs: number | null;
} {
  let count = 0;
  let mostRecentCloseMs: number | null = null;
  for (const t of trades) {
    if (t.pnlUsd < 0) {
      if (count === 0 && t.closedAt) mostRecentCloseMs = t.closedAt.getTime();
      count += 1;
    } else {
      break;
    }
  }
  return { count, mostRecentCloseMs };
}

/** Shared entry-frequency guardrails (paper + live). */
export function evaluateEntryFrequencyGate(input: {
  pair: string;
  lastEntryAtMs?: number | null;
  entriesToday?: number;
  openPairs?: string[];
  now?: number;
}): RiskGateDecision {
  const now = input.now ?? Date.now();
  const pair = normalizePair(input.pair);

  if (input.openPairs?.map(normalizePair).includes(pair)) {
    return { ok: false, code: "duplicate_exposure", reason: `position already open on ${pair}` };
  }

  if (input.lastEntryAtMs != null && Number.isFinite(input.lastEntryAtMs)) {
    const elapsed = now - input.lastEntryAtMs;
    if (elapsed < ENTRY_COOLDOWN_MS) {
      const mins = Math.ceil((ENTRY_COOLDOWN_MS - elapsed) / 60000);
      return {
        ok: false,
        code: "entry_cooldown",
        reason: `entry cooldown ~${mins}m remaining on ${pair}`,
      };
    }
  }

  if (input.entriesToday != null && input.entriesToday >= MAX_ENTRIES_PER_DAY) {
    return {
      ok: false,
      code: "max_entries_per_day",
      reason: `max ${MAX_ENTRIES_PER_DAY} entries/day reached`,
    };
  }

  return PASS;
}
