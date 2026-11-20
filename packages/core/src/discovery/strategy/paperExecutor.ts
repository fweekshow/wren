import { StrategyAdapter, type StrategyRow } from "@/discovery/adapters/strategy.adapter.js";

import { computePaperTradeOutcome } from "./costModel.js";
import type { TradeSignal } from "./signals.js";

/** Signed price-move % from entry, in the trade's favor. */
function favorMovePct(side: "long" | "short", openPrice: number, mark: number): number {
  const raw = ((mark - openPrice) / openPrice) * 100;
  return side === "long" ? raw : -raw;
}

/** Gross (frictionless) PnL in USD at the current mark (notional = collateral * leverage). */
function paperGrossPnlUsd(
  side: "long" | "short",
  openPrice: number,
  mark: number,
  collateralUsdc: number,
  maxLeverage: number,
): number {
  const notional = collateralUsdc * maxLeverage;
  return (favorMovePct(side, openPrice, mark) / 100) * notional;
}

function holdSeconds(createdAt: Date | null): number {
  if (!createdAt) return 0;
  return Math.max(0, (Date.now() - createdAt.getTime()) / 1000);
}

/** Paper trading is off. Ticks no longer open or manage virtual positions. */
export async function runPaperStrategyTick(_input: {
  row: StrategyRow;
  pair: string;
  mark: number;
  signal: TradeSignal | null;
  entriesToday?: number;
  openPaperPairs?: Set<string>;
}): Promise<void> {
  return;
}

/** Close every open paper trade at the current mark (used before Go Live promotion). */
export async function closeAllPaperTrades(
  row: StrategyRow,
  markByPair: Map<string, number>,
): Promise<void> {
  const openTrades = await StrategyAdapter.listOpenPaperTrades(row.id);
  const leverage = row.config.maxLeverage;
  for (const t of openTrades) {
    const mark = markByPair.get(t.pair) ?? t.open_price;
    const tradeLeverage = t.leverage ?? leverage;
    const grossPnl = paperGrossPnlUsd(t.side, t.open_price, mark, t.collateral_usdc, tradeLeverage);
    const outcome = computePaperTradeOutcome({
      grossPnlUsd: grossPnl,
      collateralUsdc: t.collateral_usdc,
      leverage: tradeLeverage,
      holdSeconds: holdSeconds(t.created_at),
    });
    await StrategyAdapter.closeTrade(t.id, outcome.netProtocolPnlUsd, {
      exitReason: "live_close",
      closePrice: mark,
    });
  }
  if (openTrades.length) await StrategyAdapter.setWikiDirty(row.id, true);
}
