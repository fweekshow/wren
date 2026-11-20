import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/conversationState.store.js", () => ({
  convKey: (platform: string, scope: string, slot: string) => `${platform}:${scope}:${slot}`,
  stateSet: vi.fn(async () => undefined),
  stateGet: vi.fn(async () => null),
  stateDelete: vi.fn(async () => undefined),
}));

import {
  PendingPayConfirmationPoller,
  buildPendingPayConfirmationMessage,
} from "./pendingPayConfirmationPoller.js";
import type { PendingPayRow } from "./pendingPay.js";

function row(overrides: Partial<PendingPayRow> = {}): PendingPayRow {
  return {
    token: "a".repeat(32),
    senderId: "+15550001111",
    fromAddress: "0x9999999999999999999999999999999999999999",
    chainId: "0x2105",
    calls: [],
    label: "Send 2 USDC to Sarah — sign below:",
    recipientDisplay: null,
    amount: "2",
    tokenSymbol: "USDC",
    walletKind: "embedded",
    conversationId: null,
    isGroup: false,
    deliveryPhone: null,
    copyTradeContext: null,
    status: "signed",
    txHash: `0x${"1".repeat(64)}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as PendingPayRow;
}

describe("PendingPayConfirmationPoller", () => {
  it("cleans the sign CTA out and points to in-app activity, not Basescan", () => {
    expect(buildPendingPayConfirmationMessage(row(), "success")).toBe(
      "sent. 2 USDC to Sarah.\n\nview your activity in the app",
    );
    expect(buildPendingPayConfirmationMessage(row(), "success")).not.toContain("basescan.org");
    expect(buildPendingPayConfirmationMessage(row(), "reverted")).toContain("didn't go through");
  });

  it("uses the clean swap receipt for Flash confirms, not the fee preview label", () => {
    const flashRow = row({
      executionKind: "flash",
      label: "Buy .1 USDC of BASEMATE\nest. ~$0.09 · ~$0.01 fees",
      flashPrepared: {
        quoteId: "q",
        orderType: "market",
        side: "buy",
        targetAsset: "0x07e61d8a4e197dfc269e90d7ece1df0d26702ba3",
        contraAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        targetSymbol: "BASEMATE",
        contraSymbol: "USDC",
        qty: "0.1",
        funderAddress: "0xC5b7653AF1570Ba70ebCBb542962a59c108Bdbf7",
        orderTypedData: "{}",
        approveTx: null,
        estimatedFeeNotional: "0.01",
        fromNotional: "0.1",
        toNotional: "0.09",
        fromAmount: "0.1",
        toAmount: "50000",
      },
    });
    expect(buildPendingPayConfirmationMessage(flashRow, "success")).toBe(
      "✅ Swap confirmed\n\nSpent: $0.1 USDC\nGot: 50k Basemate\n\nview your activity in the app",
    );
    expect(buildPendingPayConfirmationMessage(flashRow, "success")).not.toContain("fees");
    expect(buildPendingPayConfirmationMessage(flashRow, "success")).not.toContain("Buy .1");
  });

  it("keeps group confirmations tidy with no explorer link", () => {
    const groupRow = row({
      conversationId: "any;+;group-1",
      isGroup: true,
      copyTradeContext: {
        type: "swap",
        fromSymbol: "USDC",
        fromAddress: "0x1",
        fromDecimals: 6,
        toSymbol: "ETH",
        toAddress: "0x2",
        amount: "0.1",
      },
    });
    expect(buildPendingPayConfirmationMessage(groupRow, "success")).toBe(
      "sent. 2 USDC to Sarah.\n\nReply COPY to copy this trade.",
    );
    expect(buildPendingPayConfirmationMessage(groupRow, "success")).not.toContain("basescan.org");
  });

  it("confirms a mined tx once and delivers to the sender", async () => {
    const deliver = vi.fn(async () => true);
    const markConfirmed = vi.fn(async () => true);
    const poller = new PendingPayConfirmationPoller({
      listSigned: async () => [row()],
      getReceipt: async () => "success",
      markConfirmed,
      markFailed: async () => false,
      deliver,
    });

    const result = await poller.tickOnce();

    expect(result).toEqual({ checked: 1, confirmed: 1, failed: 0, delivered: 1 });
    expect(markConfirmed).toHaveBeenCalledWith("a".repeat(32));
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ senderId: "+15550001111" }),
      expect.stringContaining("view your activity in the app"),
    );
  });

  it("preserves the originating group route and copy prompt, no Basescan DM", async () => {
    const groupRow = row({
      conversationId: "any;+;group-1",
      isGroup: true,
      deliveryPhone: "+15559990000",
      copyTradeContext: {
        type: "perp",
        pair: "ETH-USD",
        side: "long",
        leverage: 5,
        collateral: "25",
        orderType: "market",
      },
    });
    const deliver = vi.fn(async () => true);
    const deliverDm = vi.fn(async () => true);
    const poller = new PendingPayConfirmationPoller({
      listSigned: async () => [groupRow],
      getReceipt: async () => "success",
      markConfirmed: async () => true,
      markFailed: async () => false,
      deliver,
      deliverDm,
    });

    await poller.tickOnce();

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "any;+;group-1",
        deliveryPhone: "+15559990000",
      }),
      expect.stringContaining("Reply COPY to copy this trade."),
    );
    expect(deliver.mock.calls[0]?.[1]).not.toContain("basescan.org");
    // Chat no longer DMs explorer links — activity lives in the app.
    expect(deliverDm).not.toHaveBeenCalled();
  });

  it("skips rows that are not mined yet", async () => {
    const deliver = vi.fn(async () => true);
    const poller = new PendingPayConfirmationPoller({
      listSigned: async () => [row()],
      getReceipt: async () => null,
      markConfirmed: async () => true,
      markFailed: async () => true,
      deliver,
    });

    const result = await poller.tickOnce();

    expect(result.confirmed).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("does not deliver twice when the transition was already won", async () => {
    const deliver = vi.fn(async () => true);
    const poller = new PendingPayConfirmationPoller({
      listSigned: async () => [row()],
      getReceipt: async () => "success",
      markConfirmed: async () => false, // lost the race
      markFailed: async () => false,
      deliver,
    });

    const result = await poller.tickOnce();

    expect(result.confirmed).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });
});
