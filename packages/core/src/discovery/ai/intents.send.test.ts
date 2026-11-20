import { describe, expect, it, vi } from "vitest";

vi.mock("@/discovery/services/sendRecipient.service.js", () => ({
  isAllowedSendRecipient: (raw: string) => {
    const t = raw.trim().replace(/^@+/, "");
    if (/^0x[a-fA-F0-9]{40}$/i.test(t)) return true;
    return t.includes(".");
  },
}));

vi.mock("@/messaging/intentEngine.js", () => ({
  isPortfolioViewIntent: () => false,
}));

vi.mock("@/discovery/yieldCompare.util.js", () => ({
  MOONWELL_MTOKEN_KEYS: [],
  normalizeYieldTokenSymbol: (s: string) => s.toUpperCase(),
  extractYieldTokenFromMessage: () => null,
  isYieldCompareIntent: () => false,
}));

vi.mock("@/portfolio/moonwell.js", () => ({
  MOONWELL_MTOKENS: {},
}));

vi.mock("@/discovery/ai/avantis.js", () => ({
  isAvantisPnlCardIntent: () => false,
  isAvantisPositionsListIntent: () => false,
  parseAvantisCloseIntent: () => null,
}));

vi.mock("@/discovery/adapters/perpProfile.adapter.js", () => ({}));

vi.mock("@/discovery/doppler/stockRegistry.js", () => ({
  resolveStockToken: (raw: string) => {
    const key = raw.trim().toLowerCase();
    const map: Record<string, string> = {
      apple: "AAPLc",
      aapl: "AAPLc",
      aaplc: "AAPLc",
      "eli lilly": "LLYc",
      "sk hynix": "SKHYc",
      "novo nordisk": "NVOc",
      paypal: "PYPLc",
      bud: "BUDc",
      nvda: "NVDAc",
      nvidia: "NVDAc",
      nvdac: "NVDAc",
      meta: "METAc",
      metac: "METAc",
      googl: "GOOGLc",
      google: "GOOGLc",
      alphabet: "GOOGLc",
      googlc: "GOOGLc",
    };
    const symbol = map[key];
    return symbol ? { symbol } : null;
  },
}));

import {
  extractGiftPhone,
  looksLikeGiftStockAsk,
  parseGiftStock,
  parseSimpleTokenSend,
  parseSimpleUsdSend,
  parseBareSendRecipient,
  extractPendingSendFromHistory,
} from "./intents.js";

describe("parseSimpleTokenSend", () => {
  it("parses send 6.7 usdc to a basename", () => {
    expect(parseSimpleTokenSend("Send 6.7 usdc to degeneer03.base.eth")).toEqual({
      to: "degeneer03.base.eth",
      amount: "6.7",
      asset: "usdc",
    });
  });

  it("parses leading-decimal amounts without dropping the decimal", () => {
    // Regression: ".1"/".01" used to be misread as "1".
    expect(parseSimpleTokenSend("Send .1 usdc to degeneer03.base.eth")).toEqual({
      to: "degeneer03.base.eth",
      amount: ".1",
      asset: "usdc",
    });
    expect(parseSimpleTokenSend("Send .01 usdc to degeneer03.base.eth")).toEqual({
      to: "degeneer03.base.eth",
      amount: ".01",
      asset: "usdc",
    });
  });

  it("parses send all usdc to a basename", () => {
    expect(parseSimpleTokenSend("Send all usdc to degeneer03.base.eth")).toEqual({
      to: "degeneer03.base.eth",
      amount: "all",
      asset: "usdc",
      all: true,
    });
  });

  it("parses send all of my eth to 0x", () => {
    expect(
      parseSimpleTokenSend(
        "send all of my eth to 0xae52ed21a8c567e0e42f1801bed37c6f90236734",
      ),
    ).toEqual({
      to: "0xae52ed21a8c567e0e42f1801bed37c6f90236734",
      amount: "all",
      asset: "eth",
      all: true,
    });
  });

  it("parses transfer 0.5 eth to 0x address", () => {
    expect(
      parseSimpleTokenSend(
        "transfer 0.5 eth to 0xae52ed21a8c567e0e42f1801bed37c6f90236734",
      ),
    ).toEqual({
      to: "0xae52ed21a8c567e0e42f1801bed37c6f90236734",
      amount: "0.5",
      asset: "eth",
    });
  });

  it("parses send 10 of basemate to basename", () => {
    expect(parseSimpleTokenSend("send 10 of basemate to jesse.base.eth")).toEqual({
      to: "jesse.base.eth",
      amount: "10",
      asset: "basemate",
    });
  });

  it("returns null for $-prefixed amounts (use parseSimpleUsdSend)", () => {
    expect(parseSimpleTokenSend("send $5 of USDC to jesse.base.eth")).toBeNull();
  });

  it("returns null for bare @handles", () => {
    expect(parseSimpleTokenSend("send 6.7 usdc to @degeneer")).toBeNull();
  });

  it("returns null without a recipient", () => {
    expect(parseSimpleTokenSend("send 6.7 usdc")).toBeNull();
    expect(parseSimpleTokenSend("send all usdc")).toBeNull();
  });
});

describe("parseBareSendRecipient", () => {
  it("accepts a lone basename", () => {
    expect(parseBareSendRecipient("Degeneer03.base.eth")).toBe("Degeneer03.base.eth");
  });

  it("accepts a lone 0x address", () => {
    expect(parseBareSendRecipient("0xae52ed21a8c567e0e42f1801bed37c6f90236734")).toBe(
      "0xae52ed21a8c567e0e42f1801bed37c6f90236734",
    );
  });

  it("rejects multi-word messages", () => {
    expect(parseBareSendRecipient("send to degeneer03.base.eth")).toBeNull();
  });

  it("rejects bare handles", () => {
    expect(parseBareSendRecipient("degeneer03")).toBeNull();
  });
});

describe("extractPendingSendFromHistory", () => {
  it("finds send-all from prior user turn", () => {
    expect(
      extractPendingSendFromHistory([
        { role: "user", content: "Send all usdc to degeneer03.base.eth" },
        { role: "assistant", content: "i need a recipient i can verify first" },
      ]),
    ).toEqual({
      asset: "usdc",
      amount: "all",
      all: true,
      to: "degeneer03.base.eth",
    });
  });

  it("finds send without recipient", () => {
    expect(
      extractPendingSendFromHistory([
        { role: "user", content: "send all usdc" },
        { role: "assistant", content: "who should i send to?" },
      ]),
    ).toEqual({
      asset: "usdc",
      amount: "all",
      all: true,
    });
  });
});

describe("parseSimpleUsdSend still works", () => {
  it("parses send $5 of USDC to jesse.base.eth", () => {
    expect(parseSimpleUsdSend("send $5 of USDC to jesse.base.eth")).toEqual({
      to: "jesse.base.eth",
      amount: "5",
      asset: "USDC",
    });
  });

  it("defaults a bare dollar send to USDC", () => {
    expect(parseSimpleUsdSend("Send $2 to jesse.base.eth")).toEqual({
      to: "jesse.base.eth",
      amount: "2",
      asset: "USDC",
    });
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

  it("parses gift dad $25 of NVDA", () => {
    expect(parseGiftStock("gift dad $25 of NVDA")).toEqual({
      to: "dad",
      stock: "NVDA",
      amount: "25",
      isUsd: true,
    });
  });

  it("does not steal plain USDC sends", () => {
    expect(parseGiftStock("send mom 10 usdc")).toBeNull();
    expect(parseGiftStock("send $10 to mom")).toBeNull();
  });

  it("parses multi-word stock names", () => {
    expect(parseGiftStock("Send Degeneer $5 of Eli Lilly")).toEqual({
      to: "Degeneer",
      stock: "Eli Lilly",
      amount: "5",
      isUsd: true,
    });
    expect(parseGiftStock("send $5 of SK hynix stock to Leo Gonzalez")).toEqual({
      to: "Leo Gonzalez",
      stock: "SK hynix",
      amount: "5",
      isUsd: true,
    });
    expect(parseGiftStock("send mom 1 Novo Nordisk stock")).toEqual({
      to: "mom",
      stock: "Novo Nordisk",
      amount: "1",
      isUsd: false,
    });
    expect(parseGiftStock("send $5 paypal to mom")).toEqual({
      to: "mom",
      stock: "paypal",
      amount: "5",
      isUsd: true,
    });
    expect(parseGiftStock("send $5 to my bud")).toBeNull();
  });

  it("parses fractional ticker sends without the word stock", () => {
    expect(parseGiftStock("Send 0.001 AAPLc to +1 (818) 530-6378")).toEqual({
      to: "+1 (818) 530-6378",
      stock: "AAPLc",
      amount: "0.001",
      isUsd: false,
    });
    expect(extractGiftPhone("+1 (818) 530-6378")).toBe("+18185306378");
    expect(extractGiftPhone("+3806702400")).toBe("+3806702400");
    expect(extractGiftPhone("3806702400")).toBeNull();
    expect(extractGiftPhone("8185306378")).toBeNull();
  });

  it("hints incomplete send-stock asks without stealing a spot buy", () => {
    expect(looksLikeGiftStockAsk("buy stocks")).toBe(true);
    expect(looksLikeGiftStockAsk("send a stock")).toBe(true);
    expect(looksLikeGiftStockAsk("send $25 of AAPL")).toBe(true);
    expect(looksLikeGiftStockAsk("buy $25 apple")).toBe(false);
  });
});
