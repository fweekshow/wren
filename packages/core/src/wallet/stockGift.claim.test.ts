import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config/config.js", () => ({
  config: {
    env: "test",
    payPage: { origin: "https://app.basemate.app" },
  },
}));
vi.mock("@/utils/logger.js", () => ({
  logger: { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} },
}));
vi.mock("@/discovery/db.js", () => ({
  db: {
    query: vi.fn(),
  },
}));

import { db } from "@/discovery/db.js";
import { StockGiftAdapter } from "@/wallet/stockGift.js";

const query = vi.mocked(db.query);

beforeEach(() => {
  query.mockReset();
});

describe("StockGiftAdapter.claimGiftStart", () => {

  it("returns the row for the single winner", async () => {
    const row = {
      id: "gift1",
      sender_id: "+15551234567",
      wallet_address: "0xabc",
      fund_session_token: null,
      intent: {
        kind: "gift_stock",
        symbol: "AAPLc",
        qty: "1",
        recipient: { kind: "wallet", address: "0xdef", display: "mom" },
        quotedAt: new Date().toISOString(),
        maxUsd: 320,
      },
      amount_usd: 320,
      coinbase_order_id: "ord_1",
      gift_started_at: new Date().toISOString(),
      gift_tx_hash: null,
      gift_failed_at: null,
      retry_count: 0,
      claim_url: null,
      created_at: new Date().toISOString(),
    };
    query.mockResolvedValueOnce({ rows: [] } as never); // ensureTable CREATE
    query.mockResolvedValueOnce({ rows: [row] } as never);

    const claimed = await StockGiftAdapter.claimGiftStart("gift1", {
      coinbaseOrderId: "ord_1",
    });
    expect(claimed?.id).toBe("gift1");
    expect(claimed?.coinbaseOrderId).toBe("ord_1");
  });

  it("returns null when a second caller loses the race", async () => {
    query.mockResolvedValueOnce({ rows: [] } as never);
    query.mockResolvedValueOnce({ rows: [] } as never);
    const claimed = await StockGiftAdapter.claimGiftStart("gift1");
    expect(claimed).toBeNull();
  });
});

describe("StockGiftAdapter.abandonUnpaidCheckouts", () => {
  it("marks unpaid Apple Pay rows failed except the current gift", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 2 } as never);
    const n = await StockGiftAdapter.abandonUnpaidCheckouts({
      senderId: "+15551234567",
      walletAddress: "0xabc",
      exceptGiftId: "gift1",
    });
    expect(n).toBe(2);
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/SET gift_failed_at = NOW\(\)/),
      ["+15551234567", "0xabc", "gift1"],
    );
  });
});
