import type { StrategyConfig } from "@basemate/shared";

/**
 * Effective SL percent: capped so the SL fires before Avantis liquidates.
 * Liquidation triggers at 100% collateral loss = (1/leverage)% price move.
 * We require the SL to fire at most 80% of that distance so there's margin for
 * oracle lag and slippage. This silently corrects configs with wide SLs (e.g.
 * slPercent: 80 at 75x leverage, which is 9× past the liquidation price).
 *
 * Shared by live prep, paper simulation, and previews so all three resolve the
 * exact same exit — paper and live must never diverge on where the SL fires.
 */
export function effectiveSlPercent(configSlPercent: number, leverage: number): number {
  if (leverage <= 0) return configSlPercent;
  const liquidationPct = (1 / leverage) * 100;
  const maxSafeSl = liquidationPct * 0.8;
  return Math.min(configSlPercent, maxSafeSl);
}

export interface EffectiveTpsl {
  tpPercent: number;
  /** SL percent after the liquidation-buffer cap (the value actually enforced). */
  slPercent: number;
  /** SL percent as authored, before the cap — for previews/diagnostics. */
  configSlPercent: number;
}

/**
 * Resolve the effective TP/SL percents a strategy will actually trade with:
 * applies the smoke-test one-shot override, then the liquidation-buffer SL cap.
 * The single source of truth for previews, paper close thresholds, and the live
 * on-chain TP/SL prices.
 */
export function resolveEffectiveTpslPercents(config: StrategyConfig): EffectiveTpsl {
  const tpPercent = config.smokeTest?.tpPercent ?? config.tpPercent;
  const configSlPercent = config.smokeTest?.slPercent ?? config.slPercent;
  const leverage = Math.max(1, Math.round(config.maxLeverage));
  return {
    tpPercent,
    slPercent: effectiveSlPercent(configSlPercent, leverage),
    configSlPercent,
  };
}

/** Display-only: ROI on margin ≈ price-move % × leverage (v1 stores price move). */
export function marginRoiFromPriceMovePct(priceMovePct: number, leverage: number): number {
  const lev = Math.max(1, Math.round(leverage));
  return Math.round(priceMovePct * lev * 100) / 100;
}

export interface TpslMarginDisplay {
  tpMarginPct: number;
  slMarginPct: number;
  leverage: number;
  slCapped: boolean;
}

/** Build margin-first TP/SL labels from effective price-move percents (P5a display). */
export function buildTpslMarginDisplay(args: {
  tpPricePct: number;
  slPricePct: number;
  leverage: number;
  slCapped?: boolean;
}): TpslMarginDisplay {
  const leverage = Math.max(1, Math.round(args.leverage));
  return {
    tpMarginPct: marginRoiFromPriceMovePct(args.tpPricePct, leverage),
    slMarginPct: marginRoiFromPriceMovePct(args.slPricePct, leverage),
    leverage,
    slCapped: args.slCapped ?? false,
  };
}

/** Short Telegram line — primary read is ROI on margin, not price move. */
export function formatTpslOnMarginShort(d: TpslMarginDisplay): string {
  const cap = d.slCapped ? " · SL capped" : "";
  return `TP +${d.tpMarginPct}% · SL -${d.slMarginPct}% on margin · ${d.leverage}x${cap}`;
}
