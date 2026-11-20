import type { StrategyRow } from "@/discovery/adapters/strategy.adapter.js";
import { fetchAvantisMarkPrice } from "@basemate/avantis-client";

import { formatStrategySpec } from "./promptStrategy.js";
import { getMarkSamples } from "./priceHistory.js";
import {
  evaluateOracleDiagnostics,
  ORACLE_MIN_SAMPLES,
  type OracleDiagnostics,
  type SignalBlockReason,
} from "./signals.js";
import { resolveEffectiveTpslPercents } from "./tpsl.js";

export interface StrategyTechnicals {
  strategyId: string;
  name: string;
  status: string;
  lastEvalAgeSec: number | null;
  tradeCount: number;
  pairs: OracleDiagnostics[];
  configSpec: string;
  direction: string;
  antiChop: boolean;
  marginUsdc: number;
  leverage: number;
  tpPercent: number;
  slPercent: number;
  effectiveSlPercent: number;
  slCapped: boolean;
  riskPerTradePct: number;
  dailyDrawdownStopPct: number;
  lossStreakCooldown: boolean;
}

function blockReasonLabel(reason: SignalBlockReason | null, signal: OracleDiagnostics["signal"]): string {
  if (signal) return `would fire · ${signal.mode} ${signal.side}`;
  switch (reason) {
    case "warmup":
      return `warmup · need ${ORACLE_MIN_SAMPLES} samples`;
    case "true_chop":
      return "true chop · antiChop blocked";
    case "below_min_tradeable_range":
      return "range below cost floor";
    case "no_executable_modes":
      return "no executable modes";
    case "direction_blocked":
      return "direction filter blocked";
    case "no_mode_match":
      return "no mode match";
    default:
      return "signal NONE";
  }
}

function pairBase(pair: string): string {
  return pair.split("-")[0] ?? pair;
}

export async function buildStrategyTechnicals(row: StrategyRow): Promise<StrategyTechnicals> {
  const margin =
    row.default_collateral_usdc != null
      ? Number(row.default_collateral_usdc)
      : row.config.defaultCollateralUsdc;
  const { tpPercent, slPercent, configSlPercent } = resolveEffectiveTpslPercents(row.config);
  const lastEvalAgeSec =
    row.last_eval_at != null
      ? Math.max(0, Math.round((Date.now() - row.last_eval_at.getTime()) / 1000))
      : null;

  const pairs: OracleDiagnostics[] = [];
  for (const pair of row.config.pairs) {
    const base = pairBase(pair);
    const mark = await fetchAvantisMarkPrice(base).catch(() => null);
    const samples = await getMarkSamples(pair);
    const price = mark ?? samples[samples.length - 1]?.price ?? 0;
    pairs.push(
      evaluateOracleDiagnostics(
        { pair, price, samples, config: row.config },
        { pairTicked: true },
      ),
    );
  }

  return {
    strategyId: row.id,
    name: row.name,
    status: row.status,
    lastEvalAgeSec,
    tradeCount: row.trade_count,
    pairs,
    configSpec: formatStrategySpec(row.config),
    direction: row.config.tradeDirection ?? "adaptive",
    antiChop: row.config.regimeFilters?.antiChop ?? false,
    marginUsdc: margin,
    leverage: row.config.maxLeverage,
    tpPercent,
    slPercent,
    effectiveSlPercent: slPercent,
    slCapped: configSlPercent > slPercent,
    riskPerTradePct: row.config.riskPerTradePct,
    dailyDrawdownStopPct: row.config.dailyDrawdownStopPct,
    lossStreakCooldown: row.config.lossStreakCooldown ?? false,
  };
}

export function formatPairTechnicalsLine(d: OracleDiagnostics): string {
  const mark = d.price > 0 ? `$${d.price.toFixed(2)}` : "—";
  const range = `${d.range12Pct.toFixed(2)}%`;
  const move5 = `${d.move5Pct >= 0 ? "+" : ""}${d.move5Pct.toFixed(2)}%`;
  const block = blockReasonLabel(d.blockReason, d.signal);
  return [
    `${d.pair} · mark ${mark} · ${d.sampleCount}/${ORACLE_MIN_SAMPLES} · range12 ${range} · move5 ${move5}`,
    `  regime ${d.regime}${d.isTrueChop ? " (true)" : ""} · ${block}`,
  ].join("\n");
}
