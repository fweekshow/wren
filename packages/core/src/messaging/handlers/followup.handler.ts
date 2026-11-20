import { resolveAllWalletsForUser } from "@/account-linking/index.js";
import { resolveTokenAsync } from "@/discovery/ai.js";
import { fetchErc20TokenBalance } from "@/portfolio-reviews/index.js";
import { renderAIResponseText, type ImessageOutbound } from "@/imessage/outbound.js";
import { stateSet, stateDelete } from "@/state/conversationState.store.js";

import { routeTransactionResponse } from "./wallet.handler.js";
import type { HandlerCtx } from "../handler.ctx.js";
import type { TradeDeliveryContext } from "../handler.types.js";

export async function respondToFollowup(
  ctx: HandlerCtx,
  senderId: string,
  conversationId: string,
  message: string,
  walletAddress: string,
  tradeContext?: Omit<TradeDeliveryContext, "copyTradeCtx">,
): Promise<ImessageOutbound[]> {
  const { K, platform, ai } = ctx;
  const linkedWallets = await resolveAllWalletsForUser(platform, senderId, walletAddress);
  const resp = await ai.respond(message, {
    inboxId: senderId,
    walletAddress,
    linkedWallets,
    custodialWallet: false,
    conversationId,
    userMessage: message,
    disableDeterministicRouting: true,
    copyPlatform: platform,
    copyUserKey: senderId,
    positionsChannel: platform,
  });

  if (resp.type === "disambiguate") {
    await stateSet(K.pendingYieldChoice(senderId), {
      token: resp.token,
      amountToken: resp.amountToken,
      options: resp.options,
      createdAt: Date.now(),
    });
    await stateDelete(K.pendingAmountChoice(senderId));
    return renderAIResponseText(resp);
  }

  if (resp.type === "amount_select") {
    await stateSet(K.pendingAmountChoice(senderId), {
      asset: resp.asset,
      protocol: resp.protocol,
      presetsUsd: resp.presetsUsd,
      createdAt: Date.now(),
    });
    await stateDelete(K.pendingYieldChoice(senderId));
    return renderAIResponseText(resp);
  }

  await stateDelete(K.pendingYieldChoice(senderId));
  await stateDelete(K.pendingAmountChoice(senderId));

  if (resp.type === "transaction") {
    return routeTransactionResponse(ctx, {
      senderId,
      conversationId,
      originalText: message,
      resp,
      tradeContext,
    });
  }

  return renderAIResponseText(resp);
}

/**
 * After a swap confirms, wait for the chain to settle, fetch the received token
 * balance, then call respondToFollowup to prepare and show the deposit card.
 */
export async function executePostSwapDeposit(
  ctx: HandlerCtx,
  args: {
    senderId: string;
    toAsset: string;
    protocol: string;
    walletAddress: string;
    custodialAccountName?: string;
    conversationId: string;
  },
): Promise<ImessageOutbound[]> {
  await new Promise((resolve) => setTimeout(resolve, 3_000));

  let depositAmount: string | undefined;
  try {
    const token = await resolveTokenAsync(args.toAsset);
    if (token.resolved && token.address !== "ETH") {
      const balance = await fetchErc20TokenBalance(token.address, args.walletAddress, token.decimals);
      if (balance > 0) {
        depositAmount = String(parseFloat(balance.toPrecision(6)));
        console.log(`🔗 [iMessage] Post-swap balance: ${depositAmount} ${args.toAsset} → ${args.protocol}`);
      }
    }
  } catch (err) {
    console.warn("⚠️ [iMessage] post-swap balance fetch failed:", err);
  }

  const verb = args.protocol === "moonwell" || args.protocol === "aave" ? "supply" : "deposit";
  const depositMsg = depositAmount
    ? `${verb} ${depositAmount} ${args.toAsset} on ${args.protocol}`
    : `${verb} ${args.toAsset} on ${args.protocol}`;

  return respondToFollowup(
    ctx,
    args.senderId,
    args.conversationId,
    depositMsg,
    args.walletAddress,
  );
}
