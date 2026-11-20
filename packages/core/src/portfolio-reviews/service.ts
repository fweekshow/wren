import { resolveAllWalletsForUser, shortWalletLabel } from "@/account-linking/index.js";
import {
  PortfolioReviewAdapter,
  type PortfolioReviewSnapshotRow,
  type PortfolioReviewSubscriptionRow,
} from "@/discovery/adapters/portfolioReview.adapter.js";
import { createBankrLlmClient, DEFAULT_CHAT_MODEL, openAiChatParams } from "@/llm/config.js";
import {
  fetchBasePortfolioHoldings,
  type PortfolioHolding,
  type PortfolioRiskLevel,
} from "./balances.js";

interface AvantisReviewTrade {
  pair: string;
  side?: "long" | "short";
  leverage?: number;
  collateralUsd: number;
  sizeUsd: number;
  pnlUsd: number | null;
}

interface AvantisReview {
  positions: AvantisReviewTrade[];
  limitOrders: AvantisReviewTrade[];
  equityUsd: number;
  unavailable?: boolean;
  disabled?: boolean;
}

interface SentimentReview {
  label: "bullish" | "neutral" | "bearish";
  averageChange24hPct: number | null;
  upCount: number;
  downCount: number;
  reason: string;
}

interface PnlComparison {
  usd: number | null;
  pct: number | null;
  netFlowUsd: number | null;
}

export interface PortfolioReviewMessageInput {
  walletAddress: string;
  totalValueUsd: number;
  holdingsValueUsd: number;
  holdings: PortfolioHolding[];
  avantis: AvantisReview | null;
  sentiment: SentimentReview;
  daily: PnlComparison;
  monthly: PnlComparison;
  allTime: PnlComparison;
  trackedSince: Date | null;
  riskCounts: Record<PortfolioRiskLevel, number>;
  basemateRemark: string;
  /** Section heading (defaults to "Daily Portfolio Review"). */
  heading?: string;
  /** When false, the Basemate Remark block is omitted (per-wallet sections). */
  includeRemark?: boolean;
}

export interface PortfolioReviewResult {
  message: string;
  totalValueUsd: number;
  snapshotId: number;
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatSignedUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
}

function formatDate(value: Date | null): string {
  if (!value) return "Tracking starts today";
  return value.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function parseSnapshotJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function holdingKey(holding: Pick<PortfolioHolding, "tokenAddress" | "symbol">): string {
  return (holding.tokenAddress ?? holding.symbol).toLowerCase();
}

function depositAdjustedSpotPnl(
  currentHoldings: PortfolioHolding[],
  priorHoldings: PortfolioHolding[],
): { pnlUsd: number; netFlowUsd: number; basisUsd: number } {
  const currentByKey = new Map(currentHoldings.map((holding) => [holdingKey(holding), holding]));
  const priorByKey = new Map(priorHoldings.map((holding) => [holdingKey(holding), holding]));
  const keys = new Set([...currentByKey.keys(), ...priorByKey.keys()]);
  let pnlUsd = 0;
  let netFlowUsd = 0;
  let basisUsd = 0;

  for (const key of keys) {
    const current = currentByKey.get(key);
    const prior = priorByKey.get(key);
    const currentAmount = current ? numberOrZero(current.amount) : 0;
    const priorAmount = prior ? numberOrZero(prior.amount) : 0;
    const currentPrice = current?.priceUsd ?? prior?.priceUsd ?? 0;
    const priorPrice = prior?.priceUsd ?? currentPrice;
    const pricePnl = priorAmount * (currentPrice - priorPrice);
    const flow = (currentAmount - priorAmount) * currentPrice;

    pnlUsd += Number.isFinite(pricePnl) ? pricePnl : 0;
    netFlowUsd += Number.isFinite(flow) ? flow : 0;
    basisUsd += prior ? prior.valueUsd : 0;
  }

  return { pnlUsd, netFlowUsd, basisUsd };
}

function avantisEquityFromSnapshot(snapshot: PortfolioReviewSnapshotRow): number {
  const avantis = parseSnapshotJson<AvantisReview>(snapshot.avantis_json);
  return numberOrZero(avantis?.equityUsd);
}

function compareToSnapshot(
  currentValueUsd: number,
  currentHoldings: PortfolioHolding[],
  currentAvantis: AvantisReview | null,
  snapshot: PortfolioReviewSnapshotRow | null,
): PnlComparison {
  if (!snapshot) return { usd: null, pct: null, netFlowUsd: null };
  const prior = Number(snapshot.total_value_usd);
  if (!Number.isFinite(prior)) return { usd: null, pct: null, netFlowUsd: null };

  const priorHoldings =
    parseSnapshotJson<PortfolioHolding[]>(snapshot.holdings_json)?.filter(Boolean) ?? [];
  const spot = depositAdjustedSpotPnl(currentHoldings, priorHoldings);
  const priorAvantisEquity = avantisEquityFromSnapshot(snapshot);
  const currentAvantisEquity = currentAvantis?.equityUsd ?? 0;
  const avantisPnl = currentAvantisEquity - priorAvantisEquity;
  const usd = spot.pnlUsd + avantisPnl;
  const netFlowUsd = currentValueUsd - prior - usd;
  const basis = spot.basisUsd + priorAvantisEquity;

  return {
    usd,
    pct: basis > 0 ? (usd / basis) * 100 : null,
    netFlowUsd,
  };
}

function riskRatio(holdings: PortfolioHolding[]): Record<PortfolioRiskLevel, number> {
  return holdings.reduce(
    (acc, holding) => {
      acc[holding.risk] += 1;
      return acc;
    },
    { low: 0, medium: 0, high: 0 } satisfies Record<PortfolioRiskLevel, number>,
  );
}

function buildSentiment(holdings: PortfolioHolding[]): SentimentReview {
  const movers = holdings.filter(
    (holding) => holding.change24hPct != null && Math.abs(holding.change24hPct) >= 0.05,
  );
  if (movers.length < 2) {
    return {
      label: "neutral",
      averageChange24hPct: null,
      upCount: 0,
      downCount: 0,
      reason: "not enough non-stable 24h mover data to call the market",
    };
  }
  const upCount = movers.filter((holding) => (holding.change24hPct ?? 0) > 0).length;
  const downCount = movers.filter((holding) => (holding.change24hPct ?? 0) < 0).length;
  const average =
    movers.reduce((sum, holding) => sum + (holding.change24hPct ?? 0), 0) / movers.length;
  const breadth = upCount / movers.length;
  const label =
    average >= 2 && breadth >= 0.55
      ? "bullish"
      : average <= -2 && breadth <= 0.45
        ? "bearish"
        : "neutral";
  return {
    label,
    averageChange24hPct: average,
    upCount,
    downCount,
    reason: `${upCount}/${movers.length} moving tracked coins are up over 24h`,
  };
}

function formatMovers(holdings: PortfolioHolding[]): string[] {
  const movers = holdings
    .filter((holding) => holding.change24hPct != null)
    .sort((a, b) => Math.abs(b.change24hPct ?? 0) - Math.abs(a.change24hPct ?? 0))
    .slice(0, 6);
  if (movers.length === 0) return ["- No 24h mover data available yet."];
  return movers.map((holding) => {
    const change = holding.change24hPct ?? 0;
    const direction = change > 0 ? "up" : change < 0 ? "down" : "flat";
    return `- **${holding.symbol}:** ${direction} **${formatPct(change)}**`;
  });
}

function formatTopHoldings(holdings: PortfolioHolding[]): string[] {
  const visible = holdings.filter((holding) => holding.valueUsd > 0).slice(0, 5);
  if (visible.length === 0) return ["- No tracked Base token balances found."];
  return visible.map((holding) => {
    const amount = Number(holding.amount);
    const amountText = Number.isFinite(amount)
      ? amount.toLocaleString("en-US", { maximumFractionDigits: 6 })
      : holding.amount;
    return `- **${amountText} ${holding.symbol}** (${formatUsd(holding.valueUsd)})`;
  });
}

async function fetchAvantisReview(_walletAddress: string): Promise<AvantisReview | null> {
  return { positions: [], limitOrders: [], equityUsd: 0, disabled: true };
}

function formatAvantisSection(avantis: AvantisReview | null): string[] {
  if (!avantis || avantis.disabled) return ["**Status:** not configured for this bot right now."];
  if (avantis.unavailable) return ["**Status:** temporarily unavailable; skipping perps for this review."];
  if (avantis.positions.length + avantis.limitOrders.length === 0) {
    return ["**Status:** no open positions or pending limits."];
  }
  const lines = [
    `**Equity:** **${formatUsd(avantis.equityUsd)}** | **Open:** **${avantis.positions.length}** | **Pending:** **${avantis.limitOrders.length}**`,
  ];
  for (const position of avantis.positions.slice(0, 4)) {
    const lev = position.leverage ? ` ${position.leverage}x` : "";
    const pnl = position.pnlUsd == null ? "" : `, PnL ${formatSignedUsd(position.pnlUsd)}`;
    lines.push(
      `- **${position.pair}** ${position.side ?? ""}${lev}: ${formatUsd(position.sizeUsd)} size${pnl}`,
    );
  }
  if (avantis.positions.length > 4) {
    lines.push(`- +${avantis.positions.length - 4} more open position(s)`);
  }
  return lines;
}

function formatPnlLine(label: string, comparison: PnlComparison): string {
  const flow =
    comparison.netFlowUsd == null || Math.abs(comparison.netFlowUsd) < 0.01
      ? ""
      : ` | **Net Flow:** ${formatSignedUsd(comparison.netFlowUsd)}`;
  return `**${label}:** **${formatSignedUsd(comparison.usd)}** (${formatPct(comparison.pct)})${flow}`;
}

function topWinnerLoser(holdings: PortfolioHolding[]): {
  winner: PortfolioHolding | null;
  loser: PortfolioHolding | null;
} {
  const movers = holdings.filter((holding) => holding.change24hPct != null);
  if (movers.length === 0) return { winner: null, loser: null };
  const sorted = [...movers].sort((a, b) => (b.change24hPct ?? 0) - (a.change24hPct ?? 0));
  return {
    winner: sorted[0] ?? null,
    loser: sorted[sorted.length - 1] ?? null,
  };
}

function largestHolding(holdings: PortfolioHolding[], totalValueUsd: number): string {
  const largest = holdings.filter((holding) => holding.valueUsd > 0).sort((a, b) => b.valueUsd - a.valueUsd)[0];
  if (!largest || totalValueUsd <= 0) return "n/a";
  const concentration = (largest.valueUsd / totalValueUsd) * 100;
  return `${largest.symbol} (${formatUsd(largest.valueUsd)}, ${formatPct(concentration)} of portfolio)`;
}

function riskExplanation(riskCounts: Record<PortfolioRiskLevel, number>): string {
  if (riskCounts.high > riskCounts.low + riskCounts.medium) {
    return "high-risk heavy; keep your hands near the eject button";
  }
  if (riskCounts.low >= riskCounts.medium + riskCounts.high) {
    return "mostly low-risk tracked assets";
  }
  return "mixed exposure across tracked assets";
}

async function generateBasemateRemark(args: {
  totalValueUsd: number;
  holdings: PortfolioHolding[];
  riskCounts: Record<PortfolioRiskLevel, number>;
  sentiment: SentimentReview;
  daily: PnlComparison;
}): Promise<string> {
  const fallback = fallbackBasemateRemark(args);

  try {
    const openai = createBankrLlmClient();
    const holdings = args.holdings
      .slice(0, 5)
      .map((holding) => `${holding.symbol} ${formatUsd(holding.valueUsd)} ${holding.risk}`)
      .join(", ");
    const response = await openai.chat.completions.create({
      ...openAiChatParams({
        model: DEFAULT_CHAT_MODEL,
        maxCompletionTokens: 60,
        temperature: 0.9,
      }),
      messages: [
        {
          role: "system",
          content:
            "You write one short Basemate-style portfolio roast. Be playful, crypto-native, and specific. Do not give financial advice. No markdown. One sentence under 24 words.",
        },
        {
          role: "user",
          content: JSON.stringify({
            totalValueUsd: args.totalValueUsd,
            holdings,
            riskMix: args.riskCounts,
            sentiment: args.sentiment,
            dailyPnlUsd: args.daily.usd,
          }),
        },
      ],
    });
    const text = response.choices[0]?.message?.content?.trim();
    return text && text.length <= 220 ? text : fallback;
  } catch {
    return fallback;
  }
}

function fallbackBasemateRemark(args: {
  totalValueUsd: number;
  holdings: PortfolioHolding[];
  riskCounts: Record<PortfolioRiskLevel, number>;
}): string {
  const totalRiskAssets = args.riskCounts.low + args.riskCounts.medium + args.riskCounts.high;
  const stableHeavy =
    args.holdings.length > 0 &&
    args.holdings.filter((holding) => holding.risk === "low").length / args.holdings.length >= 0.8;
  if (args.totalValueUsd < 10) {
    return " this portfolio is still in tutorial mode, but at least it can't rug you too hard.";
  }
  if (totalRiskAssets > 0 && args.riskCounts.high / totalRiskAssets >= 0.5) {
    return " this bag has more red flags than a leverage degen's browser tabs.";
  }
  if (stableHeavy) {
    return " portfolio so stable it might qualify as furniture.";
  }
  return " respectable setup, but don't start calling yourself a fund manager yet.";
}

export function buildPortfolioReviewMessage(input: PortfolioReviewMessageInput): string {
  const { winner, loser } = topWinnerLoser(input.holdings);
  const lines = [
    `**${input.heading ?? "Daily Portfolio Review"}**`,
    "- - -",
    `**Wallet:** ${shortAddress(input.walletAddress)}`,
    `**Total Balance:** **${formatUsd(input.totalValueUsd)}**`,
    `**Spot Holdings:** **${formatUsd(input.holdingsValueUsd)}**`,
    `**Avantis Equity:** **${formatUsd(input.avantis?.equityUsd ?? 0)}**`,
    `**Tracked Since:** ${formatDate(input.trackedSince)}`,
    `**PnL Basis:** deposit-adjusted from tracked balance changes`,
    "- - -",
    "**Portfolio PnL**",
    formatPnlLine("Daily", input.daily),
    formatPnlLine("Monthly", input.monthly),
    formatPnlLine("All-time tracked", input.allTime),
    "- - -",
    "**Top Holdings**",
    ...formatTopHoldings(input.holdings),
    `**Largest Holding:** **${largestHolding(input.holdings, input.totalValueUsd)}**`,
    "- - -",
    "**Coins Up / Down (24h)**",
    ...formatMovers(input.holdings),
    `**Top Winner:** ${
      winner ? `**${winner.symbol}** ${formatPct(winner.change24hPct)}` : "**n/a**"
    }`,
    `**Top Loser:** ${
      loser ? `**${loser.symbol}** ${formatPct(loser.change24hPct)}` : "**n/a**"
    }`,
    "- - -",
    "**Avantis**",
    ...formatAvantisSection(input.avantis),
    "- - -",
    "**Market Sentiment**",
    input.sentiment.averageChange24hPct == null
      ? `**Signal:** ${input.sentiment.reason}`
      : `**${input.sentiment.label.toUpperCase()}:** ${input.sentiment.reason} (avg ${formatPct(input.sentiment.averageChange24hPct)})`,
    "- - -",
    "**Risk Mix**",
    `**Low:Medium:High:** **${input.riskCounts.low}:${input.riskCounts.medium}:${input.riskCounts.high}**`,
    `**Read:** ${riskExplanation(input.riskCounts)}`,
  ];

  if (input.includeRemark !== false) {
    lines.push("- - -", "**Basemate Remark**", input.basemateRemark);
  }

  return lines.join("\n");
}

interface WalletReview {
  walletAddress: string;
  totalValueUsd: number;
  holdingsValueUsd: number;
  holdings: PortfolioHolding[];
  avantis: AvantisReview | null;
  sentiment: SentimentReview;
  riskCounts: Record<PortfolioRiskLevel, number>;
  daily: PnlComparison;
  monthly: PnlComparison;
  allTime: PnlComparison;
  trackedSince: Date | null;
  priorDailyTotal: number | null;
  priorMonthlyTotal: number | null;
  priorAllTimeTotal: number | null;
  snapshotId: number;
}

/**
 * Build the review for a single wallet and persist its snapshot. When
 * `walletScoped` is true the snapshot history is tracked per wallet (used once a
 * user has linked accounts); otherwise it uses the legacy NULL-wallet history.
 */
async function computeWalletReview(
  subscription: PortfolioReviewSubscriptionRow,
  walletAddress: string,
  now: Date,
  walletScoped: boolean,
): Promise<WalletReview> {
  const walletFilter = walletScoped ? walletAddress : null;
  const holdings = await fetchBasePortfolioHoldings(walletAddress);
  const holdingsValueUsd = holdings.reduce((sum, holding) => sum + holding.valueUsd, 0);
  const avantis = await fetchAvantisReview(walletAddress);
  const totalValueUsd = holdingsValueUsd + (avantis?.equityUsd ?? 0);
  const sentiment = buildSentiment(holdings);
  const riskCounts = riskRatio(holdings);

  const dailySnapshot = await PortfolioReviewAdapter.findNearestSnapshotBefore(
    subscription.id,
    new Date(now.getTime() - 24 * 60 * 60 * 1000),
    walletFilter,
  );
  const monthlySnapshot = await PortfolioReviewAdapter.findNearestSnapshotBefore(
    subscription.id,
    new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    walletFilter,
  );
  const oldestSnapshot = await PortfolioReviewAdapter.findOldestSnapshot(
    subscription.id,
    walletFilter,
  );

  const snapshot = await PortfolioReviewAdapter.insertSnapshot({
    subscriptionId: subscription.id,
    totalValueUsd,
    holdings,
    avantis,
    sentiment,
    walletAddress: walletFilter,
  });

  return {
    walletAddress,
    totalValueUsd,
    holdingsValueUsd,
    holdings,
    avantis,
    sentiment,
    riskCounts,
    daily: compareToSnapshot(totalValueUsd, holdings, avantis, dailySnapshot),
    monthly: compareToSnapshot(totalValueUsd, holdings, avantis, monthlySnapshot),
    allTime: compareToSnapshot(totalValueUsd, holdings, avantis, oldestSnapshot),
    trackedSince: oldestSnapshot?.captured_at ?? null,
    priorDailyTotal: dailySnapshot ? Number(dailySnapshot.total_value_usd) : null,
    priorMonthlyTotal: monthlySnapshot ? Number(monthlySnapshot.total_value_usd) : null,
    priorAllTimeTotal: oldestSnapshot ? Number(oldestSnapshot.total_value_usd) : null,
    snapshotId: snapshot.id,
  };
}

/** Sum per-wallet PnL comparisons into one combined comparison. */
function combineComparisons(
  items: { comparison: PnlComparison; priorTotal: number | null }[],
): PnlComparison {
  let usd = 0;
  let netFlowUsd = 0;
  let basis = 0;
  let any = false;
  for (const { comparison, priorTotal } of items) {
    if (comparison.usd != null) {
      usd += comparison.usd;
      any = true;
    }
    if (comparison.netFlowUsd != null) netFlowUsd += comparison.netFlowUsd;
    if (priorTotal != null) basis += priorTotal;
  }
  return {
    usd: any ? usd : null,
    pct: any && basis > 0 ? (usd / basis) * 100 : null,
    netFlowUsd: any ? netFlowUsd : null,
  };
}

function buildCombinedSection(args: {
  accountCount: number;
  totalValueUsd: number;
  daily: PnlComparison;
  monthly: PnlComparison;
  allTime: PnlComparison;
  riskCounts: Record<PortfolioRiskLevel, number>;
  trackedSince: Date | null;
  basemateRemark: string;
}): string {
  return [
    `**Combined across ${args.accountCount} accounts**`,
    "- - -",
    `**Total Balance:** **${formatUsd(args.totalValueUsd)}**`,
    `**Tracked Since:** ${formatDate(args.trackedSince)}`,
    "- - -",
    "**Portfolio PnL**",
    formatPnlLine("Daily", args.daily),
    formatPnlLine("Monthly", args.monthly),
    formatPnlLine("All-time tracked", args.allTime),
    "- - -",
    "**Risk Mix**",
    `**Low:Medium:High:** **${args.riskCounts.low}:${args.riskCounts.medium}:${args.riskCounts.high}**`,
    `**Read:** ${riskExplanation(args.riskCounts)}`,
    "- - -",
    "**Basemate Remark**",
    args.basemateRemark,
  ].join("\n");
}

async function buildAggregatedReview(
  subscription: PortfolioReviewSubscriptionRow,
  wallets: string[],
  now: Date,
): Promise<PortfolioReviewResult> {
  const reviews: WalletReview[] = [];
  for (const wallet of wallets) {
    reviews.push(await computeWalletReview(subscription, wallet, now, true));
  }

  const combinedHoldings = reviews.flatMap((r) => r.holdings);
  const combinedRisk = riskRatio(combinedHoldings);
  const combinedSentiment = buildSentiment(combinedHoldings);
  const totalValueUsd = reviews.reduce((sum, r) => sum + r.totalValueUsd, 0);
  const combinedDaily = combineComparisons(
    reviews.map((r) => ({ comparison: r.daily, priorTotal: r.priorDailyTotal })),
  );
  const combinedMonthly = combineComparisons(
    reviews.map((r) => ({ comparison: r.monthly, priorTotal: r.priorMonthlyTotal })),
  );
  const combinedAllTime = combineComparisons(
    reviews.map((r) => ({ comparison: r.allTime, priorTotal: r.priorAllTimeTotal })),
  );
  const trackedSince = reviews.reduce<Date | null>((min, r) => {
    if (!r.trackedSince) return min;
    if (!min) return r.trackedSince;
    return r.trackedSince < min ? r.trackedSince : min;
  }, null);

  const basemateRemark = await generateBasemateRemark({
    totalValueUsd,
    holdings: combinedHoldings,
    riskCounts: combinedRisk,
    sentiment: combinedSentiment,
    daily: combinedDaily,
  });

  const sections: string[] = [
    `**Daily Portfolio Review — ${reviews.length} connected accounts**`,
  ];
  for (const r of reviews) {
    sections.push(
      buildPortfolioReviewMessage({
        walletAddress: r.walletAddress,
        totalValueUsd: r.totalValueUsd,
        holdingsValueUsd: r.holdingsValueUsd,
        holdings: r.holdings,
        avantis: r.avantis,
        sentiment: r.sentiment,
        daily: r.daily,
        monthly: r.monthly,
        allTime: r.allTime,
        trackedSince: r.trackedSince,
        riskCounts: r.riskCounts,
        basemateRemark: "",
        heading: `Account ${shortWalletLabel(r.walletAddress)}`,
        includeRemark: false,
      }),
    );
  }
  sections.push(
    buildCombinedSection({
      accountCount: reviews.length,
      totalValueUsd,
      daily: combinedDaily,
      monthly: combinedMonthly,
      allTime: combinedAllTime,
      riskCounts: combinedRisk,
      trackedSince,
      basemateRemark,
    }),
  );

  return {
    message: sections.join("\n\n"),
    totalValueUsd,
    snapshotId: reviews[0]?.snapshotId ?? 0,
  };
}

export async function buildAndStorePortfolioReview(
  subscription: PortfolioReviewSubscriptionRow,
  now = new Date(),
): Promise<PortfolioReviewResult> {
  // Aggregate across linked wallets when the user has connected other accounts.
  const wallets =
    subscription.platform === "imessage" || subscription.platform === "xmtp" || subscription.platform === "whatsapp"
      ? await resolveAllWalletsForUser(
          subscription.platform,
          subscription.user_key,
          subscription.wallet_address,
        )
      : [];
  if (wallets.length > 1) {
    return buildAggregatedReview(subscription, wallets, now);
  }

  const review = await computeWalletReview(subscription, subscription.wallet_address, now, false);
  const basemateRemark = await generateBasemateRemark({
    totalValueUsd: review.totalValueUsd,
    holdings: review.holdings,
    riskCounts: review.riskCounts,
    sentiment: review.sentiment,
    daily: review.daily,
  });

  return {
    message: buildPortfolioReviewMessage({
      walletAddress: subscription.wallet_address,
      totalValueUsd: review.totalValueUsd,
      holdingsValueUsd: review.holdingsValueUsd,
      holdings: review.holdings,
      avantis: review.avantis,
      sentiment: review.sentiment,
      daily: review.daily,
      monthly: review.monthly,
      allTime: review.allTime,
      trackedSince: review.trackedSince,
      riskCounts: review.riskCounts,
      basemateRemark,
    }),
    totalValueUsd: review.totalValueUsd,
    snapshotId: review.snapshotId,
  };
}
