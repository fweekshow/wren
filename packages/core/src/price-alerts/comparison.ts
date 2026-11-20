import type { AlertDirection, AlertMetric, TokenQuote } from "./types.js";

/** Read the value the alert tracks (price or market cap) from a quote. */
export function valueForMetric(
  quote: TokenQuote,
  metric: AlertMetric,
): number | null {
  const value = metric === "market_cap_usd" ? quote.marketCapUsd : quote.priceUsd;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * When the user says "alert me when X hits N" without a direction, infer it
 * from where the value sits right now: below target → wait for it to rise
 * (above); at/above target → wait for it to fall (below).
 */
export function inferDirection(
  current: number,
  target: number,
): AlertDirection {
  return current < target ? "above" : "below";
}

/** True once the current value has crossed the target in the alert's direction. */
export function isTriggered(
  current: number,
  direction: AlertDirection,
  target: number,
): boolean {
  return direction === "above" ? current >= target : current <= target;
}
