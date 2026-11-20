import { generateJwt } from "@coinbase/cdp-sdk/auth";

import { config } from "@/config/config.js";
import { OnrampUserDataAdapter } from "@/wallet/onrampUserData.js";
import type { FundPaymentLinkOption } from "@/wallet/fundSession.js";

/**
 * Coinbase Onramp & Offramp — link-based flows for the text-only iMessage bot.
 *
 * iMessage cannot embed Apple Pay or a webview, so we generate a single-use
 * Coinbase Pay URL and send it as a tappable link. The user opens it in Safari
 * (where Apple Pay works) to buy/sell. Session tokens expire after 5 minutes
 * and are single-use, so a fresh one is minted per request.
 *
 * Note: Coinbase is deprecating hosted-widget Guest Checkout (Apple Pay / debit
 * card) on 2026-06-30. The link approach is the only Apple-Pay path available
 * over a text transport; the native Headless Onramp API requires an embedded
 * app, which iMessage does not support.
 */

const API_HOST = "api.developer.coinbase.com";
const TOKEN_PATH = "/onramp/v1/token";
const TOKEN_URL = `https://${API_HOST}${TOKEN_PATH}`;

const CDP_API_HOST = "api.cdp.coinbase.com";
const HEADLESS_ONRAMP_ORDER_PATH = "/platform/v2/onramp/orders";
const HEADLESS_ONRAMP_ORDER_URL = `https://${CDP_API_HOST}${HEADLESS_ONRAMP_ORDER_PATH}`;

const ONRAMP_BASE_URL = "https://pay.coinbase.com/buy/select-asset";
const OFFRAMP_BASE_URL = "https://pay.coinbase.com/v3/sell/input";

/** Coinbase-hosted redirect/widget — not headless Apple Pay iframe URLs. */
export function isHostedCoinbaseOnrampUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "pay.coinbase.com") return false;
    if (parsed.pathname.includes("/buy/select-asset")) return true;
    if (parsed.pathname.startsWith("/v3/sell")) return true;
    if (parsed.pathname.includes("/guest")) return false;
    return parsed.searchParams.has("sessionToken");
  } catch {
    return false;
  }
}

/** Apple Pay via Guest Checkout (no Coinbase account required). */
export const APPLE_PAY_METHOD = "GUEST_CHECKOUT_APPLE_PAY";
export const GOOGLE_PAY_METHOD = "GUEST_CHECKOUT_GOOGLE_PAY";

/** Basemate guest checkout minimum (USD). Coinbase docs cite ~$5; $2 works in production for Apple Pay. */
export const ONRAMP_MIN_USD = 2;

export type HeadlessOnrampPaymentMethod =
  | typeof APPLE_PAY_METHOD
  | typeof GOOGLE_PAY_METHOD;

export interface OnrampLinkParams {
  /** Destination wallet address (the user's custodial server wallet). */
  address: string;
  /** Stable per-user identifier for transaction tracking (max 50 chars). */
  partnerUserRef: string;
  /** Optional preset fiat amount in USD, e.g. 25. */
  presetFiatAmount?: number;
  /** End-user IP. Falls back to the configured value when unavailable (iMessage). */
  clientIp?: string;
}

export interface OfframpLinkParams {
  /** Source wallet address (the user's custodial server wallet). */
  address: string;
  /** Stable per-user identifier for transaction tracking (max 50 chars). */
  partnerUserRef: string;
  /** Optional preset crypto amount to sell, e.g. "10" (USDC). */
  presetCryptoAmount?: string;
  /** Allowlisted return URL for this specific offramp attempt. */
  redirectUrl?: string;
  /** Prevent Coinbase from changing the amount selected in Basemate. */
  disableEdit?: boolean;
  clientIp?: string;
}

export interface HeadlessOnrampOrderParams {
  /** Destination wallet address where Coinbase sends purchased crypto. */
  address: string;
  /** Stable per-user identifier for transaction tracking; use sandbox-* for sandbox orders. */
  partnerUserRef: string;
  /** Verified user email address collected by the app. */
  email: string;
  /** Verified US phone number in E.164 format, e.g. +12055555555. */
  phoneNumber: string;
  /** When the user accepted Coinbase Guest Checkout, User Agreement, and Privacy Policy. */
  agreementAcceptedAt: string;
  /** When this phone number was last OTP-verified; must be within 60 days. */
  phoneNumberVerifiedAt: string;
  /** Fiat amount the user pays, inclusive of fees. Either this or purchaseAmount is required. */
  paymentAmount?: string;
  /** Crypto amount the user receives, exclusive of fees. Either this or paymentAmount is required. */
  purchaseAmount?: string;
  paymentCurrency?: string;
  purchaseCurrency?: string;
  destinationNetwork?: string;
  paymentMethod?: HeadlessOnrampPaymentMethod;
  clientIp?: string;
  /** Required when embedding the Apple Pay payment link in a web iframe. */
  domain?: string;
  partnerOrderRef?: string;
  isQuote?: boolean;
}

export interface HeadlessOnrampOrderResponse {
  order: {
    orderId: string;
    status: string;
    paymentTotal: string;
    paymentCurrency: string;
    purchaseAmount: string;
    purchaseCurrency: string;
    destinationAddress: string;
    destinationNetwork: string;
    partnerUserRef?: string;
  };
  paymentLink?: {
    url: string;
    paymentLinkType: string;
  };
}

export const HEADLESS_ONRAMP_SAMPLE_CURL = `curl -X POST "${HEADLESS_ONRAMP_ORDER_URL}" \\
  -H "Authorization: Bearer <CDP_JWT_FOR_POST_PLATFORM_V2_ONRAMP_ORDERS>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "paymentCurrency": "USD",
    "paymentAmount": "25.00",
    "purchaseCurrency": "USDC",
    "paymentMethod": "GUEST_CHECKOUT_APPLE_PAY",
    "destinationAddress": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    "destinationNetwork": "base",
    "phoneNumber": "+12055555555",
    "email": "test@example.com",
    "agreementAcceptedAt": "2026-06-18T00:00:00Z",
    "phoneNumberVerifiedAt": "2026-06-18T00:00:00Z",
    "partnerUserRef": "sandbox-user-1234",
    "clientIp": "127.0.0.1",
    "domain": "app.basemate.app"
  }'`;

/**
 * Create a Headless Onramp v2 order for native/webview Apple Pay flows.
 * This is the API request Coinbase asks for during Headless Onramp access review.
 */
export async function createHeadlessOnrampOrder(
  params: HeadlessOnrampOrderParams,
): Promise<HeadlessOnrampOrderResponse> {
  if (!config.cdp.onrampApiKeyId || !config.cdp.onrampApiKeySecret) {
    throw new Error("CDP onramp API keys are not configured — cannot create a headless onramp order");
  }
  if (!params.paymentAmount && !params.purchaseAmount) {
    throw new Error("Headless Onramp requires either paymentAmount or purchaseAmount");
  }

  const jwt = await generateJwt({
    apiKeyId: config.cdp.onrampApiKeyId,
    apiKeySecret: config.cdp.onrampApiKeySecret,
    requestMethod: "POST",
    requestHost: CDP_API_HOST,
    requestPath: HEADLESS_ONRAMP_ORDER_PATH,
  });


  const body = {
    paymentCurrency: params.paymentCurrency || "USD",
    ...(params.paymentAmount ? { paymentAmount: params.paymentAmount } : {}),
    ...(params.purchaseAmount ? { purchaseAmount: params.purchaseAmount } : {}),
    purchaseCurrency: params.purchaseCurrency || "USDC",
    paymentMethod: params.paymentMethod || APPLE_PAY_METHOD,
    destinationAddress: params.address,
    destinationNetwork: params.destinationNetwork || "base",
    phoneNumber: params.phoneNumber,
    email: params.email,
    agreementAcceptedAt: params.agreementAcceptedAt,
    phoneNumberVerifiedAt: params.phoneNumberVerifiedAt,
    partnerUserRef: params.partnerUserRef,
    ...(params.clientIp ? { clientIp: params.clientIp } : {}),
    ...(params.domain ? { domain: params.domain } : {}),
    ...(params.partnerOrderRef ? { partnerOrderRef: params.partnerOrderRef } : {}),
    ...(typeof params.isQuote === "boolean" ? { isQuote: params.isQuote } : {}),
  };

  const res = await fetch(HEADLESS_ONRAMP_ORDER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
      "Correlation-Context": "sdk_version=1.0.0,sdk_language=typescript,source=sdk-auth",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.log("HEADLESS ONRAMP ORDER REQUEST FAILED", text);
    throw new Error(`headless onramp order request failed (${res.status}): ${text}`);
  }

  return (await res.json()) as HeadlessOnrampOrderResponse;
}

/** iMessage senderIds are E.164; Coinbase Headless Onramp needs a US number. */
function usPhoneForOnramp(senderId: string): string {
  if (/^\+1[2-9]\d{9}$/.test(senderId)) return senderId;
  if (config.cdp.onrampSandbox) return "+12345678901";
  return senderId;
}

function onrampClientIp(): string | undefined {
  const ip = config.cdp.onrampClientIpFallback.trim();
  if (!ip || ip === "1.1.1.1") return undefined;
  return ip;
}

export function isCoinbaseRegionForbiddenError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("guest_region_forbidden");
}

export interface BuildHeadlessFundLinksParams {
  senderId: string;
  address: string;
  amount: string;
  email: string;
  agreementAcceptedAt: Date;
  phoneNumberVerifiedAt: Date;
  partnerUserRef: string;
  clientIp?: string;
  preferredPaymentMethod?: HeadlessOnrampPaymentMethod;
}

function preferHeadlessBlockedReason(
  current: string | undefined,
  next: string | undefined,
): string | undefined {
  if (!next) return current;
  if (!current) return next;
  const rank: Record<string, number> = {
    invalid_app_id: 30,
    guest_region_forbidden: 20,
    guest_transaction_count: 10,
  };
  return (rank[next] ?? 0) >= (rank[current] ?? 0) ? next : current;
}

/** Create embeddable Apple Pay + Google Pay payment links for /pay and dashboard. */
export async function buildHeadlessFundLinks(
  params: BuildHeadlessFundLinksParams,
): Promise<{
  paymentLinkOptions: FundPaymentLinkOption[];
  headlessBlockedReason?: string;
}> {
  const methods = orderedPaymentMethods(
    params.preferredPaymentMethod ?? APPLE_PAY_METHOD,
  );
  const options: FundPaymentLinkOption[] = [];
  let headlessBlockedReason: string | undefined;

  for (const method of methods) {
    try {
      const order = await createHeadlessOnrampOrder({
        address: params.address,
        partnerUserRef: params.partnerUserRef,
        email: params.email,
        phoneNumber: usPhoneForOnramp(params.senderId),
        agreementAcceptedAt: params.agreementAcceptedAt.toISOString(),
        phoneNumberVerifiedAt: params.phoneNumberVerifiedAt.toISOString(),
        paymentAmount: params.amount,
        paymentCurrency: "USD",
        paymentMethod: method,
        purchaseCurrency: "USDC",
        destinationNetwork: "base",
        ...(config.cdp.fundPageUrl.includes("localhost") ? {} : { domain: config.cdp.fundPageDomain }),
        ...(params.clientIp ? { clientIp: params.clientIp } : onrampClientIp() ? { clientIp: onrampClientIp() } : {}),
        partnerOrderRef: `${method === GOOGLE_PAY_METHOD ? "google" : "apple"}-${Date.now()}`,
      });

      if (!order.paymentLink?.url) continue;

      const paymentLinkUrl = new URL(order.paymentLink.url);
      if (config.cdp.onrampSandbox) {
        paymentLinkUrl.searchParams.set(
          method === GOOGLE_PAY_METHOD ? "useGooglePaySandbox" : "useApplePaySandbox",
          "true",
        );
      }

      options.push({
        method: method === GOOGLE_PAY_METHOD ? "google_pay" : "apple_pay",
        label: method === GOOGLE_PAY_METHOD ? "Google Pay" : "Apple Pay",
        url: paymentLinkUrl.toString(),
      });
    } catch (err) {
      if (isCoinbaseRegionForbiddenError(err)) throw err;
      const { headlessBlockedReasonFromError } = await import("@/wallet/onrampLimits.js");
      const reason = headlessBlockedReasonFromError(err);
      headlessBlockedReason = preferHeadlessBlockedReason(headlessBlockedReason, reason);
      console.error(`⚠️ [onramp] ${method} payment link failed:`, err);
    }
  }

  return {
    paymentLinkOptions: options,
    ...(headlessBlockedReason ? { headlessBlockedReason } : {}),
  };
}

function orderedPaymentMethods(
  preferredPaymentMethod: HeadlessOnrampPaymentMethod,
): HeadlessOnrampPaymentMethod[] {
  const fallback = preferredPaymentMethod === GOOGLE_PAY_METHOD ? APPLE_PAY_METHOD : GOOGLE_PAY_METHOD;
  return [preferredPaymentMethod, fallback];
}

/** Coinbase-hosted onramp URL for debit card / bank (must redirect — not iframe-safe). */
export async function buildHostedFallbackUrl(params: OnrampLinkParams): Promise<string> {
  return buildOnrampUrl(params, { hostedAccountCheckout: true });
}

export interface HeadlessAppleFundLinkParams {
  /** iMessage senderId (E.164 phone) of the signed-in user. */
  senderId: string;
  /** Destination wallet — the user's Basemate embedded smart account. */
  address: string;
  /** Fiat amount in USD, e.g. "5". */
  amount: string;
  /** The user's CDP sign-in email (already verified by Coinbase auth). */
  email: string;
}

/**
 * Build an embeddable Apple Pay onramp payment link for the signed-in dashboard
 * user. Prefer {@link buildHeadlessFundLinks} for Apple Pay + Google Pay.
 */
export async function buildHeadlessAppleFundLink(
  params: HeadlessAppleFundLinkParams,
): Promise<{ paymentLinkOptions: FundPaymentLinkOption[] }> {
  const now = new Date();
  await OnrampUserDataAdapter.upsert(params.senderId, {
    email: params.email,
    emailVerifiedAt: now,
    phoneVerifiedAt: now,
    tosAcceptedAt: now,
  });

  return buildHeadlessFundLinks({
    senderId: params.senderId,
    address: params.address,
    amount: params.amount,
    email: params.email,
    agreementAcceptedAt: now,
    phoneNumberVerifiedAt: now,
    partnerUserRef: params.address.slice(0, 50),
    preferredPaymentMethod: APPLE_PAY_METHOD,
  });
}

/**
 * Create a single-use Onramp/Offramp session token bound to a wallet address.
 * The same endpoint serves both flows. Requires a CDP Secret API Key.
 */
export async function createSessionToken(
  address: string,
  clientIp?: string,
  assets: string[] = ["USDC", "ETH"],
): Promise<string> {
  if (!config.cdp.paymentsEnabled) {
    throw new Error("CDP is not configured — cannot create an onramp session token");
  }

  const jwt = await generateJwt({
    apiKeyId: config.cdp.apiKeyId,
    apiKeySecret: config.cdp.apiKeySecret,
    requestMethod: "POST",
    requestHost: API_HOST,
    requestPath: TOKEN_PATH,
  });

  const body = {
    addresses: [{ address, blockchains: ["base"] }],
    assets,
    clientIp: clientIp || config.cdp.onrampClientIpFallback,
  };

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`onramp token request failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as { token?: string };
  if (!json.token) {
    throw new Error("onramp token response did not include a token");
  }
  return json.token;
}

/**
 * Generate a ready-to-tap Onramp URL that defaults to buying USDC on Base.
 * For iMessage links, defaults to guest Apple Pay on Coinbase's hosted page.
 * For dashboard /pay "Card or bank", use hostedAccountCheckout so Coinbase does not
 * require the headless embed app id (avoids invalid_app_id on pay.coinbase.com).
 */
export async function buildOnrampUrl(
  params: OnrampLinkParams,
  options?: { hostedAccountCheckout?: boolean },
): Promise<string> {
  const token = await createSessionToken(params.address, params.clientIp);
  const q = new URLSearchParams({
    sessionToken: token,
    defaultAsset: "USDC",
    defaultNetwork: "base",
    defaultExperience: "buy",
    fiatCurrency: "USD",
    partnerUserRef: params.partnerUserRef.slice(0, 50),
    redirectUrl: config.cdp.onrampRedirectUrl,
  });
  if (!options?.hostedAccountCheckout) {
    q.set("defaultPaymentMethod", APPLE_PAY_METHOD);
  }
  if (params.presetFiatAmount && params.presetFiatAmount > 0) {
    q.set("presetFiatAmount", String(params.presetFiatAmount));
  }
  return `${ONRAMP_BASE_URL}?${q.toString()}`;
}

/**
 * Generate a ready-to-tap Offramp URL to cash out crypto to fiat. Offramp
 * requires both partnerUserRef and redirectUrl.
 */
export async function buildOfframpUrl(params: OfframpLinkParams): Promise<string> {
  const token = await createSessionToken(params.address, params.clientIp, ["USDC"]);
  const q = new URLSearchParams({
    sessionToken: token,
    defaultAsset: "USDC",
    defaultNetwork: "base",
    partnerUserRef: params.partnerUserRef.slice(0, 50),
    redirectUrl: params.redirectUrl ?? config.cdp.offrampRedirectUrl,
  });
  if (params.presetCryptoAmount) {
    q.set("presetCryptoAmount", params.presetCryptoAmount);
  }
  if (params.disableEdit) {
    q.set("disableEdit", "true");
  }
  return `${OFFRAMP_BASE_URL}?${q.toString()}`;
}
