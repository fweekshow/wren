import { buildRoutedSwap } from "@/discovery/ai/tools/swap.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { stateDelete, stateGet, stateSet } from "@/state/conversationState.store.js";
import type { ImessageOutbound } from "@/imessage/outbound.js";

import type { HandlerCtx } from "../handler.ctx.js";
import type { PendingGroupCopyTrade } from "../handler.types.js";
import { parseNumberText } from "../utils/wallet.utils.js";

function formatPrepareFailure(_kind: string, message?: string): string {
  return message || "couldn't build that trade — try again in a moment";
}
import { executeUserTransaction } from "./wallet.handler.js";

const BASE_CHAIN_ID = "0x2105" as const;
const COPY_TRADE_TTL_SECONDS = 5 * 60;

function originalAmount(copy: PendingGroupCopyTrade): string {
  return copy.type === "swap" ? copy.amount : copy.collateral;
}

async function executeCopyTrade(
  ctx: HandlerCtx,
  senderId: string,
  copy: PendingGroupCopyTrade,
  amount: string,
  conversationId: string,
  deliveryPhone?: string,
): Promise<ImessageOutbound[]> {
  const embedded = await WalletAdapter.getEmbeddedWallet(senderId);
  if (!embedded) {
    return ["connect your Basemate account first, then reply COPY again."];
  }

  if (copy.type === "swap") {
    try {
      const swap = await buildRoutedSwap(
        copy.fromAddress,
        copy.fromSymbol,
        copy.fromDecimals,
        copy.toAddress,
        copy.toSymbol,
        amount,
        embedded.address,
      );
      if (!swap) {
        return [`couldn't build a route for ${copy.fromSymbol} → ${copy.toSymbol}. try again shortly.`];
      }
      return executeUserTransaction(ctx, {
        senderId,
        calls: swap.calls,
        chainId: BASE_CHAIN_ID,
        label: swap.label,
        amountUsd: copy.fromSymbol.toUpperCase() === "USDC" ? Number(amount) : null,
        tradeContext: {
          conversationId,
          isGroup: true,
          deliveryPhone,
          originSenderId: senderId,
        },
      });
    } catch (err) {
      console.warn("⚠️ [copy-trade] swap build failed:", err);
      return ["couldn't prepare that copied swap — try again in a moment."];
    }
  }

  const prepared = await prepareAvantisOpen({
    pair: normalizeAvantisPair(copy.pair),
    side: copy.side,
    leverage: copy.leverage,
    collateral: amount,
    trader: embedded.address,
    orderType: copy.orderType === "limit" ? "limit" : "market",
    openPrice: copy.orderType === "limit" ? copy.openPrice : undefined,
  });
  if (!prepared.ok) {
    return [formatPrepareFailure(prepared.kind, "message" in prepared ? prepared.message : undefined)];
  }
  return executeUserTransaction(ctx, {
    senderId,
    calls: prepared.calls,
    chainId: BASE_CHAIN_ID,
    label: prepared.label,
    amountUsd: Number(amount),
    tradeContext: {
      conversationId,
      isGroup: true,
      deliveryPhone,
      originSenderId: senderId,
    },
  });
}

export async function handleCopyTradeText(
  ctx: HandlerCtx,
  params: {
    senderId: string;
    conversationId: string;
    isGroup: boolean;
    deliveryPhone?: string;
    text: string;
  },
): Promise<ImessageOutbound[] | null> {
  if (!params.isGroup) return null;

  const userScope = `${params.senderId}:${params.conversationId}`;
  const amountKey = ctx.K.pendingCopyTradeAmount(userScope);
  const pendingAmount = await stateGet<PendingGroupCopyTrade>(amountKey);
  if (pendingAmount) {
    if (pendingAmount.expiresAt <= Date.now()) {
      await stateDelete(amountKey);
      return ["that copy-trade option expired — wait for the next confirmed trade."];
    }
    if (/^(?:cancel|stop|never ?mind|nvm)$/i.test(params.text.trim())) {
      await stateDelete(amountKey);
      return ["copy trade cancelled."];
    }
    const amount = /^same(?: amount)?$/i.test(params.text.trim())
      ? originalAmount(pendingAmount)
      : parseNumberText(params.text);
    if (!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      const unit = pendingAmount.type === "swap" ? pendingAmount.fromSymbol : "USDC";
      return [`reply "same" or enter a positive ${unit} amount.`];
    }
    await stateDelete(amountKey);
    return executeCopyTrade(
      ctx,
      params.senderId,
      pendingAmount,
      amount,
      params.conversationId,
      params.deliveryPhone ?? pendingAmount.deliveryPhone,
    );
  }

  if (!/^copy(?: trade)?$/i.test(params.text.trim())) return null;

  const groupKey = ctx.K.pendingGroupCopyTrade(params.conversationId);
  const copy = await stateGet<PendingGroupCopyTrade>(groupKey);
  if (!copy || copy.expiresAt <= Date.now()) {
    if (copy) await stateDelete(groupKey);
    return ["there isn't an active trade to copy — the option lasts 5 minutes after confirmation."];
  }
  if (copy.originSenderId === params.senderId) {
    return ["that's your own trade — COPY is for other group members."];
  }

  await stateSet(amountKey, copy, COPY_TRADE_TTL_SECONDS);
  const unit = copy.type === "swap" ? copy.fromSymbol : "USDC";
  return [
    `Copy ${copy.label}? Reply "same" to use ${originalAmount(copy)} ${unit}, or enter a different ${unit} amount.`,
  ];
}
