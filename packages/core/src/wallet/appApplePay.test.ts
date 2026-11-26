import { beforeEach, describe, expect, it, vi } from "vitest";

const cfg = vi.hoisted(() => ({ cdp: { onrampSandbox: false } }));
const createOrder = vi.hoisted(() => vi.fn());
const getWallet = vi.hoisted(() => vi.fn());
const getUserData = vi.hoisted(() => vi.fn());

vi.mock("@/config/config.js", () => ({ config: cfg }));
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

import { phoneVerifiedAt, startAppApplePay } from "@/wallet/appApplePay.js";

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
    const r = await startAppApplePay({ phone: PHONE, amountUsd: 50, clientIp: "1.2.3.4" });
    expect(r).toEqual({ url: "https://pay.coinbase.com/x?a=1", orderId: "o1" });
    const body = createOrder.mock.calls[0]![0];
    expect(body).not.toHaveProperty("domain");
    expect(body).toMatchObject({
      address: WALLET,
      email: "a@b.co",
      phoneNumber: PHONE,
      paymentAmount: "50.00",
      paymentMethod: "GUEST_CHECKOUT_APPLE_PAY",
      purchaseCurrency: "USDC",
      destinationNetwork: "base",
      clientIp: "1.2.3.4",
    });
  });

  it("marks sandbox orders and links", async () => {
    cfg.cdp.onrampSandbox = true;
    createOrder.mockResolvedValue({ order: { orderId: "o2" }, paymentLink: { url: "https://pay.coinbase.com/x" } });
    const r = await startAppApplePay({ phone: PHONE, amountUsd: 10 });
    expect(r.url).toContain("useApplePaySandbox=true");
    expect(createOrder.mock.calls[0]![0].partnerUserRef).toMatch(/^sandbox-/);
  });

  it("is US-only", async () => {
    await expect(startAppApplePay({ phone: "+447700900123", amountUsd: 20 })).rejects.toMatchObject({
      code: "us_only",
    });
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("asks for an email, then for its code", async () => {
    getUserData.mockResolvedValueOnce(null);
    await expect(startAppApplePay({ phone: PHONE, amountUsd: 20 })).rejects.toMatchObject({
      code: "need_email",
      status: 409,
    });
    getUserData.mockResolvedValueOnce({ email: "a@b.co", emailVerifiedAt: null });
    await expect(startAppApplePay({ phone: PHONE, amountUsd: 20 })).rejects.toMatchObject({
      code: "need_email_code",
    });
  });

  it("rejects amounts under Coinbase's Apple Pay minimum", async () => {
    await expect(startAppApplePay({ phone: PHONE, amountUsd: 2 })).rejects.toMatchObject({ code: "bad_amount" });
  });

  it("maps Coinbase limit and region errors", async () => {
    createOrder.mockRejectedValueOnce(new Error("429 guest_transaction_count"));
    await expect(startAppApplePay({ phone: PHONE, amountUsd: 20 })).rejects.toMatchObject({ code: "limit" });
    createOrder.mockRejectedValueOnce(new Error("403 guest_region_forbidden"));
    await expect(startAppApplePay({ phone: PHONE, amountUsd: 20 })).rejects.toMatchObject({ code: "us_only" });
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
