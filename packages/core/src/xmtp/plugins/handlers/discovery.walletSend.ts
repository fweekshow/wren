/**
 * discovery.walletSend — wallet_sendCalls helpers for the discovery plugin.
 *
 * Extracted from discovery.plugin.ts.
 * Two functions live here:
 *   sendWalletSendCalls    — low-level: sends a wallet_sendCalls XMTP message
 *   sendTrackedWalletCalls — higher-level: registers protocol volume + follow-up,
 *                            then delegates to sendWalletSendCalls
 *
 * Used by perp wizard, swap intercepts, copy trade, and position close.
 */

import type { MessageContext } from "@xmtp/agent-sdk";
import {
  ContentTypeWalletSendCalls,
  type WalletSendCallsParams,
} from "@xmtp/content-type-wallet-send-calls";

import type { AIResponse, WalletCall } from "@/discovery/ai.js";
import { resolveSenderWalletAddress } from "@/xmtp/core/index.js";
import { stateDelete, stateSet } from "@/state/conversationState.store.js";
import {
  XK,
  registerPendingTxConfirmLink,
  type TxConfirmLink,
} from "@/xmtp/plugins/handlers/discovery.stateKeys.js";

/**
 * Send a wallet_sendCalls message in the conversation.
 * Base App renders this as a native "sign this transaction" prompt.
 * The `from` field is intentionally zeroed — Base App fills in the
 * user's connected wallet address before signing.
 */
export async function sendWalletSendCalls(
  ctx: MessageContext<string>,
  calls: WalletCall[],
  chainId: `0x${string}`,
  fallbackText: string,
  from?: string,
  confirmLink: TxConfirmLink = "basemate",
): Promise<void> {
  registerPendingTxConfirmLink(ctx.conversation.id, confirmLink);
  try {
    // Resolve the signer address: prefer explicit `from`, then try to resolve from context.
    // Base App uses `from` to know which wallet should sign — a zero address silently does nothing.
    let signerAddress = from;
    if (!signerAddress || signerAddress === "0x0000000000000000000000000000000000000000") {
      signerAddress =
        (await resolveSenderWalletAddress(ctx as any)) ||
        "0x0000000000000000000000000000000000000000";
    }

    const payload: WalletSendCallsParams = {
      version: "1.0",
      chainId,
      from: signerAddress as `0x${string}`,
      calls: calls.map((c) => ({
        to: c.to,
        data: c.data,
        value: c.value,
        metadata: c.metadata,
      })),
    };
    // ctx.conversation is the raw XMTP Group/Dm; send() accepts any content type
    await (ctx.conversation as any).send(payload, ContentTypeWalletSendCalls);
  } catch (err) {
    console.error("❌ sendWalletSendCalls failed, falling back to text:", err);
    await ctx.conversation.send(fallbackText);
  }
}

export async function sendTrackedWalletCalls(
  ctx: MessageContext<string>,
  calls: WalletCall[],
  chainId: `0x${string}`,
  fallbackText: string,
  traderAddr: string,
  followUp?: string,
  protocolVolume?: Extract<AIResponse, { type: "transaction" }>["protocolVolume"],
): Promise<void> {
  // Register portfolio follow-up before sending the tx card so the
  // transactionReference handler fires it after the user signs.
  // Clear any stale entry (e.g. abandoned perp card) so it never fires after an unrelated swap.
  if (followUp) {
    await stateSet(XK.pendingYieldFollowUp(ctx.conversation.id), followUp);
  } else {
    await stateDelete(XK.pendingYieldFollowUp(ctx.conversation.id));
  }

  if (protocolVolume && protocolVolume.amountUsdc > 0) {
    await stateSet(XK.pendingProtocolVolume(ctx.conversation.id), {
      ...protocolVolume,
      inboxId: ctx.message.senderInboxId,
    });
  }

  const confirmLink: TxConfirmLink =
    protocolVolume?.protocol === "avantis" ? "avantis" : "basemate";
  registerPendingTxConfirmLink(ctx.conversation.id, confirmLink);

  await sendWalletSendCalls(ctx, calls, chainId, fallbackText, traderAddr, confirmLink);
}
