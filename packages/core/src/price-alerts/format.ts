import type { AlertMetric, TokenCandidate } from "./types.js";

/** Format a USD price with sensible precision for both blue-chips and microcaps. */
export function formatUsdPrice(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  if (value >= 1) {
    return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  }
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  // Microcaps: keep enough significant digits to be meaningful.
  return `$${value.toPrecision(3)}`;
}

/** Format a large USD figure compactly, e.g. $1.04M, $2.3B. */
export function formatUsdCompact(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  const units: Array<[number, string]> = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) return `$${(value / size).toFixed(2)}${suffix}`;
  }
  return `$${value.toFixed(2)}`;
}

export function formatMetricValue(value: number, metric: AlertMetric): string {
  return metric === "market_cap_usd"
    ? formatUsdCompact(value)
    : formatUsdPrice(value);
}

export function metricLabel(metric: AlertMetric): string {
  return metric === "market_cap_usd" ? "market cap" : "price";
}

/** Build the confirmation shown after an alert is saved. */
export function formatConfirmation(args: {
  symbol: string;
  metric: AlertMetric;
  direction: "above" | "below";
  targetValue: number;
  currentValue: number;
  isGroup: boolean;
}): string {
  const { symbol, metric, direction, targetValue, currentValue, isGroup } = args;
  const verb = direction === "above" ? "rises to" : "drops to";
  const label = metricLabel(metric);
  const target = formatMetricValue(targetValue, metric);
  const current = formatMetricValue(currentValue, metric);

  const lines = [
    `Got it. I'll DM you when ${symbol} ${label} ${verb} ${target}.`,
    `Current ${label}: ${current}.`,
  ];
  if (isGroup) {
    lines.push("I'll send the alert to your DM, not this group.");
  }
  return lines.join(" ");
}

/** Build the message delivered when an alert fires. */
export function formatTrigger(args: {
  symbol: string;
  metric: AlertMetric;
  direction: "above" | "below";
  targetValue: number;
  currentValue: number;
}): string {
  const { symbol, metric, direction, targetValue, currentValue } = args;
  const label = metricLabel(metric);
  const crossed = direction === "above" ? "crossed above" : "dropped below";
  return (
    `Price alert hit: ${symbol} ${label} ${crossed} ` +
    `${formatMetricValue(targetValue, metric)}. ` +
    `Current ${label}: ${formatMetricValue(currentValue, metric)}.`
  );
}

/** Ask for a contract address when a symbol matches multiple tokens. */
export function formatAmbiguous(
  symbol: string,
  candidates: TokenCandidate[],
): string {
  const lines = [
    `I found multiple tokens matching ${symbol}. Please send the contract address for the one you want to track.`,
  ];
  const listed = candidates.slice(0, 5);
  if (listed.length > 0) {
    lines.push("");
    for (const c of listed) {
      const name = c.name ? `${c.name} ` : "";
      const chain = c.chainId ? ` on ${c.chainId}` : "";
      lines.push(`- ${name}(${c.symbol})${chain}: ${c.tokenAddress}`);
    }
  }
  return lines.join("\n");
}
