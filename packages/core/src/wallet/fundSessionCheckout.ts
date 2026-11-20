import type { Request } from "express";

import { config } from "@/config/config.js";
import { logger } from "@/utils/logger.js";
import { OnrampUserDataAdapter } from "@/wallet/onrampUserData.js";
import {
  FundSessionAdapter,
  FUND_SESSION_PENDING_URL,
  type FundPaymentLinkOption,
  type FundSession,
} from "@/wallet/fundSession.js";
import {
  buildHostedFallbackUrl,
  buildHeadlessFundLinks,
  isCoinbaseRegionForbiddenError,
  isHostedCoinbaseOnrampUrl,
  ONRAMP_MIN_USD,
} from "@/wallet/onramp.js";

export { ONRAMP_MIN_USD };

/** Agent-side IP for headless orders when the user's browser IP is not available yet. */
export function configuredOnrampClientIp(): string | undefined {
  const ip = config.cdp.onrampClientIpFallback.trim();
  if (!ip || ip === "1.1.1.1") return undefined;
  return ip;
}

/** Extract the end-user IP for Coinbase region checks (respects X-Forwarded-For). */
export function clientIpFromRequest(req: Pick<Request, "headers" | "ip" | "socket">): string | undefined {
  const basemateClientIp = req.headers["x-basemate-client-ip"];
  if (typeof basemateClientIp === "string" && basemateClientIp.trim()) {
    return basemateClientIp.trim();
  }
  const forwarded = req.headers["x-forwarded-for"];
  const raw =
    (typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : "") ||
    req.ip ||
    req.socket.remoteAddress ||
    "";
  if (!raw || raw === "1.1.1.1") return undefined;
  return raw;
}

export interface MaterializedFundCheckout {
  paymentLinkUrl: string;
  paymentLinkOptions: FundPaymentLinkOption[];
  hostedFallbackUrl?: string;
  expiresAt: Date;
  regionForbidden: boolean;
  headlessBlockedReason?: string;
  limitUpgradeEligible?: boolean;
  limitUpgradeComplete?: boolean;
}

/** Create a fund session intent; payment links are minted when /pay loads (real client IP). */
export async function createFundSessionIntent(input: {
  userPhone: string;
  walletAddress: string;
  amountUsd: number;
}): Promise<string> {
  if (!Number.isFinite(input.amountUsd) || input.amountUsd < ONRAMP_MIN_USD) {
    throw new Error(`Minimum fund amount is $${ONRAMP_MIN_USD}`);
  }

  return FundSessionAdapter.createIntent({
    userPhone: input.userPhone,
    walletAddress: input.walletAddress,
    amountUsd: input.amountUsd,
  });
}

/**
 * Mint headless payment links when the user requests a fund link (pre-deferral behavior).
 * /pay still re-materializes with the browser IP if links are missing.
 */
export async function warmFundSessionCheckout(
  token: string,
  clientIp?: string,
): Promise<MaterializedFundCheckout | null> {
  const session = await FundSessionAdapter.get(token);
  if (!session) return null;
  return materializeFundSessionCheckout(session, clientIp ?? configuredOnrampClientIp());
}

/**
 * Ensure headless payment links exist for a fund session. Idempotent — safe on
 * page refresh. Uses the browser's IP when materializing on /pay load.
 */
export async function materializeFundSessionCheckout(
  session: FundSession,
  clientIp?: string,
  options?: { forceRemint?: boolean },
): Promise<MaterializedFundCheckout> {
  let checkoutSession = session;
  if (
    options?.forceRemint &&
    checkoutSession.paymentLinkUrl !== FUND_SESSION_PENDING_URL
  ) {
    await FundSessionAdapter.updateCheckout(checkoutSession.token, {
      paymentLinkUrl: FUND_SESSION_PENDING_URL,
      paymentLinkOptions: [],
      hostedFallbackUrl: checkoutSession.hostedFallbackUrl ?? undefined,
    });
    checkoutSession = {
      ...checkoutSession,
      paymentLinkUrl: FUND_SESSION_PENDING_URL,
      paymentLinkOptions: [],
    };
  }

  const effectiveOptions =
    checkoutSession.paymentLinkOptions.length > 0
      ? checkoutSession.paymentLinkOptions.filter((o) => !isHostedCoinbaseOnrampUrl(o.url))
      : [];

  const { phoneForOnrampLimits, resolveCheckoutLimitState } = await import(
    "@/wallet/onrampLimits.js"
  );
  const limitsPhone = phoneForOnrampLimits(checkoutSession.userPhone);

  async function limitStateForOptionCount(headlessOptionCount: number, headlessBlockedReason?: string) {
    return resolveCheckoutLimitState(limitsPhone, { headlessOptionCount, headlessBlockedReason });
  }

  // Already materialized — idempotent reads (do not remint on every /pay poll).
  if (checkoutSession.paymentLinkUrl !== FUND_SESSION_PENDING_URL) {
    if (effectiveOptions.length > 0) {
      const limitState = await limitStateForOptionCount(effectiveOptions.length);
      return {
        paymentLinkUrl: checkoutSession.paymentLinkUrl,
        paymentLinkOptions: effectiveOptions,
        hostedFallbackUrl: checkoutSession.hostedFallbackUrl ?? undefined,
        expiresAt: checkoutSession.expiresAt,
        regionForbidden: false,
        headlessBlockedReason: limitState.headlessBlockedReason,
        limitUpgradeEligible: limitState.limitUpgradeEligible,
        limitUpgradeComplete: limitState.limitUpgradeComplete,
      };
    }

    if (!isHostedCoinbaseOnrampUrl(checkoutSession.paymentLinkUrl)) {
      const recovered = [
        {
          method: checkoutSession.paymentLinkUrl.toLowerCase().includes("google") ? "google_pay" : "apple_pay",
          label: checkoutSession.paymentLinkUrl.toLowerCase().includes("google") ? "Google Pay" : "Apple Pay",
          url: checkoutSession.paymentLinkUrl,
        },
      ] as FundPaymentLinkOption[];
      const limitState = await limitStateForOptionCount(recovered.length);
      return {
        paymentLinkUrl: checkoutSession.paymentLinkUrl,
        paymentLinkOptions: recovered,
        hostedFallbackUrl: checkoutSession.hostedFallbackUrl ?? undefined,
        expiresAt: checkoutSession.expiresAt,
        regionForbidden: false,
        headlessBlockedReason: limitState.headlessBlockedReason,
        limitUpgradeEligible: limitState.limitUpgradeEligible,
        limitUpgradeComplete: limitState.limitUpgradeComplete,
      };
    }

    const limitState = await limitStateForOptionCount(0);
    return {
      paymentLinkUrl: checkoutSession.paymentLinkUrl,
      paymentLinkOptions: [],
      hostedFallbackUrl:
        checkoutSession.hostedFallbackUrl ??
        (isHostedCoinbaseOnrampUrl(checkoutSession.paymentLinkUrl)
          ? checkoutSession.paymentLinkUrl
          : undefined),
      expiresAt: checkoutSession.expiresAt,
      regionForbidden: false,
      headlessBlockedReason: limitState.headlessBlockedReason,
      limitUpgradeEligible: limitState.limitUpgradeEligible,
      limitUpgradeComplete: limitState.limitUpgradeComplete,
    };
  }

  if (!checkoutSession.walletAddress || !checkoutSession.amountUsd) {
    throw new Error("Fund session is missing checkout details");
  }

  const userData = await OnrampUserDataAdapter.get(checkoutSession.userPhone);
  if (!userData?.email || !userData.tosAcceptedAt || !userData.emailVerifiedAt) {
    throw new Error("Onramp verification incomplete for this user");
  }

  let phoneVerifiedAt = userData.phoneVerifiedAt;
  if (OnrampUserDataAdapter.needsPhoneReverification(userData)) {
    phoneVerifiedAt = new Date();
    await OnrampUserDataAdapter.upsert(checkoutSession.userPhone, { phoneVerifiedAt });
  }
  if (!phoneVerifiedAt) {
    throw new Error("Phone verification required before checkout");
  }

  const partnerUserRef = config.cdp.onrampSandbox
    ? `sandbox-${checkoutSession.userPhone.replace(/[^a-z0-9]/gi, "").slice(0, 40)}`
    : `im-${checkoutSession.userPhone.replace(/[^a-z0-9]/gi, "").slice(0, 47)}`;

  let paymentLinkOptions: FundPaymentLinkOption[] = [];
  let regionForbidden = false;
  let headlessBlockedReason: string | undefined;

  try {
    const headless = await buildHeadlessFundLinks({
      senderId: checkoutSession.userPhone,
      address: checkoutSession.walletAddress,
      amount: String(checkoutSession.amountUsd),
      email: userData.email,
      agreementAcceptedAt: userData.tosAcceptedAt,
      phoneNumberVerifiedAt: phoneVerifiedAt,
      partnerUserRef,
      clientIp,
    });
    paymentLinkOptions = headless.paymentLinkOptions;
    headlessBlockedReason = headless.headlessBlockedReason;
  } catch (err) {
    regionForbidden = isCoinbaseRegionForbiddenError(err);
    if (!regionForbidden) throw err;
  }

  const limitState = await limitStateForOptionCount(paymentLinkOptions.length, headlessBlockedReason);
  headlessBlockedReason = limitState.headlessBlockedReason;
  const limitUpgradeEligible = limitState.limitUpgradeEligible;
  const limitUpgradeComplete = limitState.limitUpgradeComplete;

  const hostedFallbackUrl = await buildHostedFallbackUrl({
    address: checkoutSession.walletAddress,
    partnerUserRef,
    presetFiatAmount: checkoutSession.amountUsd,
    clientIp,
  });

  const paymentLinkUrl = paymentLinkOptions[0]?.url ?? hostedFallbackUrl;

  if (paymentLinkOptions.length === 0) {
    logger.warn(
      {
        headlessBlockedReason,
        limitUpgradeEligible,
        limitUpgradeComplete,
        clientIp: clientIp ?? null,
        fundPageDomain: config.cdp.fundPageDomain,
      },
      "[fund-session] headless Apple Pay links empty",
    );
  }

  await FundSessionAdapter.updateCheckout(checkoutSession.token, {
    paymentLinkUrl,
    paymentLinkOptions,
    hostedFallbackUrl,
  });

  return {
    paymentLinkUrl,
    paymentLinkOptions,
    hostedFallbackUrl,
    expiresAt: checkoutSession.expiresAt,
    regionForbidden,
    headlessBlockedReason,
    limitUpgradeEligible,
    limitUpgradeComplete,
  };
}
