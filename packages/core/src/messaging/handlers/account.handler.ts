import { config } from "@/config/config.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { transactionMiniAppOutbound, type ImessageOutbound } from "@/imessage/outbound.js";
import { pendingAlerts, pendingAlertKey } from "@/price-alerts/index.js";
import { stateHasAny } from "@/state/conversationState.store.js";
import { basemateAccountOrigin } from "@/wallet/accountOrigin.js";
import { WalletSetupSessionAdapter } from "@/wallet/walletSetupSession.js";

import { launchFlowKey } from "../utils/launch.utils.js";
import { normalizeConnectedWalletAddress } from "../utils/wallet.utils.js";
import type { HandlerCtx } from "../handler.ctx.js";

export async function getConnectedWalletAddress(
  _ctx: HandlerCtx,
  senderId: string,
): Promise<string | null> {
  const embedded = await WalletAdapter.getEmbeddedWallet(senderId);
  return normalizeConnectedWalletAddress(embedded?.address ?? null);
}

/**
 * Prompt the user to set up (or reconnect) their Basemate account — the CDP
 * embedded wallet with delegated signing. All email/passkey and signing happens
 * on basemate.app; no keys.coinbase, no wallet apps.
 */
export async function connectBasemateAccountMessages(
  _ctx: HandlerCtx,
  senderId: string,
  opts: { reauth?: boolean } = {},
): Promise<ImessageOutbound[]> {
  try {
    const token = await WalletSetupSessionAdapter.create(senderId);
    const url = new URL(`${basemateAccountOrigin(config.payPage.origin)}/wallet/connect`);
    url.searchParams.set("s", token);
    const lead = opts.reauth
      ? "quick reconnect needed to keep sending from your Basemate account:"
      : "set up your Basemate account — just sign in with your email, no wallet apps or popups:";
    return [[lead, "", url.toString()].join("\n")];
  } catch (err) {
    console.error("⚠️ [iMessage] failed to start Basemate account connect:", err);
    return ["i couldn't start Basemate account setup right now — try again in a moment."];
  }
}

export function transactionApprovalOutbound(
  _ctx: HandlerCtx,
  args: {
    label: string;
    url: string;
    signerAddress: string;
    summary?: string;
  },
): ImessageOutbound {
  return transactionMiniAppOutbound({
    label: args.label,
    url: args.url,
    signerAddress: args.signerAddress,
    summary: args.summary,
    metadata: config.imessageMiniApp,
  });
}

export async function hasPendingInteraction(
  ctx: HandlerCtx,
  {
    senderId,
    conversationId,
  }: {
    senderId: string;
    conversationId: string;
  },
): Promise<boolean> {
  const { K, platform } = ctx;
  const flowKey = `${senderId}:${conversationId}`;
  const alertKey = pendingAlertKey(platform, senderId, conversationId);
  if (await pendingAlerts.hasAsync(alertKey)) return true;
  return stateHasAny([
    K.pendingContactName(senderId),
    K.pendingContactConfirm(senderId),
    K.pendingSendDisambiguation(senderId),
    K.pendingSendMessage(senderId),
    K.pendingDisplayName(senderId),
    K.pendingTrade(senderId),
    K.pendingSweep(senderId),
    K.pendingPerpFlow(flowKey),
    K.pendingLink(senderId),
    K.pendingYieldChoice(senderId),
    K.pendingAmountChoice(senderId),
    K.pendingSwapDraft(senderId),
    K.pendingPostTxAction(senderId),
    K.pendingOnrampEmail(senderId),
    K.pendingEmailOtpVerification(senderId),
    K.pendingPhoneOtpVerification(senderId),
    K.pendingFundAmount(senderId),
    K.pendingWorldCupMatch(senderId, conversationId),
    K.pendingEscrowConfirm(senderId),
    K.pendingGiftStock(senderId),
    K.pendingLaunch(launchFlowKey(conversationId, senderId)),
  ]);
}
