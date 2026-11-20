import { setStrategyExecFailureNotifier } from "@/discovery/strategy/strategyExecNotify.js";
import { parseStrategyOwner, TELEGRAM_OWNER_PREFIX } from "@/discovery/strategy/owner.js";
import { BASEMATE_WALLET_LABEL } from "@/discovery/strategy/wallet.js";
import { isStrategyPaymasterEnabled } from "@/wallet/cdp.js";
import { logger } from "@/utils/logger.js";

import { sendMessage } from "./api.js";
import { esc } from "./ux.js";

/** Notify Telegram-native strategy owners when live execution hits a funding failure. */
export function wireTelegramStrategyNotifications(): void {
  setStrategyExecFailureNotifier(async (notice) => {
    if (!notice.creatorInboxId.startsWith(TELEGRAM_OWNER_PREFIX)) return;

    // With CDP paymaster, gas is sponsored — don't nag users about ETH.
    if (notice.issue === "no_gas" && isStrategyPaymasterEnabled()) return;

    let chatId: string;
    try {
      const owner = parseStrategyOwner(notice.creatorInboxId);
      if (owner.platform !== "telegram") return;
      chatId = owner.userId;
    } catch {
      return;
    }

    const margin = Math.max(1, Math.ceil(notice.marginUsdc));
    const body =
      notice.issue === "no_gas"
        ? `"${esc(notice.strategyName)}" is live but your ${BASEMATE_WALLET_LABEL} needs a little ETH for gas on Base.`
        : `"${esc(notice.strategyName)}" tried to trade — top up at least $${margin} USDC in your ${BASEMATE_WALLET_LABEL}.`;

    try {
      await sendMessage({ chatId, text: body });
      if (notice.walletAddress) {
        await sendMessage({
          chatId,
          text:
            `<b>Basemate wallet</b>\n<code>${esc(notice.walletAddress)}</code>\n\n` +
            "Send USDC on Base, then tap Wallet in the menu.",
        });
      }
    } catch (err) {
      logger.warn(`[Telegram] exec-failure notify failed: ${(err as Error).message}`);
    }
  });
}
