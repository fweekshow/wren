import { config } from "@/config/config.js";
import { logger } from "@/utils/logger.js";
import { ONRAMP_MIN_USD } from "@/wallet/onramp.js";

/**
 * Log misconfiguration that breaks Headless Onramp embeds or hosted redirects.
 * Operational checklist (CDP portal): basemate.app on domain allowlist, redirect URLs
 * allowlisted, Apple Merchant ID domain file at /.well-known/, sandbox keys only when
 * CDP_ONRAMP_SANDBOX=true.
 */
export function validateCdpOnrampConfig(): void {
  if (!config.cdp.enabled) return;

  const fundPageUrl = config.cdp.fundPageUrl.trim();
  const fundPageDomain = config.cdp.fundPageDomain.trim();

  if (fundPageUrl && !fundPageUrl.includes("localhost")) {
    try {
      const host = new URL(fundPageUrl).hostname;
      if (fundPageDomain && host !== fundPageDomain) {
        logger.warn(
          { fundPageUrl, fundPageDomain, host },
          "[onramp-config] CDP_FUND_PAGE_DOMAIN should match the hostname of CDP_FUND_PAGE_URL for iframe Apple Pay",
        );
      }
    } catch {
      logger.warn({ fundPageUrl }, "[onramp-config] CDP_FUND_PAGE_URL is not a valid URL");
    }
  }

  if (config.cdp.onrampSandbox) {
    logger.info("[onramp-config] sandbox mode — omitting domain param on localhost; use sandbox API keys");
  } else if (!fundPageDomain) {
    logger.warn("[onramp-config] CDP_FUND_PAGE_DOMAIN is empty — Headless Apple Pay iframe may fail");
  }

  if (!config.cdp.onrampWebhookSecret) {
    logger.info(
      "[onramp-config] CDP_ONRAMP_WEBHOOK_SECRET unset — webhook accepts unsigned payloads (prod has no secret; /pay record-funding is the primary path)",
    );
  }

  logger.info({ minimumUsd: ONRAMP_MIN_USD }, "[onramp-config] guest checkout minimum");
}
