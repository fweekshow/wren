import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config/config.js", () => ({
  config: {
    env: "test",
    payPage: { origin: "https://app.basemate.app" },
    cdp: { fundPageUrl: "https://app.basemate.app/pay" },
  },
}));
vi.mock("@/utils/logger.js", () => ({
  logger: { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} },
}));

const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  queries: [] as string[],
  lockFree: true,
  sendCalls: [] as unknown[],
  builtVia: [] as string[],
  readErc20Balance: 0n,
}));

vi.mock("@/discovery/db.js", () => ({
  db: {
    async query(sql: string) {
      state.queries.push(sql.replace(/\s+/g, " ").trim());
      if (/^SELECT \* FROM stock_gifts WHERE id/.test(sql.trim())) {
        return { rows: state.row ? [state.row] : [], rowCount: state.row ? 1 : 0 };
      }
      if (/UPDATE stock_gifts SET gift_started_at = NOW\(\)/.test(sql)) {
        return { rows: state.row ? [{ ...state.row, gift_started_at: new Date() }] : [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  },
}));
vi.mock("@/state/conversationState.store.js", () => ({
  acquireLock: async () => state.lockFree,
  releaseLock: async () => {},
}));
vi.mock("@/discovery/adapters/wallet.adapter.js", () => ({
  WalletAdapter: {
    getEmbeddedWallet: async () => ({ cdpUserId: "cdp-1", address: "0x" + "a".repeat(40) }),
  },
}));
vi.mock("@/wallet/embeddedWallet.js", () => ({
  EmbeddedWalletError: class extends Error {
    needsReauth = false;
  },
  EmbeddedWalletAdapter: {
    sendCalls: async (args: unknown) => {
      state.sendCalls.push(args);
      return { txHash: "0xtx" };
    },
  },
}));
vi.mock("@/wallet/phoneEscrow.js", () => ({ PhoneEscrowAdapter: {} }));
vi.mock("@/wallet/fundingNotify.js", () => ({ sendFundingConfirmDm: () => {} }));
vi.mock("@/wallet/walletSetupSession.js", () => ({
  WalletSetupSessionAdapter: { create: async () => "setup" },
  CLAIM_SESSION_TTL_MS: 1,
}));
vi.mock("@/discovery/adapters/txConfirmation.adapter.js", () => ({
  TxConfirmationAdapter: { recordConfirmedActivity: async () => "sid" },
}));
vi.mock("@/chain/base-rpc.js", () => ({ resolveBaseRpcUrl: () => "http://rpc.invalid" }));
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({ readContract: async () => 10n ** 12n }),
  };
});

const quote = {
  entry: { address: "0x" + "b".repeat(40), symbol: "AAPL", decimals: 6 },
  symbol: "AAPL",
  isUsd: true,
  notionalUsd: 2,
  maxUsd: 2,
  sharesRaw: 900_000n,
  sharesHuman: "0.9",
  usdcCostRaw: 2_000_000n,
  usdcCostHuman: "2",
  amountLabel: "$2 of Apple",
  plainName: "Apple",
  sharePriceUsd: 2.2,
};

vi.mock("@/discovery/stocks/giftStock.service.js", () => ({
  quoteStockGift: async () => ({ ok: true, quote }),
  giftSpendUsd: () => 2,
  ourStockGiftFeeUsd: () => 0.02,
  readErc20Balance: async () => state.readErc20Balance,
  buildStockTransferCalls: () => {
    state.builtVia.push("holdings");
    return { calls: [{ to: "0x1", value: "0x0", data: "0x" }], label: "holdings", estimatedShares: "0.9" };
  },
  buildStockBuyAndTransferCalls: async () => {
    state.builtVia.push("buy");
    return { calls: [{ to: "0x1", value: "0x0", data: "0x" }], label: "buy", estimatedShares: "0.9" };
  },
  buildStockEscrowCalls: () => {
    throw new Error("not expected");
  },
  buildStockBuyAndEscrowCalls: async () => {
    throw new Error("not expected");
  },
}));

import { fulfillStockGift, startStockGiftAfterFunding } from "./stockGift.js";

function giftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "g1",
    sender_id: "+15550001111",
    wallet_address: "0x" + "a".repeat(40),
    fund_session_token: null,
    intent: {
      kind: "gift_stock",
      symbol: "AAPL",
      usd: "2",
      recipient: { kind: "wallet", address: "0x" + "c".repeat(40), display: "+15550002222", phone: "+15550002222" },
      quotedAt: new Date().toISOString(),
      maxUsd: 2,
    },
    amount_usd: 2.02,
    coinbase_order_id: null,
    gift_started_at: new Date(),
    gift_tx_hash: null,
    gift_failed_at: null,
    retry_count: 0,
    claim_url: null,
    created_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  state.row = null;
  state.queries = [];
  state.lockFree = true;
  state.sendCalls = [];
  state.builtVia = [];
  state.readErc20Balance = 0n;
});

describe("fulfillStockGift", () => {
  it("refuses to run while another fulfil holds the gift lock", async () => {
    state.row = giftRow();
    state.lockFree = false;
    const result = await fulfillStockGift("g1");
    expect(result).toEqual({ ok: false, error: "gift already in progress" });
    expect(state.sendCalls).toHaveLength(0);
    expect(state.queries.some((q) => q.startsWith("UPDATE"))).toBe(false);
  });

  it("buys with the onramp USDC even when the wallet already holds the stock", async () => {
    state.row = giftRow({ fund_session_token: "abc123abc123abc123abc" });
    state.readErc20Balance = 5_000_000n;
    const result = await fulfillStockGift("g1", { notifySender: false });
    expect(result.ok).toBe(true);
    expect(state.builtVia).toEqual(["buy"]);
  });

  it("sends from holdings for a wallet-funded gift when the balance covers it", async () => {
    state.row = giftRow({ fund_session_token: null });
    state.readErc20Balance = 5_000_000n;
    const result = await fulfillStockGift("g1", { notifySender: false });
    expect(result.ok).toBe(true);
    expect(state.builtVia).toEqual(["holdings"]);
  });
});

describe("startStockGiftAfterFunding", () => {
  it("does not re-run a gift another trigger started moments ago", async () => {
    state.row = giftRow({ gift_started_at: new Date(Date.now() - 5_000) });
    const id = await startStockGiftAfterFunding({ giftId: "g1" });
    expect(id).toBe("g1");
    await new Promise((r) => setTimeout(r, 10));
    expect(state.sendCalls).toHaveLength(0);
  });

  it("picks up a gift whose previous run went stale", async () => {
    state.row = giftRow({ gift_started_at: new Date(Date.now() - 15 * 60_000) });
    await startStockGiftAfterFunding({ giftId: "g1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(state.sendCalls).toHaveLength(1);
  });
});
