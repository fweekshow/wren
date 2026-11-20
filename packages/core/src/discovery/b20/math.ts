import {
  V4_MAX_TICK,
  V4_MIN_TICK,
  V4_TICK_SPACING_MEDIUM,
} from "./addresses.js";

const Q96 = 2n ** 96n;

export function sqrtBigInt(n: bigint): bigint {
  if (n < 0n) throw new Error("sqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** Uniswap encodeSqrtRatioX96(amount1, amount0) — sqrt(amount1/amount0) * 2^96. */
export function encodeSqrtRatioX96(amount1: bigint, amount0: bigint): bigint {
  if (amount0 <= 0n || amount1 <= 0n) {
    throw new Error("sqrt price amounts must be positive");
  }
  return sqrtBigInt((amount1 << 192n) / amount0);
}

export function snapTick(tick: number, spacing = V4_TICK_SPACING_MEDIUM): number {
  const snapped = Math.floor(tick / spacing) * spacing;
  const min = Math.ceil(V4_MIN_TICK / spacing) * spacing;
  const max = Math.floor(V4_MAX_TICK / spacing) * spacing;
  return Math.min(max, Math.max(min, snapped));
}

export function getTickAtSqrtRatio(sqrtPriceX96: bigint): number {
  const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
  const price = sqrtPrice * sqrtPrice;
  if (!(price > 0) || !Number.isFinite(price)) {
    throw new Error("invalid sqrtPriceX96");
  }
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

export function tickToSqrtPriceX96(tick: number): bigint {
  const sqrtPrice = Math.pow(1.0001, tick / 2);
  const asNum = sqrtPrice * 2 ** 96;
  if (!Number.isFinite(asNum) || asNum <= 0) {
    throw new Error(`tick ${tick} overflowed sqrtPrice conversion`);
  }
  return BigInt(Math.floor(asNum));
}

export function getLiquidityForAmount0(
  sqrtA: bigint,
  sqrtB: bigint,
  amount0: bigint,
): bigint {
  const [lower, upper] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  const intermediate = (lower * upper) / Q96;
  return (amount0 * intermediate) / (upper - lower);
}

export function getLiquidityForAmount1(
  sqrtA: bigint,
  sqrtB: bigint,
  amount1: bigint,
): bigint {
  const [lower, upper] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  return (amount1 * Q96) / (upper - lower);
}

export function usdToTokenRaw(
  usdAmount: number,
  tokenUsd: number,
  decimals: number,
): bigint {
  if (!(usdAmount > 0) || !(tokenUsd > 0) || !Number.isFinite(usdAmount) || !Number.isFinite(tokenUsd)) {
    throw new Error("invalid USD amounts for launch price");
  }
  const scaled = Math.floor((usdAmount / tokenUsd) * 1e8);
  if (scaled <= 0) throw new Error("launch mcap too small vs stock price");
  if (decimals >= 8) return BigInt(scaled) * 10n ** BigInt(decimals - 8);
  return BigInt(scaled) / 10n ** BigInt(8 - decimals);
}

/**
 * Single-sided range so the position holds only `newToken` at the initial tick.
 * New token is currency0 → range [current, max]. Currency1 → [min, current].
 */
export function pickSingleSidedRange(input: {
  newIsCurrency0: boolean;
  currentTick: number;
  tickSpacing?: number;
}): { tickLower: number; tickUpper: number } {
  const spacing = input.tickSpacing ?? V4_TICK_SPACING_MEDIUM;
  const current = snapTick(input.currentTick, spacing);
  const min = snapTick(V4_MIN_TICK, spacing);
  const max = snapTick(V4_MAX_TICK, spacing);
  if (input.newIsCurrency0) {
    return { tickLower: Math.min(current, max - spacing), tickUpper: max };
  }
  return { tickLower: min, tickUpper: Math.max(current, min + spacing) };
}
