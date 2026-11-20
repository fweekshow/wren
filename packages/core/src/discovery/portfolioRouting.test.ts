import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ImessagePortfolioPayload } from "@/portfolio/types.js";

const buildXmtpPortfolioMock = vi.fn();
const buildImessagePortfolioMock = vi.fn();

vi.mock("@/portfolio/service.js", () => ({
  buildXmtpPortfolio: (...args: unknown[]) => buildXmtpPortfolioMock(...args),
  buildImessagePortfolio: (...args: unknown[]) => buildImessagePortfolioMock(...args),
}));

const ORIGINAL_SECRET = process.env.PORTFOLIO_LINK_SECRET;

function testPortfolio(): ImessagePortfolioPayload {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    user: {
      id: "inbox-1",
      wallets: ["0xabc"],
      walletLabels: { "0xabc": "Main wallet" },
      serverWallet: "0xabc",
    },
    totals: { coinsUsd: 600, perpsUsd: 500, stakingUsd: 300, totalUsd: 1400 },
    coins: [
      {
        id: "1",
        walletAddress: "0xabc",
        symbol: "ETH",
        name: "Ethereum",
        imageUrl: null,
        tokenAddress: null,
        amount: "0.1",
        priceUsd: 3000,
        valueUsd: 300,
      },
    ],
    perpetuals: [
      {
        id: "p1",
        walletAddress: "0xabc",
        kind: "open",
        pair: "ETH-USD",
        side: "long",
        leverage: 3,
        collateralUsd: 100,
        sizeUsd: 500,
        valueUsd: 500,
        pnlUsd: 25,
        takeProfit: null,
        stopLoss: null,
        openPrice: "3000",
        limitPrice: null,
        pairIndex: 0,
        tradeIndex: 1,
      },
    ],
    staking: [
      {
        id: "s1",
        walletAddress: "0xabc",
        protocol: "morpho",
        asset: "USDC",
        name: "Morpho USDC",
        amount: 300,
        decimals: 6,
        valueUsd: 300,
        apy: 4.2,
        healthFactor: null,
      },
    ],
    errors: [],
  };
}

describe("isPortfolioBalanceIntent", () => {
  let isPortfolioBalanceIntent: typeof import("./ai.js").isPortfolioBalanceIntent;

  beforeEach(async () => {
    ({ isPortfolioBalanceIntent } = await import("./ai.js"));
  });

  it("matches portfolio and balance queries", () => {
    expect(isPortfolioBalanceIntent("show my portfolio")).toBe(true);
    expect(isPortfolioBalanceIntent("what's my balance")).toBe(true);
    expect(isPortfolioBalanceIntent("check my holdings")).toBe(true);
    expect(isPortfolioBalanceIntent("view my balances")).toBe(true);
  });

  it("does not match unrelated queries", () => {
    expect(isPortfolioBalanceIntent("long eth")).toBe(false);
    expect(isPortfolioBalanceIntent("how do swaps work")).toBe(false);
  });
});

describe("XMTP portfolio routing", () => {
  let DiscoveryAI: typeof import("./ai.js").DiscoveryAI;

  beforeEach(async () => {
    process.env.PORTFOLIO_LINK_SECRET = "test-secret";
    buildXmtpPortfolioMock.mockReset();
    buildImessagePortfolioMock.mockReset();
    buildXmtpPortfolioMock.mockResolvedValue(testPortfolio());
    ({ DiscoveryAI } = await import("./ai.js"));
  });

  afterEach(() => {
    if (ORIGINAL_SECRET == null) delete process.env.PORTFOLIO_LINK_SECRET;
    else process.env.PORTFOLIO_LINK_SECRET = ORIGINAL_SECRET;
  });

  const xmtpCtx = {
    inboxId: "inbox-1",
    walletAddress: "0xabc",
    copyPlatform: "xmtp" as const,
    copyUserKey: "inbox-1",
    disableDeterministicRouting: false,
  };

  it("returns portfolio summary + signed link for balance queries", async () => {
    const ai = new DiscoveryAI();
    const resp = await ai.respond("show my portfolio", xmtpCtx);

    expect(resp.type).toBe("text");
    if (resp.type !== "text") return;
    expect(resp.text).toContain("Your portfolio is about");
    expect(resp.portfolioViewUrl).toContain("user=inbox-1");
    expect(buildXmtpPortfolioMock).toHaveBeenCalledWith("inbox-1", "0xabc");
  });

  it("returns perp summary + signed link for position list queries", async () => {
    const ai = new DiscoveryAI();
    const resp = await ai.respond("check my perp positions", xmtpCtx);

    expect(resp.type).toBe("text");
    if (resp.type !== "text") return;
    expect(resp.text).toContain("Perps total notional");
    expect(resp.text).toContain("ETH-USD long 3x");
    expect(resp.portfolioViewUrl).toContain("user=inbox-1");
  });

  it("returns staking summary + signed link for generic vault reads", async () => {
    const ai = new DiscoveryAI();
    const resp = await ai.respond("show my vault positions", xmtpCtx);

    expect(resp.type).toBe("text");
    if (resp.type !== "text") return;
    expect(resp.text).toContain("Staking and lending total");
    expect(resp.text).toContain("morpho");
    expect(resp.portfolioViewUrl).toContain("user=inbox-1");
  });
});
