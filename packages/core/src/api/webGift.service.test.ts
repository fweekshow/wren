import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEmbeddedWallet: vi.fn(),
  getReceiveAddress: vi.fn(),
  listContacts: vi.fn(),
  quoteStockGift: vi.fn(),
  createGift: vi.fn(),
  abandonUnpaidCheckouts: vi.fn(),
  setFundSessionToken: vi.fn(),
  createIntent: vi.fn(),
  maybeAutoSaveContact: vi.fn(),
}));

vi.mock("@/discovery/adapters/wallet.adapter.js", () => ({
  WalletAdapter: {
    getEmbeddedWallet: mocks.getEmbeddedWallet,
    getReceiveAddress: mocks.getReceiveAddress,
  },
}));
vi.mock("@/messaging/contacts.adapter.js", () => ({
  ContactsAdapter: {
    listContacts: mocks.listContacts,
    normalizeHandle: (raw: string | null | undefined) => {
      if (!raw) return null;
      const cleaned = raw.replace(/[^\d+]/g, "");
      return /^\+\d{7,15}$/.test(cleaned) ? cleaned : null;
    },
  },
}));
vi.mock("@/discovery/stocks/giftStock.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/discovery/stocks/giftStock.service.js")>();
  return {
    ...actual,
    quoteStockGift: mocks.quoteStockGift,
  };
});
vi.mock("@/wallet/stockGift.js", () => ({
  StockGiftAdapter: {
    create: mocks.createGift,
    abandonUnpaidCheckouts: mocks.abandonUnpaidCheckouts,
    setFundSessionToken: mocks.setFundSessionToken,
  },
}));
vi.mock("@/wallet/fundSession.js", () => ({
  GIFT_FUND_SESSION_TTL_MS: 45 * 60 * 1000,
  FundSessionAdapter: { createIntent: mocks.createIntent },
}));
vi.mock("@/messaging/utils/autoSaveContact.utils.js", () => ({
  maybeAutoSaveContact: mocks.maybeAutoSaveContact,
}));
vi.mock("@/config/config.js", () => ({
  config: {
    env: "test",
    cdp: { fundPageUrl: "https://app.basemate.app/pay" },
    payPage: { origin: "https://app.basemate.app" },
  },
}));
vi.mock("@/utils/logger.js", () => ({
  logger: { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} },
}));
vi.mock("@/discovery/doppler/stockCatalog.js", () => ({
  listSpotBuyableOffers: () => [{ symbol: "AAPLc", name: "Apple" }],
}));

import { createWebStockGiftCheckout, listPublicStocks, WebGiftError } from "./webGift.service.js";

const quote = {
  entry: { symbol: "AAPLc", address: "0xb200", decimals: 8, name: "Apple" },
  plainName: "Apple stock",
  sharesHuman: "0.1",
  sharesRaw: 10_000_000n,
  usdcCostHuman: "25",
  usdcCostRaw: 25_000_000n,
  notionalUsd: 25,
  maxUsd: 25,
  sharePriceUsd: 250,
  priceSource: "chainlink" as const,
  isUsd: true,
  amountLabel: "$25 of Apple stock",
};

beforeEach(() => {
  mocks.getEmbeddedWallet.mockReset();
  mocks.getReceiveAddress.mockReset();
  mocks.listContacts.mockReset();
  mocks.quoteStockGift.mockReset();
  mocks.createGift.mockReset();
  mocks.abandonUnpaidCheckouts.mockReset();
  mocks.setFundSessionToken.mockReset();
  mocks.createIntent.mockReset();
  mocks.maybeAutoSaveContact.mockReset();
  mocks.getEmbeddedWallet.mockResolvedValue({ address: "0x" + "a".repeat(40) });
  mocks.getReceiveAddress.mockResolvedValue(null);
  mocks.listContacts.mockResolvedValue([]);
  mocks.quoteStockGift.mockResolvedValue({ ok: true, quote });
  mocks.createGift.mockResolvedValue({ id: "gift1" });
  mocks.abandonUnpaidCheckouts.mockResolvedValue(0);
  mocks.createIntent.mockResolvedValue("tok123");
});

describe("createWebStockGiftCheckout", () => {
  it("returns 404 when the sender has no embedded wallet", async () => {
    mocks.getEmbeddedWallet.mockResolvedValue(null);
    await expect(
      createWebStockGiftCheckout({
        senderId: "+15550001111",
        channel: "imessage",
        symbol: "AAPL",
        usd: "25",
        recipient: { phone: "+15550002222" },
      }),
    ).rejects.toMatchObject({ name: "WebGiftError", status: 404 });
  });

  it("requires a country-coded phone", async () => {
    await expect(
      createWebStockGiftCheckout({
        senderId: "+15550001111",
        channel: "imessage",
        symbol: "AAPL",
        usd: "25",
        recipient: { phone: "5550002222" },
      }),
    ).rejects.toBeInstanceOf(WebGiftError);
  });

  it("returns an Apple Pay URL and never sends from holdings", async () => {
    const result = await createWebStockGiftCheckout({
      senderId: "+15550001111",
      channel: "imessage",
      symbol: "AAPL",
      usd: "25",
      recipient: { name: "Alex", phone: "+15550002222" },
    });
    expect(result).toEqual({
      status: "pay",
      payUrl: "https://app.basemate.app/pay?s=tok123",
      giftId: "gift1",
      chargeUsd: 25.9,
      amountLabel: "$25 of Apple stock",
    });
    expect(mocks.createIntent).toHaveBeenCalled();
    expect(mocks.setFundSessionToken).toHaveBeenCalledWith("gift1", "tok123");
    expect(mocks.abandonUnpaidCheckouts).toHaveBeenCalledWith(
      expect.objectContaining({ exceptGiftId: "gift1" }),
    );
  });
});

describe("listPublicStocks", () => {
  it("returns spot-buyable catalog entries", () => {
    expect(listPublicStocks()).toEqual([{ symbol: "AAPLc", name: "Apple" }]);
  });
});
