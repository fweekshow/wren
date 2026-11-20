import { describe, expect, it, vi } from "vitest";

vi.mock("@/config/config.js", () => ({
  config: {
    env: "test",
    payPage: { origin: "https://app.basemate.app" },
    cdp: { fundPageUrl: "https://app.basemate.app/pay" },
    phoneEscrow: { enabled: true, contractAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", phoneHashSalt: "test" },
  },
}));

vi.mock("@/discovery/ai/tools/swap.js", () => ({
  buildSlipstreamUsdcToTokenSwap: vi.fn(),
  getSlipstreamUsdcPoolPriceUsd: vi.fn(async () => 300),
}));

vi.mock("@/discovery/doppler/stockRegistry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/discovery/doppler/stockRegistry.js")>();
  return {
    ...actual,
    resolveStockNumerairePrice: vi.fn(async () => ({
      priceUsd: 300,
      updatedAt: new Date(),
      ageMs: 1000,
      paused: false,
      inMarketHours: true,
    })),
  };
});

import { parseGiftStock } from "@/discovery/ai/intents.js";
import {
  giftChargeUsd,
  giftOnrampUsd,
  quoteStockGift,
  resolveStockGiftTreasury,
} from "@/discovery/stocks/giftStock.service.js";
import {
  formatGiftApplePayLink,
  formatGiftHoldingsNudge,
  formatGiftNotePrompt,
  formatGiftPayNudge,
  formatGiftSent,
  looksLikeCancelGift,
  looksLikeGiftApplePay,
  looksLikeRetryGift,
  type PendingGiftStock,
} from "@/discovery/ai/tools/giftStock.handlers.js";
import {
  isSpotBuyableStock,
  resolveStockToken,
} from "@/discovery/doppler/stockRegistry.js";

describe("resolve B20 catalog", () => {
  it("resolves Apple / AAPL / AAPLc at 8 decimals", () => {
    expect(resolveStockToken("Apple")?.symbol).toBe("AAPLc");
    expect(resolveStockToken("AAPL")?.decimals).toBe(8);
    expect(resolveStockToken("AAPLc")?.address.toLowerCase()).toBe(
      "0xb200000000000000000000c2e324d24d7eecd1fb",
    );
    expect(isSpotBuyableStock("NVDA")).toBe(true);
    expect(isSpotBuyableStock("TSLA")).toBe(true);
    expect(isSpotBuyableStock("MU")).toBe(true);
    expect(isSpotBuyableStock("PLTR")).toBe(true);
    expect(isSpotBuyableStock("RBLX")).toBe(true);
    expect(isSpotBuyableStock("INTC")).toBe(false);
    expect(resolveStockToken("NOTREAL")).toBeNull();
  });
});

describe("stock gift fee", () => {
  it("takes 1% on wallet sends", () => {
    expect(giftChargeUsd(5)).toEqual({
      stockUsd: 5,
      feeUsd: 0.05,
      ourFeeUsd: 0.05,
      onrampFeeUsd: 0,
      usdcNeeded: 5.05,
      totalUsd: 5.05,
    });
    expect(giftChargeUsd(200)).toEqual({
      stockUsd: 200,
      feeUsd: 2,
      ourFeeUsd: 2,
      onrampFeeUsd: 0,
      usdcNeeded: 202,
      totalUsd: 202,
    });
  });

  it("grosses up Apple Pay so Coinbase 2.5% leaves stock + 1%", () => {
    const apple = giftChargeUsd(5, { applePay: true });
    expect(apple.stockUsd).toBe(5);
    expect(apple.ourFeeUsd).toBe(0.05);
    expect(apple.usdcNeeded).toBe(5.05);
    // ceil(5.05 / 0.975) = 5.18
    expect(apple.totalUsd).toBe(5.18);
    expect(apple.feeUsd).toBe(0.18);
    const big = giftChargeUsd(200, { applePay: true });
    expect(big.usdcNeeded).toBe(202);
    // ceil(202 / 0.975) = 207.18
    expect(big.totalUsd).toBe(207.18);
    expect(big.feeUsd).toBe(7.18);
  });

  it("floors Apple Pay checkout at $2", () => {
    expect(giftOnrampUsd(1)).toBe(2);
    expect(giftOnrampUsd(5)).toBe(5.18);
  });

  it("does not inherit SWAP_FEE_RECIPIENT as the stock-send treasury", () => {
    const keys = ["STOCK_GIFT_FEE_TREASURY", "SWAP_FEE_RECIPIENT"] as const;
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    delete process.env.STOCK_GIFT_FEE_TREASURY;
    process.env.SWAP_FEE_RECIPIENT = "0x1111111111111111111111111111111111111111";
    try {
      expect(resolveStockGiftTreasury().toLowerCase()).toBe(
        "0xdf58fb99b8d1ece29869fa55317978a719696d81",
      );
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  });
});

describe("quoteStockGift", () => {
  it("quotes whole shares with USDC buffer", async () => {
    const q = await quoteStockGift({ symbol: "Apple", qty: "1" });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.quote.entry.decimals).toBe(8);
    expect(q.quote.isUsd).toBe(false);
    expect(q.quote.maxUsd).toBeGreaterThan(300);
    expect(q.quote.sharesHuman).toBe("1");
  });

  it("quotes dollar notional into fractional shares", async () => {
    const q = await quoteStockGift({ symbol: "AAPL", usd: "25" });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.quote.isUsd).toBe(true);
    expect(q.quote.notionalUsd).toBe(25);
    expect(q.quote.maxUsd).toBe(25);
    expect(Number(q.quote.sharesHuman)).toBeGreaterThan(0);
    expect(Number(q.quote.sharesHuman)).toBeLessThan(1);
  });

  it("rejects unknown symbols", async () => {
    const q = await quoteStockGift({ symbol: "FAKECOIN", qty: "1" });
    expect(q.ok).toBe(false);
  });
});

describe("parseGiftStock", () => {
  it("parses send mom 1 Apple stock", () => {
    expect(parseGiftStock("send mom 1 Apple stock")).toEqual({
      to: "mom",
      stock: "Apple",
      amount: "1",
      isUsd: false,
    });
  });

  it("parses gift dad $25 of NVDA", () => {
    expect(parseGiftStock("gift dad $25 of NVDA")).toEqual({
      to: "dad",
      stock: "NVDA",
      amount: "25",
      isUsd: true,
    });
  });

  it("parses send $10 of Apple to mom", () => {
    expect(parseGiftStock("send $10 of Apple to mom")).toEqual({
      to: "mom",
      stock: "Apple",
      amount: "10",
      isUsd: true,
    });
  });

  it("parses multi-word contact before $-amount (Leo Gonzalez)", () => {
    expect(parseGiftStock("Send Leo Gonzalez $2 of Apple stock")).toEqual({
      to: "Leo Gonzalez",
      stock: "Apple",
      amount: "2",
      isUsd: true,
    });
  });

  it("parses $-amount then multi-word contact (Leo Gonzalez)", () => {
    expect(parseGiftStock("Send $2 of Apple stock to Leo Gonzalez")).toEqual({
      to: "Leo Gonzalez",
      stock: "Apple",
      amount: "2",
      isUsd: true,
    });
  });

  it("does not steal plain USDC sends", () => {
    expect(parseGiftStock("send mom 10 usdc")).toBeNull();
    expect(parseGiftStock("send $10 to mom")).toBeNull();
  });
});

const pendingGift: PendingGiftStock = {
  createdAt: 1,
  step: "confirm",
  to: "Degeneer",
  stock: "Apple",
  amount: "3",
  isUsd: true,
  recipient: {
    kind: "wallet",
    address: "0x1111111111111111111111111111111111111111",
    display: "Degeneer (+919330266945)",
    name: "Degeneer",
  },
  quote: {
    plainName: "Apple stock",
    amountLabel: "$5 of Apple stock",
    usdcCostHuman: "5",
    notionalUsd: 5,
    maxUsd: 5,
    sharesHuman: "0.009",
    symbol: "AAPLc",
    sharePriceUsd: 317.07,
  },
};

describe("gift stock copy", () => {
  it("says what we are doing without gift for or a phone dump", () => {
    const note = formatGiftNotePrompt({ ...pendingGift, step: "note" });
    expect(note).toContain("I'm going to send $5 of Apple stock to Degeneer.");
    expect(note).toContain("Want to add a note? Type anything, or say skip.");
    expect(note).not.toMatch(/gift for/i);
    expect(note).not.toContain("919330266945");
    expect(note).not.toContain("—");
  });

  it("says from your account in the note prompt when they already hold it", () => {
    const note = formatGiftNotePrompt({ ...pendingGift, step: "note", hasWalletStock: true });
    expect(note).toContain("I'm going to send $5 of Apple stock from your account to Degeneer.");
    expect(note).not.toContain("SWAP");
  });

  it("nudges Apple Pay only, not YES or SWAP", () => {
    expect(formatGiftPayNudge(pendingGift)).toBe(
      "Reply APPLE PAY for the link, or NO to cancel sending $5 of Apple stock.",
    );
    expect(formatGiftHoldingsNudge(pendingGift)).toBe(
      "Reply YES to send $5 of Apple stock from your account, or NO to cancel.",
    );
  });

  it("sends one plain confirmation from the account", () => {
    const sent = formatGiftSent(pendingGift);
    expect(sent).toBe("Sent $5 of Apple stock to Degeneer from your account.");
    expect(sent).not.toContain("✅");
  });

  it("shows name · formatted phone for named contacts", () => {
    const named: PendingGiftStock = {
      ...pendingGift,
      recipient: {
        kind: "claim_phone",
        phone: "+14155550123",
        display: "Degeneer",
        name: "Degeneer",
      },
    };
    expect(formatGiftNotePrompt(named)).toContain("to Degeneer · +1 (415) 555-0123.");
  });

  it("treats Apple Pay replies and ignores a lone apple", () => {
    expect(looksLikeGiftApplePay("apple pay")).toBe(true);
    expect(looksLikeGiftApplePay("use apple pay")).toBe(true);
    expect(looksLikeGiftApplePay("pay")).toBe(true);
    expect(looksLikeGiftApplePay("apple")).toBe(false);
    expect(looksLikeGiftApplePay("APPLE")).toBe(false);
    expect(looksLikeGiftApplePay("yes")).toBe(false);
    expect(looksLikeGiftApplePay("swap")).toBe(false);
  });

  it("puts the pay URL with the session token in the Apple Pay text", () => {
    const text = formatGiftApplePayLink({
      amountUsd: 25.9,
      fundUrl: "https://app.basemate.app/pay?s=aaaaaaaaaaaaaaaaaaaaa",
      amountLabel: "$25 of Apple stock",
      who: "Degeneer · +1 (415) 555-0123",
    });
    expect(text).toContain("https://app.basemate.app/pay?s=aaaaaaaaaaaaaaaaaaaaa");
    expect(text).toContain("After it clears I'll send $25 of Apple stock to Degeneer · +1 (415) 555-0123.");
    expect(text).not.toMatch(/Apple Pay onramp is US-only/i);
    expect(text).not.toMatch(/reply SWAP/i);
    expect(text).not.toContain("—");
  });

  it("recognizes cancel and retry", () => {
    expect(looksLikeCancelGift("cancel")).toBe(true);
    expect(looksLikeCancelGift("NO")).toBe(true);
    expect(looksLikeRetryGift("retry gift")).toBe(true);
    expect(looksLikeRetryGift("retry")).toBe(true);
  });
});
