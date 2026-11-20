import type { StrategyRow } from "@/discovery/adapters/strategy.adapter.js";

/** Minimum track record before a strategy can move to publishable. */
export const PUBLISH_GATE = {
  minTrades: 5,
  minDaysLive: 3,
  minRealizedPnlUsd: 0,
  maxDrawdownPct: 15,
} as const;

/**
 * Minimum CLOSED trades before a user can manually publish (list) a strategy.
 * Lighter than the full PUBLISH_GATE — just enough real history that a 0-trade
 * strategy can't be listed and mislead followers.
 */
export const PUBLISH_MIN_CLOSED_TRADES = 3;

export interface PublishGateResult {
  ok: boolean;
  reasons: string[];
}

export function checkPublishGate(row: StrategyRow): PublishGateResult {
  const reasons: string[] = [];
  const trades = row.trade_count ?? 0;
  const days = row.days_live ?? 0;
  const pnl = Number(row.realized_pnl_usd ?? 0);
  const dd = Number(row.max_drawdown_pct ?? 0);

  if (trades < PUBLISH_GATE.minTrades) {
    reasons.push(`need ${PUBLISH_GATE.minTrades}+ trades (have ${trades})`);
  }
  if (days < PUBLISH_GATE.minDaysLive) {
    reasons.push(`need ${PUBLISH_GATE.minDaysLive}+ days live (have ${days})`);
  }
  if (pnl < PUBLISH_GATE.minRealizedPnlUsd) {
    reasons.push(`need positive realized pnl (have $${pnl.toFixed(2)})`);
  }
  if (dd > PUBLISH_GATE.maxDrawdownPct) {
    reasons.push(`max drawdown ${dd.toFixed(1)}% exceeds ${PUBLISH_GATE.maxDrawdownPct}%`);
  }

  return { ok: reasons.length === 0, reasons };
}
