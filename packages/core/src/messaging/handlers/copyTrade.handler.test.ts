import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: new Map<string, unknown>(),
  getEmbeddedWallet: vi.fn(),
  buildRoutedSwap: vi.fn(),
  prepareAvantisOpen: vi.fn(),
  executeUserTransaction: vi.fn(),
}));

vi.mock("@/state/conversationState.store.js", () => ({
  stateGet: vi.fn(async (key: string) => mocks.state.get(key) ?? null),
  stateSet: vi.fn(async (key: string, value: unknown) => {
    mocks.state.set(key, value);
  }),
  stateDelete: vi.fn(async (key: string) => {
    mocks.state.delete(key);
  }),
}));
vi.mock("@/discovery/adapters/wallet.adapter.js", () => ({
  WalletAdapter: { getEmbeddedWallet: mocks.getEmbeddedWallet },
}));
vi.mock("@/discovery/ai/tools/swap.js", () => ({
  buildRoutedSwap: mocks.buildRoutedSwap,
}));
vi.mock("@/discovery/ai.js", () => ({
  normalizeAvantisPair: (pair: string) => pair,
  prepareAvantisOpen: mocks.prepareAvantisOpen,
}));
vi.mock("./wallet.handler.js", () => ({
  executeUserTransaction: mocks.executeUserTransaction,
}));

import type { HandlerCtx } from "../handler.ctx.js";
import type { PendingGroupCopyTrade } from "../handler.types.js";
import { handleCopyTradeText } from "./copyTrade.handler.js";

const ctx = {
  K: {
    pendingGroupCopyTrade: (conversationId: string) => `group:${conversationId}`,
    pendingCopyTradeAmount: (scopeId: string) => `amount:${scopeId}`,
  },
} as unknown as HandlerCtx;

const swapCopy: PendingGroupCopyTrade = {
  type: "swap",
  fromSymbol: "USDC",
  fromAddress: "0x1111111111111111111111111111111111111111",
  fromDecimals: 6,
  toSymbol: "ETH",
  toAddress: "0x2222222222222222222222222222222222222222",
  amount: "25",
  label: "Swap 25 USDC → ETH",
  originSenderId: "+15550000001",
  expiresAt: Date.now() + 60_000,
};

describe("handleCopyTradeText", () => {
  beforeEach(() => {
    mocks.state.clear();
    vi.clearAllMocks();
    mocks.getEmbeddedWallet.mockResolvedValue({
      address: "0x3333333333333333333333333333333333333333",
    });
    mocks.buildRoutedSwap.mockResolvedValue({
      calls: [{ to: "0x4444444444444444444444444444444444444444", value: "0x0", data: "0x" }],
      label: "Swap 25 USDC → ETH",
    });
    mocks.executeUserTransaction.mockResolvedValue(["prepared"]);
  });

  it("rejects the original trader", async () => {
    mocks.state.set("group:group-1", swapCopy);

    const result = await handleCopyTradeText(ctx, {
      senderId: swapCopy.originSenderId,
      conversationId: "group-1",
      isGroup: true,
      text: "COPY",
    });

    expect(result?.[0]).toContain("your own trade");
  });

  it("copies a swap for another member using the same amount", async () => {
    mocks.state.set("group:group-1", swapCopy);

    const prompt = await handleCopyTradeText(ctx, {
      senderId: "+15550000002",
      conversationId: "group-1",
      isGroup: true,
      text: "COPY",
    });
    expect(prompt?.[0]).toContain('Reply "same"');

    const result = await handleCopyTradeText(ctx, {
      senderId: "+15550000002",
      conversationId: "group-1",
      isGroup: true,
      text: "same",
    });

    expect(mocks.buildRoutedSwap).toHaveBeenCalledWith(
      swapCopy.fromAddress,
      "USDC",
      6,
      swapCopy.toAddress,
      "ETH",
      "25",
      "0x3333333333333333333333333333333333333333",
    );
    expect(mocks.executeUserTransaction).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        senderId: "+15550000002",
        amountUsd: 25,
        tradeContext: expect.objectContaining({
          conversationId: "group-1",
          isGroup: true,
          originSenderId: "+15550000002",
        }),
      }),
    );
    expect(result).toEqual(["prepared"]);
  });

  it("uses a custom collateral amount for a copied perp", async () => {
    const perpCopy: PendingGroupCopyTrade = {
      type: "perp",
      pair: "ETH-USD",
      side: "long",
      leverage: 5,
      collateral: "20",
      orderType: "limit",
      openPrice: "2500",
      label: "Long ETH 5x",
      originSenderId: "+15550000001",
      expiresAt: Date.now() + 60_000,
    };
    mocks.state.set("group:group-1", perpCopy);
    mocks.prepareAvantisOpen.mockResolvedValue({
      ok: true,
      calls: [{ to: "0x5555555555555555555555555555555555555555", value: "0x0", data: "0x" }],
      label: "Long ETH 5x",
    });

    await handleCopyTradeText(ctx, {
      senderId: "+15550000003",
      conversationId: "group-1",
      isGroup: true,
      text: "COPY",
    });
    await handleCopyTradeText(ctx, {
      senderId: "+15550000003",
      conversationId: "group-1",
      isGroup: true,
      text: "$40",
    });

    expect(mocks.prepareAvantisOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        collateral: "40",
        orderType: "limit",
        openPrice: "2500",
      }),
    );
    expect(mocks.executeUserTransaction).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ amountUsd: 40 }),
    );
  });
});
