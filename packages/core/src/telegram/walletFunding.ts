import { config } from "@/config/config.js";
import { FundSessionAdapter } from "@/wallet/fundSession.js";
import { buildOnrampUrl } from "@/wallet/onramp.js";

/** Mint a basemate.app/pay link that tops up a Telegram owner's strategy wallet. */
export async function createTelegramFundUrl(
  ownerKey: string,
  walletAddress: string,
): Promise<string | null> {
  if (!config.cdp.paymentsEnabled) return null;

  const partnerUserRef = ownerKey.replace(/[^a-z0-9]/gi, "").slice(0, 50) || `tg${walletAddress.slice(2, 12)}`;

  try {
    const onrampUrl = await buildOnrampUrl({
      address: walletAddress,
      partnerUserRef,
    });
    const token = await FundSessionAdapter.create(ownerKey, onrampUrl);
    return `${config.cdp.fundPageUrl}?s=${token}`;
  } catch {
    return null;
  }
}
