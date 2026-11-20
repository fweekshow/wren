import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { TxConfirmationAdapter } from "@/discovery/adapters/txConfirmation.adapter.js";
import { buildFundingConfirmMessage, sendFundingConfirmDm } from "@/wallet/fundingNotify.js";

/** Record a confirmed onramp deposit in activity and DM the user in chat. */
export async function recordOnrampFunding(input: {
  senderId: string;
  amountUsd?: number;
  skipDm?: boolean;
}): Promise<void> {
  const embedded = await WalletAdapter.getEmbeddedWallet(input.senderId);
  if (!embedded?.address) {
    throw new Error("No Basemate wallet found for this account.");
  }

  const amount =
    typeof input.amountUsd === "number" && Number.isFinite(input.amountUsd) && input.amountUsd > 0
      ? input.amountUsd
      : 0;

  await TxConfirmationAdapter.recordConfirmedActivity({
    senderId: input.senderId,
    fromAddress: embedded.address,
    chainId: "0x2105",
    label: amount ? `Added $${amount} USDC` : "Added funds",
    transferAmount: amount ? String(amount) : null,
    transferAsset: "USDC",
  });

  if (!input.skipDm) {
    void sendFundingConfirmDm(input.senderId, buildFundingConfirmMessage(amount));
  }
}
