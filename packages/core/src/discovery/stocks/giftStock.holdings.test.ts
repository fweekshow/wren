import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, erc20Abi, parseUnits } from "viem";

vi.mock("@/config/config.js", () => ({
  config: {
    env: "test",
    phoneEscrow: {
      enabled: true,
      contractAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      phoneHashSalt: "test-salt",
      operatorPrivateKey: "0xabc",
    },
  },
}));
vi.mock("@/wallet/phoneEscrow.js", () => ({
  PhoneEscrowAdapter: { buildDepositDraft: () => ({}) },
}));
vi.mock("@/wallet/onramp.js", () => ({ ONRAMP_MIN_USD: 2 }));

import { resolveStockToken } from "@/discovery/doppler/stockRegistry.js";

import { buildStockTransferCalls, type StockGiftQuote } from "./giftStock.service.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RECIPIENT = "0x2222222222222222222222222222222222222222";

function appleQuote(): StockGiftQuote {
  const entry = resolveStockToken("AAPL");
  if (!entry) throw new Error("AAPL catalog missing");
  const sharesHuman = "0.1";
  return {
    entry,
    plainName: "Apple stock",
    sharesHuman,
    sharesRaw: parseUnits(sharesHuman, entry.decimals),
    usdcCostHuman: "25",
    usdcCostRaw: 25_000_000n,
    notionalUsd: 25,
    maxUsd: 25,
    sharePriceUsd: 250,
    priceSource: "chainlink",
    isUsd: true,
    amountLabel: "$25 of Apple stock",
  };
}

describe("buildStockTransferCalls", () => {
  it("transfers the quoted stock and skips any swap", () => {
    const quote = appleQuote();
    const built = buildStockTransferCalls({
      quote,
      recipientAddress: RECIPIENT,
    });
    expect(built.calls).toHaveLength(1);
    expect(built.calls[0]!.to.toLowerCase()).toBe(quote.entry.address.toLowerCase());
    expect(built.calls[0]!.metadata?.transactionType).toBe("transfer");
    const decoded = decodeFunctionData({ abi: erc20Abi, data: built.calls[0]!.data as `0x${string}` });
    expect(decoded.functionName).toBe("transfer");
    expect(decoded.args?.[0]?.toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect(decoded.args?.[1]).toBe(quote.sharesRaw);
    expect(built.label).toMatch(/from wallet/i);
    expect(built.calls.every((c) => c.to.toLowerCase() !== USDC.toLowerCase())).toBe(true);
  });

  it("appends the USDC fee only when charged", () => {
    const quote = appleQuote();
    const built = buildStockTransferCalls({
      quote,
      recipientAddress: RECIPIENT,
      feeUsd: 0.25,
    });
    expect(built.calls).toHaveLength(2);
    expect(built.calls[1]!.to.toLowerCase()).toBe(USDC.toLowerCase());
    const decoded = decodeFunctionData({ abi: erc20Abi, data: built.calls[1]!.data as `0x${string}` });
    expect(decoded.functionName).toBe("transfer");
    expect(built.label).toMatch(/0\.25 fee/);
  });
});
