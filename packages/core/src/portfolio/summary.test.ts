import { afterEach, describe, expect, it } from "vitest";

import { buildSignedPortfolioUrl } from "./access.js";
import {
  formatCoinsSummaryForImessage,
  formatPerpsSummaryForImessage,
  formatStakingSummaryForImessage,
} from "./summary.js";
import type { ImessagePortfolioPayload } from "./types.js";

const ORIGINAL_SECRET = process.env.PORTFOLIO_LINK_SECRET;
const ORIGINAL_BASE_URL = process.env.PORTFOLIO_VIEW_BASE_URL;

afterEach(() => {
  if (ORIGINAL_SECRET == null) delete process.env.PORTFOLIO_LINK_SECRET;
  else process.env.PORTFOLIO_LINK_SECRET = ORIGINAL_SECRET;
  if (ORIGINAL_BASE_URL == null) delete process.env.PORTFOLIO_VIEW_BASE_URL;
  else process.env.PORTFOLIO_VIEW_BASE_URL = ORIGINAL_BASE_URL;
});

function payload(): ImessagePortfolioPayload {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    user: { id: "sender-1", wallets: ["0x1"], walletLabels: { "0x1": "Main wallet" }, serverWallet: "0x1" },
    totals: { coinsUsd: 600, perpsUsd: 500, stakingUsd: 300, totalUsd: 1400 },
    coins: [
      { id: "1", walletAddress: "0x1", symbol: "ETH", name: "Ethereum", imageUrl: null, tokenAddress: null, amount: "0.1", priceUsd: 3000, valueUsd: 300 },
      { id: "2", walletAddress: "0x1", symbol: "USDC", name: "USD Coin", imageUrl: null, tokenAddress: "0x2", amount: "200", priceUsd: 1, valueUsd: 200 },
      { id: "3", walletAddress: "0x1", symbol: "DEGEN", name: "Degen", imageUrl: null, tokenAddress: "0x3", amount: "1000", priceUsd: 0.08, valueUsd: 80 },
      { id: "4", walletAddress: "0x1", symbol: "WELL", name: "Moonwell", imageUrl: null, tokenAddress: "0x4", amount: "10", priceUsd: 2, valueUsd: 20 },
    ],
    perpetuals: [
      { id: "p1", walletAddress: "0x1", kind: "open", pair: "ETH-USD", side: "long", leverage: 3, collateralUsd: 100, sizeUsd: 500, valueUsd: 500, pnlUsd: 25, takeProfit: "4000", stopLoss: "2500", openPrice: "3000", limitPrice: null, pairIndex: 0, tradeIndex: 1 },
    ],
    staking: [
      { id: "s1", walletAddress: "0x1", protocol: "moonwell", asset: "USDC", name: "Moonwell USDC", amount: 300, decimals: 6, valueUsd: 300, apy: 4.2, healthFactor: null },
    ],
    errors: [],
  };
}

describe("iMessage portfolio summaries", () => {
  it("limits coins to top three and omits the signed view link from summary text", () => {
    process.env.PORTFOLIO_LINK_SECRET = "test-secret";
    process.env.PORTFOLIO_VIEW_BASE_URL = "https://metrics.example/portfolio";

    const text = formatCoinsSummaryForImessage(payload());
    const url = buildSignedPortfolioUrl("sender-1");

    expect(text).toContain("Top coins:");
    expect(text).toContain("ETH");
    expect(text).toContain("USDC");
    expect(text).toContain("DEGEN");
    expect(text).not.toContain("10 WELL");
    expect(text).toContain("Staking & lending: $300.00");
    expect(text).toContain("- moonwell 300 USDC ($300.00) at 4.20% APY");
    expect(text).not.toContain("View all:");
    expect(text).not.toContain(url);
    expect(url).toContain("https://metrics.example/portfolio?user=sender-1&token=");
  });

  it("shows the highest perp and staking positions", () => {
    process.env.PORTFOLIO_LINK_SECRET = "test-secret";

    expect(formatPerpsSummaryForImessage(payload())).toContain("Largest position: ETH-USD long 3x");
    expect(formatStakingSummaryForImessage(payload())).toContain("Largest position: moonwell 300 USDC");
  });

  it("hides coin balances worth less than one cent", () => {
    const withDust = payload();
    withDust.coins = [
      ...withDust.coins,
      {
        id: "dust",
        walletAddress: "0x1",
        symbol: "DUST",
        name: "Dust",
        imageUrl: null,
        tokenAddress: "0xdust",
        amount: "1000",
        priceUsd: 0.000001,
        valueUsd: 0.001,
      },
    ];

    expect(formatCoinsSummaryForImessage(withDust)).not.toContain("DUST");
  });

  it("shows non-zero balances when their prices are temporarily unavailable", () => {
    const withUnpricedCoin = payload();
    withUnpricedCoin.coins = [
      {
        id: "unpriced",
        walletAddress: "0x1",
        symbol: "IDRX",
        name: "IDRX",
        imageUrl: null,
        tokenAddress: "0xidrx",
        amount: "55026.99",
        priceUsd: null,
        valueUsd: 0,
      },
    ];
    withUnpricedCoin.totals = {
      coinsUsd: 0,
      perpsUsd: 0,
      stakingUsd: 0,
      totalUsd: 0,
    };
    withUnpricedCoin.perpetuals = [];
    withUnpricedCoin.staking = [];

    const text = formatCoinsSummaryForImessage(withUnpricedCoin);

    expect(text).toContain("Your priced assets are about $0.0000");
    expect(text).toContain("Some coin values are unavailable");
    expect(text).toContain("55,026.99 IDRX (value unavailable)");
  });
});
