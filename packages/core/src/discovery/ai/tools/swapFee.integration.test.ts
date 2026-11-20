import { beforeEach, describe, expect, it, vi } from "vitest";

const { applySwapFeeToBuildMock } = vi.hoisted(() => ({
  applySwapFeeToBuildMock: vi.fn(),
}));

vi.mock("@/discovery/ai/tools/swapFee.js", () => ({
  applySwapFeeToBuild: applySwapFeeToBuildMock,
}));

const { buildAerodromeRoutedSwap, buildRoutedSwap, getBestSwapQuote } = await import("./swap.js");

const WALLET = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const RESULT = {
  calls: [
    {
      to: TOKEN,
      data: "0x1234",
      value: "0x0",
      metadata: { description: "fee-finalized swap", transactionType: "swap" },
    },
  ],
  label: "fee-finalized swap",
  dex: "uniswap",
};

describe("public swap fee integration", () => {
  beforeEach(() => {
    applySwapFeeToBuildMock.mockReset().mockResolvedValue(RESULT);
  });

  it("finalizes direct best-route tool swaps exactly once", async () => {
    const result = await getBestSwapQuote({
      fromAddress: "ETH",
      fromIsEth: true,
      fromDecimals: 18,
      fromSymbol: "ETH",
      toAddress: TOKEN,
      toSymbol: "TOKEN",
      toDecimals: 18,
      rawAmountIn: 1_000_000_000_000_000_000n,
      humanAmount: "1",
      walletAddress: WALLET,
      label: "Swap 1 ETH → TOKEN",
    });

    expect(result).toBe(RESULT);
    expect(applySwapFeeToBuildMock).toHaveBeenCalledOnce();
    expect(applySwapFeeToBuildMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        grossRawAmount: 1_000_000_000_000_000_000n,
        fromAddress: "ETH",
      }),
    );
  });

  it("finalizes explicit Aerodrome tool swaps exactly once", async () => {
    const result = await buildAerodromeRoutedSwap({
      fromAddress: "ETH",
      fromSymbol: "ETH",
      fromDecimals: 18,
      toAddress: TOKEN,
      toSymbol: "TOKEN",
      humanAmount: "1",
      walletAddress: WALLET,
    });

    expect(result).toBe(RESULT);
    expect(applySwapFeeToBuildMock).toHaveBeenCalledOnce();
  });

  it("finalizes buildRoutedSwap consumers such as copy trades and buy buttons", async () => {
    const result = await buildRoutedSwap("ETH", "ETH", 18, TOKEN, "TOKEN", "1", WALLET);

    expect(result).toEqual(RESULT);
    expect(applySwapFeeToBuildMock).toHaveBeenCalledOnce();
  });
});
