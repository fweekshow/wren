import { config } from "@/config/config.js";
import type { AIResponse } from "@/discovery/ai.js";
import {
  FlashPlaceError,
  flashFillTxHash,
  formatFlashActivityLabel,
  formatFlashOrderPreview,
  flashActivityAmountAsset,
  placeFlashOrder,
  PendingFlashAdapter,
  resolveFlashFillOnce,
  waitForFlashFill,
  type FlashOrderDetail,
  type FlashPreparedOrder,
} from "@/discovery/flash/index.js";
import {
  DEFAULT_AUTO_SEND_LIMIT_USD,
  WalletAdapter,
} from "@/discovery/adapters/wallet.adapter.js";
import { stripMarkdown, type ImessageOutbound } from "@/imessage/outbound.js";
import { stateDelete, stateGet, stateSet } from "@/state/conversationState.store.js";
import { PendingPayAdapter } from "@/wallet/pendingPay.js";
import { EmbeddedWalletError } from "@/wallet/embeddedWallet.js";
import { logger } from "@/utils/logger.js";

import {
  connectBasemateAccountMessages,
  transactionApprovalOutbound,
} from "./account.handler.js";
import { formatFlashReceipt, friendlyFlashPlaceError } from "./flashReceipt.js";
import type { HandlerCtx } from "../handler.ctx.js";

const PENDING_FLASH_TTL_MS = 10 * 60 * 1000;
const BASE_CHAIN_ID = "0x2105" as const;

export type PendingFlashOrder = {
  prepared: FlashPreparedOrder;
  label: string;
  createdAt: number;
  conversationId?: string;
};

async function trackAndResolveActivity(args: {
  senderId: string;
  orderId: string;
  prepared: FlashPreparedOrder;
  detail?: FlashOrderDetail | null;
}): Promise<void> {
  try {
    await PendingFlashAdapter.track({
      orderId: args.orderId,
      senderId: args.senderId,
      prepared: args.prepared,
    });
    await resolveFlashFillOnce({
      orderId: args.orderId,
      senderId: args.senderId,
      prepared: args.prepared,
      detail: args.detail,
    });
  } catch (err) {
    logger.warn(
      { err, orderId: args.orderId, senderId: args.senderId },
      "[flash] activity track/resolve failed",
    );
  }
}

export async function runFlashOrder(
  ctx: HandlerCtx,
  args: {
    senderId: string;
    cdpUserId: string;
    prepared: FlashPreparedOrder;
  },
): Promise<ImessageOutbound[]> {
  try {
    const result = await placeFlashOrder({
      cdpUserId: args.cdpUserId,
      prepared: args.prepared,
    });

    const detail = await waitForFlashFill({
      orderId: result.orderId,
      funderAddress: args.prepared.funderAddress,
      initial: result.detail,
      attempts: args.prepared.orderType === "market" ? 10 : 4,
    });

    await trackAndResolveActivity({
      senderId: args.senderId,
      orderId: result.orderId,
      prepared: args.prepared,
      detail,
    });

    return [formatFlashReceipt(args.prepared, detail ?? result.detail)];
  } catch (err) {
    if (err instanceof EmbeddedWalletError && err.needsReauth) {
      return connectBasemateAccountMessages(ctx, args.senderId, { reauth: true });
    }
    const raw =
      err instanceof FlashPlaceError || err instanceof EmbeddedWalletError
        ? err.message
        : "couldn't place that order — try again in a moment.";
    const msg = err instanceof FlashPlaceError ? friendlyFlashPlaceError(raw) : raw;
    logger.error({ err, senderId: args.senderId }, "[flash] place failed");
    return [msg];
  }
}

/** Advanced orders only — chat confirm (markets use /pay or auto-place). */
async function stashPendingFlashOrder(
  ctx: HandlerCtx,
  senderId: string,
  pending: PendingFlashOrder,
): Promise<ImessageOutbound[]> {
  await stateSet(ctx.K.pendingFlashOrder(senderId), pending);
  return [
    `${pending.label}\n\nreply "confirm" to place it, or "cancel" to drop it.`,
  ];
}

async function buildFlashPayConfirmLink(
  ctx: HandlerCtx,
  args: {
    senderId: string;
    embeddedAddress: string;
    prepared: FlashPreparedOrder;
    label: string;
    conversationId?: string;
    note?: string;
  },
): Promise<ImessageOutbound[]> {
  const { amount, asset } = flashActivityAmountAsset(args.prepared);
  try {
    const { token } = await PendingPayAdapter.create({
      senderId: args.senderId,
      fromAddress: args.embeddedAddress,
      chainId: BASE_CHAIN_ID,
      calls: [],
      label: args.label,
      amount,
      tokenSymbol: asset,
      walletKind: "embedded",
      executionKind: "flash",
      flashPrepared: args.prepared,
      conversationId: args.conversationId ?? null,
    });
    const url = `${config.payPage.origin}/pay/sign/${token}`;
    return [
      transactionApprovalOutbound(ctx, {
        label: args.label,
        url,
        signerAddress: args.embeddedAddress,
        summary: args.note,
      }),
    ];
  } catch (err) {
    logger.error({ err, senderId: args.senderId }, "[flash] failed to create pay confirm link");
    return ["i couldn't prepare that confirmation — try again in a moment."];
  }
}

/**
 * Quick: place Flash immediately (wait for fill → one confirmed receipt).
 * Manual / over-limit markets: /pay Confirm button → place Flash on tap.
 * Advanced (limit/stop/TWAP): chat confirm.
 */
export async function routeFlashOrderResponse(
  ctx: HandlerCtx,
  args: {
    senderId: string;
    conversationId: string;
    resp: Extract<AIResponse, { type: "flash_order" }>;
  },
): Promise<ImessageOutbound[]> {
  if (!config.flash.enabled) {
    return ["advanced orders aren't live yet — try a regular buy/sell for now."];
  }

  const embedded = await WalletAdapter.getEmbeddedWallet(args.senderId);
  if (!embedded) {
    return connectBasemateAccountMessages(ctx, args.senderId);
  }
  if (embedded.delegationExpiresAt && embedded.delegationExpiresAt.getTime() <= Date.now()) {
    return connectBasemateAccountMessages(ctx, args.senderId, { reauth: true });
  }

  const prepared = args.resp.prepared;
  // Markets: always the clean preview headline (never fee/est clutter from older text).
  const label =
    prepared.orderType === "market"
      ? formatFlashOrderPreview(prepared)
      : stripMarkdown(args.resp.text) || formatFlashActivityLabel(prepared);
  const amountUsd =
    typeof args.resp.amountUsd === "number" && Number.isFinite(args.resp.amountUsd)
      ? args.resp.amountUsd
      : null;

  const mode = await WalletAdapter.getEmbeddedPayMode(args.senderId);
  const limit = (await WalletAdapter.getAutoSendLimit(args.senderId)) ?? DEFAULT_AUTO_SEND_LIMIT_USD;
  const knownUsd = amountUsd !== null;
  const overLimit = knownUsd && amountUsd > limit;
  const isMarket = prepared.orderType === "market";

  if (mode === "quick" && !overLimit) {
    return runFlashOrder(ctx, {
      senderId: args.senderId,
      cdpUserId: embedded.cdpUserId,
      prepared,
    });
  }

  // Manual (or over auto-limit): markets use /pay Confirm button.
  if (isMarket) {
    const note = overLimit
      ? `that's above your $${limit} auto-approve limit — tap to confirm 👆`
      : undefined;
    return buildFlashPayConfirmLink(ctx, {
      senderId: args.senderId,
      embeddedAddress: embedded.address,
      prepared,
      label,
      conversationId: args.conversationId,
      note,
    });
  }

  // Advanced orders: chat confirm.
  const note = overLimit
    ? `\n(above your $${limit} auto-approve — confirm to place)`
    : "";
  return stashPendingFlashOrder(ctx, args.senderId, {
    prepared,
    label: `${label}${note}`,
    createdAt: Date.now(),
    conversationId: args.conversationId,
  });
}

export async function executePendingFlashOrder(
  ctx: HandlerCtx,
  senderId: string,
): Promise<ImessageOutbound[] | null> {
  const pending = await stateGet<PendingFlashOrder>(ctx.K.pendingFlashOrder(senderId));
  if (!pending) return null;
  await stateDelete(ctx.K.pendingFlashOrder(senderId));

  if (Date.now() - pending.createdAt > PENDING_FLASH_TTL_MS) {
    return ["that order quote expired — ask me again and I'll re-quote."];
  }

  const embedded = await WalletAdapter.getEmbeddedWallet(senderId);
  if (!embedded) {
    return connectBasemateAccountMessages(ctx, senderId);
  }

  return runFlashOrder(ctx, {
    senderId,
    cdpUserId: embedded.cdpUserId,
    prepared: pending.prepared,
  });
}

export async function cancelPendingFlashOrder(
  ctx: HandlerCtx,
  senderId: string,
): Promise<boolean> {
  const pending = await stateGet<PendingFlashOrder>(ctx.K.pendingFlashOrder(senderId));
  if (!pending) return false;
  await stateDelete(ctx.K.pendingFlashOrder(senderId));
  return true;
}
