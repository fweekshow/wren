/**
 * Apple Pay for the Wren app, through Coinbase's headless onramp.
 *
 * The app loads the returned payment link in a WebView: it renders Coinbase's
 * Apple Pay button, one tap opens the native sheet, and USDC lands on Base in
 * the user's own wallet (their cash). No `domain` on the order: Coinbase says
 * to omit it for iOS WebViews.
 *
 * Coinbase needs a verified US phone (within 60 days) and a verified email.
 * Wren's sign-in is a Privy SMS code, so each sign-in stamps phoneVerifiedAt;
 * the email is verified once with a 6-digit code (wallet/emailOtp.ts).
 */
import { config } from "@/config/config.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import {
  APPLE_PAY_METHOD,
  createHeadlessOnrampOrder,
  isCoinbaseRegionForbiddenError,
} from "@/wallet/onramp.js";
import { headlessBlockedReasonFromError } from "@/wallet/onrampLimits.js";
import { OnrampUserDataAdapter } from "@/wallet/onrampUserData.js";
import { logger } from "@/utils/logger.js";

/** Coinbase's Apple Pay minimum is about $5. */
export const APPLE_PAY_MIN_USD = 5;
export const APPLE_PAY_MAX_USD = 500;
/** App sessions last 30 days, so a signed-in phone was verified at most this long ago. */
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PHONE_VERIFIED_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

export type ApplePayErrorCode =
  | "bad_amount"
  | "us_only"
  | "no_wallet"
  | "need_email"
  | "need_email_code"
  | "limit"
  | "unavailable";

export class ApplePayError extends Error {
  constructor(
    readonly code: ApplePayErrorCode,
    readonly status: number,
  ) {
    super(code);
  }
}

export function isUsPhone(phone: string): boolean {
  return /^\+1[2-9]\d{9}$/.test(phone);
}

/** When the phone was last verified: the stamped sign-in, else the oldest a live session can be. */
export function phoneVerifiedAt(stamped: Date | null | undefined, now = new Date()): Date {
  if (stamped && now.getTime() - stamped.getTime() < PHONE_VERIFIED_MAX_AGE_MS) return stamped;
  return new Date(now.getTime() - SESSION_MAX_AGE_MS);
}

export async function startAppApplePay(input: {
  phone: string;
  amountUsd: number;
  clientIp?: string;
}): Promise<{ url: string; orderId: string | null }> {
  const { phone, amountUsd } = input;
  if (!Number.isFinite(amountUsd) || amountUsd < APPLE_PAY_MIN_USD || amountUsd > APPLE_PAY_MAX_USD) {
    throw new ApplePayError("bad_amount", 400);
  }
  const sandbox = config.cdp.onrampSandbox;
  if (!isUsPhone(phone) && !sandbox) throw new ApplePayError("us_only", 400);

  const embedded = await WalletAdapter.getEmbeddedWallet(phone);
  if (!embedded?.address) throw new ApplePayError("no_wallet", 400);

  const data = await OnrampUserDataAdapter.get(phone);
  if (!data?.email) throw new ApplePayError("need_email", 409);
  if (!data.emailVerifiedAt) throw new ApplePayError("need_email_code", 409);

  const now = new Date();
  try {
    const order = await createHeadlessOnrampOrder({
      address: embedded.address,
      email: data.email,
      phoneNumber: isUsPhone(phone) ? phone : "+12345678901",
      phoneNumberVerifiedAt: phoneVerifiedAt(data.phoneVerifiedAt, now).toISOString(),
      // The app shows Coinbase's terms right above the button the user taps.
      agreementAcceptedAt: now.toISOString(),
      paymentAmount: amountUsd.toFixed(2),
      paymentCurrency: "USD",
      paymentMethod: APPLE_PAY_METHOD,
      purchaseCurrency: "USDC",
      destinationNetwork: "base",
      // Same ref the Basemate pay page uses, so Coinbase's limits line up.
      partnerUserRef: `${sandbox ? "sandbox-" : ""}${embedded.address.slice(0, 50)}`,
      partnerOrderRef: `wren-apple-${now.getTime()}`,
      ...(input.clientIp ? { clientIp: input.clientIp } : {}),
    });
    const link = order.paymentLink?.url;
    if (!link) throw new ApplePayError("unavailable", 502);
    const url = new URL(link);
    if (sandbox) url.searchParams.set("useApplePaySandbox", "true");
    return { url: url.toString(), orderId: order.order?.orderId ?? null };
  } catch (err) {
    if (err instanceof ApplePayError) throw err;
    // Say why: missing CDP keys, a Coinbase rejection, a limit.
    logger.warn({ err, amountUsd }, "[apple-pay] Coinbase order failed");
    if (isCoinbaseRegionForbiddenError(err)) throw new ApplePayError("us_only", 400);
    const reason = headlessBlockedReasonFromError(err);
    if (reason === "guest_transaction_count" || /guest_transaction_limit/i.test(String(err))) {
      throw new ApplePayError("limit", 429);
    }
    throw new ApplePayError("unavailable", 502);
  }
}
