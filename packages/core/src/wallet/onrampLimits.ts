import { generateJwt } from "@coinbase/cdp-sdk/auth";

import { config } from "@/config/config.js";

const CDP_API_HOST = "api.cdp.coinbase.com";
const LIMITS_PATH = "/platform/v2/onramp/limits";
const LIMITS_UPGRADE_PATH = "/platform/v2/onramp/limits/upgrade";

export type LimitUpgradeStatus =
  | "unrequested"
  | "resubmit"
  | "pending"
  | "active"
  | "inactive";

export interface OnrampLimitsResponse {
  limits?: Array<{
    limitType?: string;
    limit?: string;
    remaining?: string;
    currency?: string;
  }>;
  limitUpgradeOptions?: Array<{
    status?: LimitUpgradeStatus;
    fields?: string[];
  }>;
}

async function onrampLimitsJwt(method: "GET" | "POST", path: string): Promise<string> {
  if (!config.cdp.paymentsEnabled) {
    throw new Error("CDP is not configured — cannot call onramp limits API");
  }
  return generateJwt({
    apiKeyId: config.cdp.onrampApiKeyId,
    apiKeySecret: config.cdp.onrampApiKeySecret,
    requestMethod: method,
    requestHost: CDP_API_HOST,
    requestPath: path,
  });
}

/** Map Headless Create Order failures to a stable client reason code. */
export function headlessBlockedReasonFromError(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes("guest_transaction_count")) return "guest_transaction_count";
  if (lower.includes("error_code_guest_transaction_count")) return "guest_transaction_count";

  const jsonStart = message.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(message.slice(jsonStart)) as {
        errorType?: string;
        error_type?: string;
        errorCode?: string;
        error_code?: string;
        code?: string;
      };
      const type = (
        parsed.errorType ??
        parsed.error_type ??
        parsed.errorCode ??
        parsed.error_code ??
        parsed.code ??
        ""
      ).toLowerCase();
      if (type.includes("guest_transaction_count")) return "guest_transaction_count";
      if (type.includes("invalid_app_id")) return "invalid_app_id";
      if (type.includes("guest_region_forbidden")) return "guest_region_forbidden";
    } catch {
      // ignore malformed JSON tail
    }
  }
  if (lower.includes("invalid_app_id")) return "invalid_app_id";
  if (lower.includes("guest_region_forbidden")) return "guest_region_forbidden";
  return undefined;
}

export function guestLifetimeExhausted(limits: OnrampLimitsResponse): boolean {
  const row = limits.limits?.find((l) => {
    const t = (l.limitType ?? "").toLowerCase();
    return t.includes("lifetime") && t.includes("transaction");
  });
  if (!row?.remaining) return false;
  const remaining = Number(row.remaining);
  return Number.isFinite(remaining) && remaining <= 0;
}

/** Infer guest cap + upgrade eligibility when headless links are missing. */
export async function resolveCheckoutLimitState(
  phoneNumber: string,
  input: { headlessBlockedReason?: string; headlessOptionCount: number },
): Promise<{
  headlessBlockedReason?: string;
  limitUpgradeEligible: boolean;
  limitUpgradeStatus?: LimitUpgradeStatus;
  limitUpgradeComplete: boolean;
}> {
  let headlessBlockedReason = input.headlessBlockedReason;
  let limitUpgradeEligible = false;
  let limitUpgradeStatus: LimitUpgradeStatus | undefined;
  let limitUpgradeComplete = false;

  try {
    const limits = await fetchOnrampLimits(phoneNumber);
    limitUpgradeStatus = limits.limitUpgradeOptions?.[0]?.status;
    limitUpgradeComplete =
      limitUpgradeStatus === "active" || limitUpgradeStatus === "pending";

    const upgradeOffered = limitUpgradeOffered(limits);
    const lifetimeOut = guestLifetimeExhausted(limits);

    if (
      !headlessBlockedReason &&
      input.headlessOptionCount === 0 &&
      lifetimeOut &&
      !limitUpgradeComplete
    ) {
      headlessBlockedReason = "guest_transaction_count";
    }
    if (limitUpgradeComplete) {
      limitUpgradeEligible = false;
      if (headlessBlockedReason === "guest_transaction_count") {
        headlessBlockedReason = undefined;
      }
    } else if (headlessBlockedReason === "guest_transaction_count" && upgradeOffered) {
      limitUpgradeEligible = true;
    } else if (input.headlessOptionCount === 0 && lifetimeOut && upgradeOffered) {
      headlessBlockedReason = headlessBlockedReason ?? "guest_transaction_count";
      limitUpgradeEligible = true;
    }
  } catch (err) {
    console.warn("⚠️ [onramp] limits check failed:", err);
  }

  return { headlessBlockedReason, limitUpgradeEligible, limitUpgradeStatus, limitUpgradeComplete };
}

export function isLimitUpgradeAlreadyUpgradedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return lower.includes("already upgraded") || lower.includes("account is already upgraded");
}

/** E.164 phone for Coinbase limits APIs (same rules as headless orders). */
export function phoneForOnrampLimits(senderId: string): string {
  if (/^\+1[2-9]\d{9}$/.test(senderId)) return senderId;
  if (config.cdp.onrampSandbox) return "+12345678901";
  return senderId;
}

export function limitUpgradeOffered(limits: OnrampLimitsResponse): boolean {
  const status = limits.limitUpgradeOptions?.[0]?.status;
  return status === "unrequested" || status === "resubmit";
}

export async function fetchOnrampLimits(phoneNumber: string): Promise<OnrampLimitsResponse> {
  const jwt = await onrampLimitsJwt("POST", LIMITS_PATH);
  const res = await fetch(`https://${CDP_API_HOST}${LIMITS_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      paymentMethodType: "GUEST_CHECKOUT_APPLE_PAY",
      userIdType: "phone_number",
      userId: phoneNumber,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`onramp limits request failed (${res.status}): ${text}`);
  }
  return (await res.json()) as OnrampLimitsResponse;
}

export async function requestEmbeddedLimitUpgrade(
  phoneNumber: string,
): Promise<{ upgradeUrl: string; expiresAt: string }> {
  const jwt = await onrampLimitsJwt("POST", LIMITS_UPGRADE_PATH);
  const res = await fetch(`https://${CDP_API_HOST}${LIMITS_UPGRADE_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      userIdType: "phone_number",
      userId: phoneNumber,
      interactionMode: "embedded",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (text.toLowerCase().includes("already upgraded")) {
      const err = new Error("LIMIT_UPGRADE_ALREADY_COMPLETE");
      throw err;
    }
    throw new Error(`onramp limit upgrade request failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { upgradeUrl?: string; expiresAt?: string };
  if (!json.upgradeUrl || !json.expiresAt) {
    throw new Error("onramp limit upgrade response missing upgradeUrl or expiresAt");
  }
  return { upgradeUrl: json.upgradeUrl, expiresAt: json.expiresAt };
}

export async function resolveLimitUpgradeEligible(
  phoneNumber: string,
  headlessBlockedReason?: string,
): Promise<boolean> {
  const state = await resolveCheckoutLimitState(phoneNumber, {
    headlessBlockedReason,
    headlessOptionCount: headlessBlockedReason === "guest_transaction_count" ? 0 : 1,
  });
  return state.limitUpgradeEligible;
}
