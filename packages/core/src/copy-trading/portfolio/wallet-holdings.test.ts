import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchBasePortfolioHoldings: vi.fn(),
  fetchCoinGeckoQuote: vi.fn(),
  fetchDexScreenerMarkets: vi.fn(),
  getBalances: vi.fn(),
}));

vi.mock("@/portfolio-reviews/index.js", () => ({
  fetchBasePortfolioHoldings: mocks.fetchBasePortfolioHoldings,
}));

vi.mock("@/price-alerts/providers/coingecko.js", () => ({
  fetchCoinGeckoQuote: mocks.fetchCoinGeckoQuote,
}));

vi.mock("@/price-alerts/providers/dexscreener.js", () => ({
  fetchDexScreenerMarkets: mocks.fetchDexScreenerMarkets,
}));

vi.mock("@/wallet/cdp.js", () => ({
  getBalances: mocks.getBalances,
  isCdpEnabled: () => true,
}));

vi.mock("@/utils/logger.js", () => ({
  logger: { warn: vi.fn() },
}));

import { fetchWalletHoldings } from "./balances.js";

describe("fetchWalletHoldings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchBasePortfolioHoldings.mockResolvedValue([]);
  });

  it("enumerates CDP balances and uses CoinGecko only for native ETH", async () => {
    const tokenAddress = "0x1111111111111111111111111111111111111111";
    mocks.getBalances.mockResolvedValue([
      {
        symbol: "ETH",
        contractAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        amount: 2_000_000_000_000_000_000n,
        decimals: 18,
        formatted: "2",
      },
      {
        symbol: "TOKEN",
        contractAddress: tokenAddress,
        amount: 3_000_000n,
        decimals: 6,
        formatted: "3",
      },
    ]);
    mocks.fetchCoinGeckoQuote.mockResolvedValue({ priceUsd: 2_500 });
    mocks.fetchDexScreenerMarkets.mockResolvedValue(
      new Map([
        [
          tokenAddress,
          {
            symbol: "TOKEN",
            name: "Test Token",
            priceUsd: 4,
            change24hPct: 5,
            liquidityUsd: 2_000_000,
            marketCapUsd: 10_000_000,
          },
        ],
      ]),
    );

    const holdings = await fetchWalletHoldings("0xwallet", { minValueUsd: 0.01 });

    expect(mocks.getBalances).toHaveBeenCalledWith("0xwallet");
    expect(mocks.fetchCoinGeckoQuote).toHaveBeenCalledWith("ethereum");
    expect(mocks.fetchDexScreenerMarkets).toHaveBeenCalledWith([tokenAddress]);
    expect(holdings).toEqual([
      expect.objectContaining({ symbol: "ETH", priceUsd: 2_500, valueUsd: 5_000 }),
      expect.objectContaining({ symbol: "TOKEN", priceUsd: 4, valueUsd: 12 }),
    ]);
    expect(mocks.fetchBasePortfolioHoldings).toHaveBeenCalledWith("0xwallet");
  });

  it("keeps successful CDP balances when the RPC provider fails", async () => {
    mocks.getBalances.mockResolvedValue([
      {
        symbol: "ETH",
        contractAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        amount: 100_000_000_000_000n,
        decimals: 18,
        formatted: "0.0001",
      },
    ]);
    mocks.fetchCoinGeckoQuote.mockResolvedValue({ priceUsd: 5_200 });
    mocks.fetchDexScreenerMarkets.mockResolvedValue(new Map());
    mocks.fetchBasePortfolioHoldings.mockRejectedValue(new Error("Base RPC unavailable"));

    await expect(fetchWalletHoldings("0xwallet", { minValueUsd: 0.01 })).resolves.toEqual([
      expect.objectContaining({ symbol: "ETH", valueUsd: 0.52 }),
    ]);
  });
});
