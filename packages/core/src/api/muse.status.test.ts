import { describe, expect, it } from "vitest";

import { formatRecipientLine, museSendStatus, publicMuseSend } from "./muse.status.js";
import type { StockGiftRow } from "@/wallet/stockGift.js";

function gift(over: Partial<StockGiftRow>): StockGiftRow {
  return {
    id: "g1",
    senderId: "sender",
    walletAddress: "0xabc",
    fundSessionToken: "tok",
    intent: {
      kind: "gift_stock",
      symbol: "AAPLc",
      usd: "5",
      quotedAt: new Date().toISOString(),
      maxUsd: 5,
      recipient: {
        kind: "claim_phone",
        phone: "+15555550123",
        display: "Sam",
      },
    },
    amountUsd: 5,
    coinbaseOrderId: null,
    giftStartedAt: null,
    giftTxHash: null,
    giftFailedAt: null,
    retryCount: 0,
    claimUrl: null,
    createdAt: new Date(),
    ...over,
  };
}

describe("museSendStatus", () => {
  it("maps unpaid / buying / sent / failed", () => {
    expect(museSendStatus(gift({}))).toBe("awaiting_payment");
    expect(museSendStatus(gift({ giftStartedAt: new Date() }))).toBe("buying");
    expect(museSendStatus(gift({ giftTxHash: "0x1" }))).toBe("sent");
    expect(museSendStatus(gift({ giftFailedAt: new Date() }))).toBe("failed");
  });

  it("exposes claimUrl and recipient line", () => {
    const pub = publicMuseSend(gift({ giftTxHash: "0x1", claimUrl: "https://basemate.app/claim/x" }));
    expect(pub.claimUrl).toBe("https://basemate.app/claim/x");
    expect(pub.tellReceiver).toContain("https://basemate.app/claim/x");
    expect(pub.tellSender).toContain("forward the claim link above");
    expect(pub.tellSender).not.toContain("direct line");
    expect(pub.headline).toBe("Stock is ready to send");
    expect(pub.recipientLine).toBe("Sam (+15555550123)");
    expect(pub.sayThis).toBe("Stock is ready to send to Sam (+15555550123)");
    expect(pub.recipientDisplay).toBe("Sam (+15555550123)");
    expect(pub.delivery).toBe("claim");
    expect(pub.alreadyOnBasemate).toBe(false);
    expect(formatRecipientLine("Degeneer", "+15551212")).toBe("Degeneer (+15551212)");
  });

  it("wallet recipients get no claim link copy", () => {
    const pub = publicMuseSend(
      gift({
        giftTxHash: "0x1",
        claimUrl: "https://basemate.app/claim/should-hide",
        intent: {
          kind: "gift_stock",
          symbol: "TSLAc",
          usd: "2",
          quotedAt: new Date().toISOString(),
          maxUsd: 2,
          recipient: {
            kind: "wallet",
            address: "0xabc",
            phone: "+15555550123",
            display: "Mom (+15555550123)",
            name: "Mom",
          },
        },
      }),
    );
    expect(pub.alreadyOnBasemate).toBe(true);
    expect(pub.delivery).toBe("wallet");
    expect(pub.claimUrl).toBeNull();
    expect(pub.tellSender).toContain("no claim link");
    expect(pub.tellReceiver).toContain("No claim needed");
    expect(pub.tellSender).not.toContain("claim/should-hide");
  });
});
