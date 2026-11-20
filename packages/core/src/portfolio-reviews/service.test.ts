import { describe, expect, it } from "vitest";

import { buildPortfolioReviewMessage } from "./service.js";

describe("buildPortfolioReviewMessage", () => {
  it("renders a token-analysis style markdown card with enriched data and roast", () => {
    const message = buildPortfolioReviewMessage({
      walletAddress: "0x0000000000000000000000000000000000000001",
      totalValueUsd: 1.38,
      holdingsValueUsd: 1.38,
      holdings: [
        {
          symbol: "ETH",
          name: "Ethereum",
          tokenAddress: null,
          amount: "0.000474",
          decimals: 18,
          priceUsd: 1687.76,
          valueUsd: 0.8,
          change24hPct: 1.2,
          risk: "low",
        },
        {
          symbol: "USDC",
          name: "USD Coin",
          tokenAddress: "0x833589fc",
          amount: "0.57447",
          decimals: 6,
          priceUsd: 1,
          valueUsd: 0.57,
          change24hPct: 0,
          risk: "low",
        },
      ],
      avantis: { positions: [], limitOrders: [], equityUsd: 0, unavailable: true },
      sentiment: {
        label: "neutral",
        averageChange24hPct: 0.6,
        upCount: 1,
        downCount: 0,
        reason: "1/2 tracked coins are up over 24h",
      },
      daily: { usd: null, pct: null, netFlowUsd: null },
      monthly: { usd: null, pct: null, netFlowUsd: null },
      allTime: { usd: null, pct: null, netFlowUsd: null },
      trackedSince: null,
      riskCounts: { low: 2, medium: 0, high: 0 },
      basemateRemark: "AI roast: this portfolio is still in tutorial mode.",
    });

    expect(message).toContain("**Daily Portfolio Review**");
    expect(message).toContain("**Total Balance:** **$1.38**");
    expect(message).toContain("**PnL Basis:** deposit-adjusted from tracked balance changes");
    expect(message).toContain("- **0.000474 ETH** ($0.80)");
    expect(message).not.toContain("* 0.000474 ETH");
    expect(message).toContain("**Largest Holding:** **ETH");
    expect(message).toContain("**Top Winner:** **ETH** +1.20%");
    expect(message).toContain("**Status:** temporarily unavailable; skipping perps for this review.");
    expect(message).toContain("**Low:Medium:High:** **2:0:0**");
    expect(message).toContain("**Basemate Remark**");
    expect(message).toContain("AI roast: this portfolio is still in tutorial mode.");
  });
});
