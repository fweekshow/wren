import { beforeEach, describe, expect, it, vi } from "vitest";

const cfg = vi.hoisted(() => ({ cdp: { onrampSandbox: false } }));
const createOrder = vi.hoisted(() => vi.fn());
const getWallet = vi.hoisted(() => vi.fn());
const getUserData = vi.hoisted(() => vi.fn());

vi.mock("@/config/config.js", () => ({ config: cfg }));
vi.mock("@/utils/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/discovery/adapters/wallet.adapter.js", () => ({
  WalletAdapter: { getEmbeddedWallet: getWallet },
}));
vi.mock("@/wallet/onrampUserData.js", () => ({ OnrampUserDataAdapter: { get: getUserData } }));
vi.mock("@/wallet/onrampLimits.js", () => ({
  headlessBlockedReasonFromError: (err: unknown) =>
    String(err).includes("guest_transaction_count") ? "guest_transaction_count" : undefined,
}));
vi.mock("@/wallet/onramp.js", () => ({
  APPLE_PAY_METHOD: "GUEST_CHECKOUT_APPLE_PAY",
  createHeadlessOnrampOrder: createOrder,
  isCoinbaseRegionForbiddenError: (err: unknown) => String(err).includes("guest_region_forbidden"),
}));

import { applePayQuote, phoneVerifiedAt, startAppApplePay } from "@/wallet/appApplePay.js";

const PHONE = "+14155550123";
const WALLET = "0x1111111111111111111111111111111111111111";

describe("startAppApplePay", () => {
  beforeEach(() => {
    cfg.cdp.onrampSandbox = false;
    createOrder.mockReset();
    getWallet.mockResolvedValue({ address: WALLET });
    getUserData.mockResolvedValue({
      email: "a@b.co",
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    });
  });

  it("creates an Apple Pay order with no domain (iOS WebView) and returns the link", async () => {
    createOrder.mockResolvedValue({
      order: { orderId: "o1" },
      paymentLink: { url: "https://pay.coinbase.com/x?a=1", paymentLinkType: "PAYMENT_LINK_TYPE_APPLE_PAY_BUTTON" },
    });
    const r = await startAppApplePay({ phone: PHONE, receiveUsd: 50, clientIp: "1.2.3.4" });
    expect(r).toMatchObject({ url: "https://pay.coinbase.com/x?a=1", orderId: "o1", receiveUsd: 50 });
    const body = createOrder.mock.calls[0]![0];
    expect(body).not.toHaveProperty("domain");
    expect(body).not.toHaveProperty("paymentAmount");
    expect(body).toMatchObject({
      address: WALLET,
      email: "a@b.co",
      phoneNumber: PHONE,
      purchaseAmount: "50.00",
      paymentMethod: "GUEST_CHECKOUT_APPLE_PAY",
      purchaseCurrency: "USDC",
      destinationNetwork: "base",
      clientIp: "1.2.3.4",
    });
  });

  it("marks sandbox orders and links", async () => {
    cfg.cdp.onrampSandbox = true;
    createOrder.mockResolvedValue({ order: { orderId: "o2" }, paymentLink: { url: "https://pay.coinbase.com/x" } });
    const r = await startAppApplePay({ phone: PHONE, receiveUsd: 10 });
    expect(r.url).toContain("useApplePaySandbox=true");
    expect(createOrder.mock.calls[0]![0].partnerUserRef).toMatch(/^sandbox-/);
  });

  it("is US-only", async () => {
    await expect(startAppApplePay({ phone: "+447700900123", receiveUsd: 20 })).rejects.toMatchObject({
      code: "us_only",
    });
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("asks for an email, then for its code", async () => {
    getUserData.mockResolvedValueOnce(null);
    await expect(startAppApplePay({ phone: PHONE, receiveUsd: 20 })).rejects.toMatchObject({
      code: "need_email",
      status: 409,
    });
    getUserData.mockResolvedValueOnce({ email: "a@b.co", emailVerifiedAt: null });
    await expect(startAppApplePay({ phone: PHONE, receiveUsd: 20 })).rejects.toMatchObject({
      code: "need_email_code",
    });
  });

  it("rejects amounts under Coinbase's Apple Pay minimum", async () => {
    await expect(startAppApplePay({ phone: PHONE, receiveUsd: 2 })).rejects.toMatchObject({ code: "bad_amount" });
  });

  it("maps Coinbase limit and region errors", async () => {
    createOrder.mockRejectedValueOnce(new Error("429 guest_transaction_count"));
    await expect(startAppApplePay({ phone: PHONE, receiveUsd: 20 })).rejects.toMatchObject({ code: "limit" });
    createOrder.mockRejectedValueOnce(new Error("403 guest_region_forbidden"));
    await expect(startAppApplePay({ phone: PHONE, receiveUsd: 20 })).rejects.toMatchObject({ code: "us_only" });
  });
});

describe("phoneVerifiedAt", () => {
  const now = new Date("2026-11-26T12:00:00Z");
  it("uses the stamped sign-in when recent", () => {
    const d = new Date("2026-11-20T12:00:00Z");
    expect(phoneVerifiedAt(d, now)).toBe(d);
  });
  it("falls back to the oldest a live 30-day session can be", () => {
    expect(phoneVerifiedAt(null, now).toISOString()).toBe("2026-10-27T12:00:00.000Z");
  });
});

describe("applePayQuote (fee on top)", () => {
  it("matches Coinbase's live quotes: 2.5% of the cash received", () => {
    // Live: pay $100 -> 97.56 USDC; pay $50 -> 48.78; pay $5 -> 4.88.
    expect(applePayQuote(97.56)).toEqual({ receiveUsd: 97.56, feeUsd: 2.44, totalUsd: 100 });
    expect(applePayQuote(48.78)).toEqual({ receiveUsd: 48.78, feeUsd: 1.22, totalUsd: 50 });
    expect(applePayQuote(4.88)).toEqual({ receiveUsd: 4.88, feeUsd: 0.12, totalUsd: 5 });
  });
  it("prices a round amount of cash", () => {
    expect(applePayQuote(50)).toEqual({ receiveUsd: 50, feeUsd: 1.25, totalUsd: 51.25 });
    expect(applePayQuote(50.99)).toEqual({ receiveUsd: 50.99, feeUsd: 1.27, totalUsd: 52.26 });
  });
});
