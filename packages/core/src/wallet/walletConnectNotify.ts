import { logger } from "@/utils/logger.js";

/**
 * Proactive iMessage DM sent after the user completes the wallet-connect /
 * delegation flow on basemate.app — "you're reconnected, you can send again."
 *
 * `POST /api/agent/wallet/connected-notify` (called from basemate-metrics after
 * the DB write) runs in the API layer with no direct Spectrum handle. The bot
 * registers a sender here at startup (same pattern as fundingNotify) so the
 * API can hand the confirmation DM back to the user's iMessage chat.
 */
export type WalletConnectNotifySender = (
  senderId: string,
  message: string,
) => Promise<boolean>;

let sender: WalletConnectNotifySender | null = null;

/** Register the platform DM sender (called once at bot startup). */
export function registerWalletConnectNotifySender(fn: WalletConnectNotifySender): void {
  sender = fn;
}

/** Copy shown after a fresh account setup (first-time connect). */
export function buildWalletConnectedMessage(): string {
  return "✅ you're all set — your Basemate account is connected. say \"balance\" to see your wallet, or just tell me what you want to do 💙";
}

/** Copy shown after a re-auth reconnect (delegation refreshed). */
export function buildWalletReconnectedMessage(): string {
  return "✅ reconnected! you can send again now — just tell me what you want to do 💙";
}

/**
 * Deliver the wallet-connected DM. No-ops (returns false) when no sender is
 * registered yet — never throws so it can't break the connect-route response.
 */
export async function sendWalletConnectNotifyDm(
  senderId: string,
  message: string,
): Promise<boolean> {
  if (!sender) {
    logger.warn("⚠️ wallet-connect notify DM dropped — no sender registered");
    return false;
  }
  try {
    return await sender(senderId, message);
  } catch (err) {
    logger.error({ err }, "wallet-connect notify DM failed");
    return false;
  }
}
