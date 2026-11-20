import { describe, expect, it } from "vitest";

import {
  assertSwapUsdWithinLimit,
  coerceUsdAmountFromUserMessage,
  extractUsdAmountFromMessage,
  isStablecoinAddress,
  parseSimpleUsdBuy,
  parseSimpleUsdSend,
  resolveUsdQuotedSwapAmount,
} from "./ai.js";

describe("parseSimpleUsdBuy", () => {
  it("parses buy $1 bnkr", () => {
    expect(parseSimpleUsdBuy("buy $1 bnkr")).toEqual({ amount: "1", toAsset: "bnkr" });
  });

  it("parses get $5 of BASEMATE", () => {
    expect(parseSimpleUsdBuy("get $5 of BASEMATE")).toEqual({
      amount: "5",
      toAsset: "BASEMATE",
    });
  });

  it("parses buy $50 of basemate", () => {
    expect(parseSimpleUsdBuy("buy $50 of basemate")).toEqual({
      amount: "50",
      toAsset: "basemate",
    });
  });

  it("parses buy $5 worth of bnkr", () => {
    expect(parseSimpleUsdBuy("buy $5 worth of bnkr")).toEqual({
      amount: "5",
      toAsset: "bnkr",
    });
  });

  it("parses @mention prefixed buy", () => {
    expect(parseSimpleUsdBuy("@askbasemate buy $5 of bnkr")).toEqual({
      amount: "5",
      toAsset: "bnkr",
    });
  });

  it("returns null for complex swap phrasing", () => {
    expect(parseSimpleUsdBuy("swap $5 eth for bnkr")).toBeNull();
  });
});

describe("parseSimpleUsdSend", () => {
  it("parses send $1 of basemate to a basename", () => {
    expect(parseSimpleUsdSend("send $1 of basemate to degeneer03.base.eth")).toEqual({
      to: "degeneer03.base.eth",
      amount: "1",
      asset: "basemate",
    });
  });

  it("ignores send to bare @mention", () => {
    expect(parseSimpleUsdSend("send $1 of basemate to @degeneer")).toBeNull();
    expect(parseSimpleUsdSend("send @yeeeee $1 of $basemate")).toBeNull();
  });

  it("parses explicit send phrasing with to", () => {
    expect(parseSimpleUsdSend("send $5 of USDC to jesse.base.eth")).toEqual({
      to: "jesse.base.eth",
      amount: "5",
      asset: "USDC",
    });
  });

  it("parses send $50 USDC to 0x address without of", () => {
    expect(
      parseSimpleUsdSend(
        "send $50 USDC to 0xae52ed21a8c567e0e42f1801bed37c6f90236734",
      ),
    ).toEqual({
      to: "0xae52ed21a8c567e0e42f1801bed37c6f90236734",
      amount: "50",
      asset: "USDC",
    });
  });

  it("returns null for buy phrasing", () => {
    expect(parseSimpleUsdSend("buy $1 bnkr")).toBeNull();
  });
});

describe("coerceUsdAmountFromUserMessage", () => {
  it("corrects a billion-dollar model hallucination on a $1 buy", () => {
    expect(
      coerceUsdAmountFromUserMessage("1000000000", "buy $1 bnkr"),
    ).toBe("1");
  });

  it("keeps matching amounts", () => {
    expect(coerceUsdAmountFromUserMessage("5", "buy $5 bnkr")).toBe("5");
  });
});

describe("extractUsdAmountFromMessage", () => {
  it("extracts the first dollar amount", () => {
    expect(extractUsdAmountFromMessage("@askbasemate buy $1 bnkr")).toBe("1");
  });
});

describe("isStablecoinAddress", () => {
  it("recognizes USDC on Base", () => {
    expect(isStablecoinAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")).toBe(true);
  });
});

describe("resolveUsdQuotedSwapAmount", () => {
  it("fixes raw USDC base units when LLM omits isUsd on buy $5", () => {
    expect(
      resolveUsdQuotedSwapAmount({
        modelAmount: "5000000",
        userMessage: "buy $5 of bnkr",
        fromStablecoin: true,
        isUsd: false,
      }),
    ).toEqual({ amount: "5", isUsd: true });
  });

  it("keeps token-denominated swap when user names ETH spend", () => {
    expect(
      resolveUsdQuotedSwapAmount({
        modelAmount: "5",
        userMessage: "swap $5 eth for bnkr",
        fromStablecoin: false,
        isUsd: true,
      }),
    ).toEqual({ amount: "5", isUsd: true });
  });

  it("uses the matching dollar amount in multi-transfer bundle labels", () => {
    expect(
      resolveUsdQuotedSwapAmount({
        modelAmount: "1",
        userMessage: "send Send $25 USDC + $1 ETH (gas) to your Basemate Wallet to 0xabc",
        fromStablecoin: false,
        isUsd: true,
      }),
    ).toEqual({ amount: "1", isUsd: true });
  });
});

describe("assertSwapUsdWithinLimit", () => {
  it("allows normal retail sizes", () => {
    expect(assertSwapUsdWithinLimit("1")).toBeNull();
  });

  it("rejects absurd amounts", () => {
    expect(assertSwapUsdWithinLimit("1000000000")).toMatch(/over/i);
  });
});
