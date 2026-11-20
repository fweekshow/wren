import { describeStrategyModes } from "@basemate/shared";

import type { StrategyRow, StrategyStatus } from "@/discovery/adapters/strategy.adapter.js";
import type { StrategyPnlSnapshot } from "@/discovery/strategy/pnlSync.js";
import { resolveEffectiveTpslPercents } from "@/discovery/strategy/tpsl.js";

import type { PnlState, StrategyCardVM, StrategyListItemVM, StrategyMode } from "./ux.js";

/** Statuses shown in Telegram lists (draft/archived are hidden). */
const VISIBLE_STATUSES: StrategyStatus[] = ["paper", "testing", "publishable", "published"];

export function isVisibleStrategy(row: StrategyRow): boolean {
  return VISIBLE_STATUSES.includes(row.status);
}

export function strategyMode(row: StrategyRow): StrategyMode {
  return row.status === "paper" ? "paper" : "live";
}

function pnlStateFor(row: StrategyRow, snapshot: StrategyPnlSnapshot): PnlState {
  if (row.status === "paper") return "paper";
  if (snapshot.openCount > 0) return "live_open";
  if (snapshot.closedCount > 0) return "live_closed_final";
  // Live but nothing closed/open yet — show mark state (0) rather than settled.
  return "live_open";
}

function pnlValue(snapshot: StrategyPnlSnapshot): number {
  return snapshot.realized + snapshot.unrealized;
}

export function toListItemVM(row: StrategyRow, snapshot: StrategyPnlSnapshot): StrategyListItemVM {
  return {
    strategyId: row.id,
    name: row.name,
    mode: strategyMode(row),
    version: row.config.version ?? null,
    pnlUsd: pnlValue(snapshot),
    pnlState: pnlStateFor(row, snapshot),
  };
}

export function toCardVM(row: StrategyRow, snapshot: StrategyPnlSnapshot): StrategyCardVM {
  const margin =
    row.default_collateral_usdc != null
      ? Number(row.default_collateral_usdc)
      : row.config.defaultCollateralUsdc;
  const { tpPercent, slPercent, configSlPercent } = resolveEffectiveTpslPercents(row.config);
  return {
    strategyId: row.id,
    name: row.name,
    mode: strategyMode(row),
    version: row.config.version ?? null,
    pairs: row.config.pairs,
    direction: row.config.tradeDirection ?? "adaptive",
    marginUsdc: margin,
    leverage: row.config.maxLeverage,
    tpPercent,
    slPercent: configSlPercent,
    effectiveSlPercent: slPercent,
    slCapped: configSlPercent > slPercent,
    walletAddress: row.execution_wallet_address,
    pnlUsd: pnlValue(snapshot),
    pnlState: pnlStateFor(row, snapshot),
    modes: describeStrategyModes(row.config).map((m) => ({
      label: m.label,
      blurb: m.blurb,
      live: m.live,
    })),
    antiChop: row.config.regimeFilters?.antiChop ?? false,
    alphaCrush: row.config.alphaCrush ?? false,
  };
}
