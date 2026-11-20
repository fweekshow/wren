import { logger } from "@/utils/logger.js";

/**
 * Proactive "you added funds" DM after an onramp completes.
 *
 * The dashboard's headless Apple Pay frame reports success to
 * `POST /api/app/record-funding`, which runs in the API layer with no direct
 * Spectrum/messaging handle. The bot process registers a sender here at
 * startup (same pattern as the price-alert / offramp delivery registries) so
 * the API can hand a confirmation DM back to the user's chat.
 */
export type FundingConfirmSender = (
  senderId: string,
  message: string,
) => Promise<boolean>;

let sender: FundingConfirmSender | null = null;

/** Register the platform DM sender (called once at bot startup). */
export function registerFundingConfirmSender(fn: FundingConfirmSender): void {
  sender = fn;
}

/** Build the on-brand confirmation copy. */
export function buildFundingConfirmMessage(amountUsd: number): string {
  return amountUsd > 0
    ? `✅ added $${amountUsd} — it's in your Basemate wallet. ready when you are: send to a friend, earn, or trade.`
    : `✅ funds added — they're in your Basemate wallet. ready when you are: send to a friend, earn, or trade.`;
}

/**
 * Deliver the funding-confirmation DM. No-ops (returns false) when no sender is
 * registered yet — never throws, so it can't break the funding-record response.
 */
export async function sendFundingConfirmDm(
  senderId: string,
  message: string,
): Promise<boolean> {
  if (!sender) {
    logger.warn("⚠️ funding confirm DM dropped — no sender registered");
    return false;
  }
  try {
    return await sender(senderId, message);
  } catch (err) {
    logger.error({ err }, "funding confirm DM failed");
    return false;
  }
}
