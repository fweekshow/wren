import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchTraderHoldings = vi.hoisted(() => vi.fn());
const buildImessagePortfolio = vi.hoisted(() => vi.fn());

vi.mock("@/copy-trading/portfolio/balances.js", () => ({
  fetchTraderHoldings,
}));
vi.mock("@/wallet/cdp.js", () => ({
  GasEstimationError: class GasEstimationError extends Error {},
  InsufficientGasError: class InsufficientGasError extends Error {},
  getBalances: vi.fn(),
  sendCalls: vi.fn(),
}));
vi.mock("@/portfolio/service.js", () => ({
  buildImessagePortfolio,
}));

import { mainWalletInfoText, walletBalanceLines } from "./wallet.utils.js";

describe("walletBalanceLines", () => {
  beforeEach(() => fetchTraderHoldings.mockReset());

  it("shows only holdings worth at least one cent", async () => {
    fetchTraderHoldings.mockResolvedValue([
      { symbol: "USDC", amount: "2", valueUsd: 2 },
      { symbol: "CENT", amount: "1", valueUsd: 0.01 },
      { symbol: "DUST", amount: "1000", valueUsd: 0.0099 },
    ]);

    const text = await walletBalanceLines("0x1111111111111111111111111111111111111111");

    expect(text).toContain("2 USDC");
    expect(text).toContain("1 CENT");
    expect(text).not.toContain("DUST");
    expect(fetchTraderHoldings).toHaveBeenCalledWith(
      "0x1111111111111111111111111111111111111111",
      { minValueUsd: 0.01 },
    );
  });
});

describe("mainWalletInfoText", () => {
  it("links balance responses to the app dashboard", async () => {
    buildImessagePortfolio.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      user: {
        id: "sender-1",
        wallets: ["0x1111111111111111111111111111111111111111"],
        walletLabels: {},
        serverWallet: "0x1111111111111111111111111111111111111111",
      },
      totals: { totalUsd: 1, coinsUsd: 1, perpsUsd: 0, stakingUsd: 0 },
      coins: [],
      perpetuals: [],
      staking: [],
      errors: [],
    });

    const response = await mainWalletInfoText(
      "sender-1",
      "0x1111111111111111111111111111111111111111",
    );

    expect(response).toContain("https://basemate.app/app#home");
    expect(response?.join("\n")).not.toContain("/portfolio");
  });
});
