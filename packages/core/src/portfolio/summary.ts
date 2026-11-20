import type { ImessagePortfolioPayload } from "./types.js";

const MIN_VISIBLE_COIN_USD = 0.01;

function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "value unavailable";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: value >= 1 ? 2 : 4,
    maximumFractionDigits: value >= 1 ? 2 : 4,
  })}`;
}

function trimAmount(value: string | number | null | undefined, decimals?: number | null): string {
  if (value == null) return "";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  const maxFractionDigits =
    decimals != null ? Math.min(decimals, 6) : n >= 1 ? 4 : 6;
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFractionDigits });
}

type WalletBucket = "baseApp" | "server";

type BucketTotals = Record<WalletBucket, {
  coinsUsd: number;
  perpsUsd: number;
  vaultsUsd: number;
  totalUsd: number;
}>;

export function classifyWalletBucket(label: string | null | undefined): WalletBucket {
  return label?.toLowerCase().includes("base app") ? "baseApp" : "server";
}

export function computeBucketTotals(portfolio: ImessagePortfolioPayload): BucketTotals {
  const totals: BucketTotals = {
    baseApp: { coinsUsd: 0, perpsUsd: 0, vaultsUsd: 0, totalUsd: 0 },
    server: { coinsUsd: 0, perpsUsd: 0, vaultsUsd: 0, totalUsd: 0 },
  };

  const bucketForWallet = (walletAddress: string): WalletBucket => {
    const label = portfolio.user.walletLabels[walletAddress.toLowerCase()];
    return classifyWalletBucket(label);
  };

  for (const coin of portfolio.coins) {
    const bucket = bucketForWallet(coin.walletAddress);
    totals[bucket].coinsUsd += coin.valueUsd;
    totals[bucket].totalUsd += coin.valueUsd;
  }
  for (const position of portfolio.perpetuals) {
    const bucket = bucketForWallet(position.walletAddress);
    totals[bucket].perpsUsd += position.valueUsd;
    totals[bucket].totalUsd += position.valueUsd;
  }
  for (const position of portfolio.staking) {
    const value = position.valueUsd ?? 0;
    const bucket = bucketForWallet(position.walletAddress);
    totals[bucket].vaultsUsd += value;
    totals[bucket].totalUsd += value;
  }

  return totals;
}

function bucketLine(label: string, totals: BucketTotals[WalletBucket]): string {
  return `${label}: ${formatUsd(totals.totalUsd)} (funds ${formatUsd(totals.coinsUsd)} · perps ${formatUsd(totals.perpsUsd)} · vaults ${formatUsd(totals.vaultsUsd)})`;
}

function segmentedBalanceLines(portfolio: ImessagePortfolioPayload): string[] {
  const totals = computeBucketTotals(portfolio);
  if (totals.baseApp.totalUsd <= 0 || totals.server.totalUsd <= 0) return [];
  return [
    "By account:",
    bucketLine("Base App", totals.baseApp),
    bucketLine("Basemate (server)", totals.server),
    "",
  ];
}

function stakingPositionLine(position: ImessagePortfolioPayload["staking"][number]): string {
  const amount = position.amount == null ? "" : `${trimAmount(position.amount, position.decimals)} `;
  const apy = position.apy == null ? "" : ` at ${position.apy.toFixed(2)}% APY`;
  return `- ${position.protocol} ${amount}${position.asset} (${formatUsd(position.valueUsd)})${apy}`;
}

export function formatCoinsSummaryForImessage(
  portfolio: ImessagePortfolioPayload,
): string {
  const hasUnpricedCoins = portfolio.coins.some(
    (coin) => coin.priceUsd == null && Number(coin.amount) > 0,
  );
  const lines = [
    hasUnpricedCoins
      ? `Your priced assets are about ${formatUsd(portfolio.totals.totalUsd)}. Some coin values are unavailable.`
      : `Your portfolio is about ${formatUsd(portfolio.totals.totalUsd)}.`,
    "",
    ...segmentedBalanceLines(portfolio),
    "Top coins:",
  ];
  const eligibleCoins = portfolio.coins.filter(
    (coin) =>
      coin.valueUsd >= MIN_VISIBLE_COIN_USD ||
      (coin.priceUsd == null && Number(coin.amount) > 0),
  );
  const visible = eligibleCoins.slice(0, 5);
  if (visible.length === 0) {
    lines.push("- No tracked Base coin balances yet.");
  } else {
    for (const coin of visible) {
      const value = coin.priceUsd === null ? "value unavailable" : formatUsd(coin.valueUsd);
      lines.push(`- ${trimAmount(coin.amount)} ${coin.symbol} (${value})`);
    }
    if (eligibleCoins.length > visible.length) {
      lines.push(`- ${eligibleCoins.length - visible.length} more coin${eligibleCoins.length - visible.length === 1 ? "" : "s"}`);
    }
  }

  if (portfolio.totals.stakingUsd > 0 || portfolio.staking.length > 0) {
    lines.push("", `Staking & lending: ${formatUsd(portfolio.totals.stakingUsd)}`);
    const stakingVisible = portfolio.staking.slice(0, 2);
    for (const position of stakingVisible) {
      lines.push(stakingPositionLine(position));
    }
    if (portfolio.staking.length > stakingVisible.length) {
      lines.push(
        `- ${portfolio.staking.length - stakingVisible.length} more staking position${portfolio.staking.length - stakingVisible.length === 1 ? "" : "s"}`,
      );
    }
  }
  return lines.join("\n");
}

function formatPerpPositionBlock(
  position: ImessagePortfolioPayload["perpetuals"][number],
  displayIndex: number,
): string {
  const side = position.side ? ` ${position.side.toUpperCase()}` : "";
  const lev = position.leverage ? ` ${position.leverage}x` : "";
  const spent = position.collateralUsd != null
    ? formatUsd(position.collateralUsd)
    : formatUsd(position.valueUsd);
  const notional = position.sizeUsd != null ? ` (notional: ${formatUsd(position.sizeUsd)})` : "";
  const pnl = position.pnlUsd != null ? formatUsd(position.pnlUsd) : "unavailable";
  const sl = position.stopLoss ?? "not set";
  const tp = position.takeProfit ?? "not set";
  return [
    `#${displayIndex} ${position.pair}${side}${lev}`,
    `Spent: ${spent}${notional}`,
    `PnL: ${pnl}`,
    `SL: ${sl} · TP: ${tp}`,
  ].join("\n");
}

export function formatPerpsSummaryForImessage(
  portfolio: ImessagePortfolioPayload,
): string {
  const total = portfolio.perpetuals.length;
  if (total === 0) {
    return "No open or limit perp positions right now.";
  }

  const count = `You have ${total} open perp position${total === 1 ? "" : "s"}.`;
  const visible = portfolio.perpetuals.slice(0, 3);
  const blocks = visible.map((pos, i) => formatPerpPositionBlock(pos, i + 1));
  const lines = [count, "", ...blocks.join("\n\n").split("\n")];

  const remaining = total - visible.length;
  if (remaining > 0) {
    lines.push("", `${remaining} more position${remaining === 1 ? "" : "s"} on the full page.`);
  }

  return lines.join("\n");
}

export function formatStakingSummaryForImessage(
  portfolio: ImessagePortfolioPayload,
): string {
  const lines = [
    `Staking and lending total: ${formatUsd(portfolio.totals.stakingUsd)}.`,
    "",
  ];
  const top = portfolio.staking[0];
  if (!top) {
    lines.push("No active Morpho, Moonwell, or Aave positions found right now.");
  } else {
    lines.push(
      `Largest position: ${stakingPositionLine(top).slice(2)}`,
    );
    if (portfolio.staking.length > 1) {
      lines.push(`${portfolio.staking.length - 1} more staking position${portfolio.staking.length - 1 === 1 ? "" : "s"} on the full page.`);
    }
  }
  return lines.join("\n");
}
