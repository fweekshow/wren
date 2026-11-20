import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseUnits } from "viem";

const mocks = vi.hoisted(() => ({
  getBestSwapQuote: vi.fn(),
  buildDepositDraft: vi.fn(),
}));

vi.mock("@/discovery/ai/tools/swap.js", () => ({
  getBestSwapQuote: mocks.getBestSwapQuote,
}));

vi.mock("@/wallet/phoneEscrow.js", () => ({
  PhoneEscrowAdapter: {
    buildDepositDraft: mocks.buildDepositDraft,
  },
}));

import { verifiedStableBySymbol } from "./verifiedStables.js";
import { buildCorridorSendCalls } from "./corridorSend.js";

const SENDER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const XSGD = verifiedStableBySymbol("XSGD")!;

describe("buildCorridorSendCalls", () => {
  beforeEach(() => {
    mocks.getBestSwapQuote.mockReset();
    mocks.buildDepositDraft.mockReset();
  });

  it("returns USDC fallback when quote is null", async () => {
    mocks.getBestSwapQuote.mockResolvedValue(null);
    const result = await buildCorridorSendCalls({
      mode: "transfer",
      usdcAmount: "10",
      localStable: XSGD,
      senderAddress: SENDER,
      recipientAddress: RECIPIENT,
    });
    expect(result.fallback).toBe("USDC");
  });

  it("builds swap + transfer calls with minOut amount", async () => {
    const rawOut = parseUnits("12.8", XSGD.decimals);
    mocks.getBestSwapQuote.mockResolvedValue({
      calls: [
        {
          to: "0x3333333333333333333333333333333333333333",
          value: "0x0",
          data: "0xswap",
          metadata: { description: "swap", transactionType: "swap" },
        },
      ],
      label: "Swap 10 USDC → XSGD",
      dex: "uniswap",
      rawAmountOut: rawOut,
    });

    const result = await buildCorridorSendCalls({
      mode: "transfer",
      usdcAmount: "10",
      localStable: XSGD,
      senderAddress: SENDER,
      recipientAddress: RECIPIENT,
    });

    expect(result.fallback).toBeUndefined();
    if (result.fallback) return;
    expect(result.calls).toHaveLength(2);
    expect(result.localStable.symbol).toBe("XSGD");
    expect(result.usdcAmount).toBe("10");
    // 1% slippage haircut on 12.8 → 12.672
    expect(Number(result.localAmount)).toBeCloseTo(12.672, 3);
    expect(result.quotedLocalAmount).toBe("12.8");
    expect(result.calls[1]!.to.toLowerCase()).toBe(XSGD.address!.toLowerCase());
  });

  it("builds swap + escrow deposit calls", async () => {
    const rawOut = parseUnits("12.8", XSGD.decimals);
    mocks.getBestSwapQuote.mockResolvedValue({
      calls: [
        {
          to: "0x3333333333333333333333333333333333333333",
          value: "0x0",
          data: "0xswap",
          metadata: { description: "swap", transactionType: "swap" },
        },
      ],
      label: "Swap 10 USDC → XSGD",
      dex: "aerodrome",
      rawAmountOut: rawOut,
    });
    mocks.buildDepositDraft.mockReturnValue({
      phone: "+6591234567",
      phoneHash: "0xhash",
      tokenAddress: XSGD.address,
      tokenSymbol: "XSGD",
      tokenDecimals: XSGD.decimals,
      amountAtomic: parseUnits("12.672", XSGD.decimals),
      amount: "12.672",
      calls: [
        {
          to: XSGD.address,
          value: "0x0",
          data: "0xapprove",
          metadata: { description: "approve", transactionType: "approve" },
        },
        {
          to: "0xescrow",
          value: "0x0",
          data: "0xdeposit",
          metadata: { description: "deposit", transactionType: "escrow_deposit" },
        },
      ],
    });

    const result = await buildCorridorSendCalls({
      mode: "escrow",
      usdcAmount: "10",
      localStable: XSGD,
      senderAddress: SENDER,
      phone: "+6591234567",
    });

    expect(result.fallback).toBeUndefined();
    if (result.fallback) return;
    expect(result.calls).toHaveLength(3);
    expect(mocks.buildDepositDraft).toHaveBeenCalled();
    expect(result.localStable.symbol).toBe("XSGD");
    expect(result.label).toContain("USDC");
    expect(result.label).toContain("XSGD");
  });

  it("falls back when stable has no address", async () => {
    const result = await buildCorridorSendCalls({
      mode: "transfer",
      usdcAmount: "10",
      localStable: {
        ...XSGD,
        address: null,
        status: "watch",
      },
      senderAddress: SENDER,
      recipientAddress: RECIPIENT,
    });
    expect(result).toEqual({
      fallback: "USDC",
      reason: "XSGD has no Base address",
    });
    expect(mocks.getBestSwapQuote).not.toHaveBeenCalled();
  });
});
