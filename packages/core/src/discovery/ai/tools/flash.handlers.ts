/**
 * Definitive Flash spot orders (market + limit / stop / TP / TWAP).
 * When FLASH_API_KEY is set, market swaps also enter through uniswap_prepare_swap → Flash.
 */

import { config } from "@/config/config.js";
import {
  amountUsdFromPrepared,
  flashCancelMessage,
  flashCancelOrder,
  flashListOrders,
  FlashPrepareError,
  formatFlashOrderPreview,
  prepareFlashOrder,
  type FlashOrderType,
  type FlashOrderSide,
  type FlashPriceTrigger,
} from "@/discovery/flash/index.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { EmbeddedWalletAdapter, EmbeddedWalletError } from "@/wallet/embeddedWallet.js";

import type { RespondCtx, ToolResult } from "../toolbox.js";

const FLASH_ORDER_TYPES = new Set<FlashOrderType>([
  "market",
  "limit",
  "twap",
  "stop",
  "stop-loss",
  "take-profit",
  "bracket",
]);

function userKey(ctx: RespondCtx): string {
  return ctx.copyUserKey ?? ctx.inboxId;
}

function triggerFromArgs(args: {
  triggerNotionalPrice?: string;
  triggerType?: "upper" | "lower";
  orderType: FlashOrderType;
}): FlashPriceTrigger[] | undefined {
  const price = args.triggerNotionalPrice?.trim();
  if (!price) return undefined;
  let triggerType = args.triggerType;
  if (!triggerType) {
    // Defaults aligned with typical stop-loss (lower) / take-profit (upper) semantics.
    if (args.orderType === "stop-loss") triggerType = "lower";
    else if (args.orderType === "take-profit") triggerType = "upper";
    else if (args.orderType === "stop") triggerType = "upper";
    else triggerType = "lower";
  }
  return [{ notionalPrice: price, triggerType }];
}

export async function flash_prepare_order(
  ctx: RespondCtx,
  args: {
    targetAsset: string;
    contraAsset: string;
    side: FlashOrderSide;
    qty: string;
    orderType: FlashOrderType;
    limitNotionalPrice?: string;
    triggerNotionalPrice?: string;
    triggerType?: "upper" | "lower";
    durationSeconds?: number;
    twapBucketCount?: number;
    maxSlippage?: string;
  },
): Promise<ToolResult> {
  if (!config.flash.enabled) {
    return {
      data: { error: "Flash not configured" },
      control: {
        type: "text",
        text: "advanced orders aren't live yet — for now use a regular swap (buy/sell).",
      },
    };
  }

  if (!FLASH_ORDER_TYPES.has(args.orderType)) {
    return {
      data: { error: "Unsupported order type" },
      control: {
        type: "text",
        text: "supported Flash order types: market, limit, stop, stop-loss, take-profit, twap.",
      },
    };
  }

  const embedded = await WalletAdapter.getEmbeddedWallet(userKey(ctx));
  if (!embedded) {
    return {
      data: { error: "No embedded wallet" },
      control: {
        type: "text",
        text: "connect your Basemate account first so I can place advanced orders for you.",
      },
    };
  }

  try {
    const prepared = await prepareFlashOrder({
      funderAddress: embedded.address,
      targetAsset: args.targetAsset,
      contraAsset: args.contraAsset,
      side: args.side,
      qty: args.qty,
      orderType: args.orderType,
      limitNotionalPrice: args.limitNotionalPrice,
      durationSeconds: args.durationSeconds,
      twapBucketCount: args.twapBucketCount,
      triggers: triggerFromArgs(args),
      maxSlippage: args.maxSlippage,
    });

    const preview = formatFlashOrderPreview(prepared);
    return {
      data: { quoteId: prepared.quoteId, orderType: prepared.orderType },
      control: {
        type: "flash_order",
        text: preview,
        prepared,
        amountUsd: amountUsdFromPrepared(prepared),
      },
    };
  } catch (err) {
    const msg =
      err instanceof FlashPrepareError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Couldn't prepare that order.";
    return {
      data: { error: msg },
      control: { type: "text", text: msg },
    };
  }
}

export async function flash_list_orders(ctx: RespondCtx): Promise<ToolResult> {
  if (!config.flash.enabled) {
    return {
      data: { error: "Flash not configured" },
      control: { type: "text", text: "advanced orders aren't live yet." },
    };
  }
  const embedded = await WalletAdapter.getEmbeddedWallet(userKey(ctx));
  if (!embedded) {
    return {
      data: { error: "No wallet" },
      control: { type: "text", text: "connect your Basemate account first." },
    };
  }

  try {
    const { orders } = await flashListOrders({
      funderAddress: embedded.address,
      pageSize: 10,
    });
    if (!orders?.length) {
      return {
        data: { orders: [] },
        control: { type: "text", text: "no open Flash orders." },
      };
    }
    const lines = orders.map((o) => {
      const id = o.orderId.slice(0, 10);
      const status = (o.status ?? "ORDER_STATUS_UNSPECIFIED")
        .replace("ORDER_STATUS_", "")
        .toLowerCase()
        .replace(/_/g, " ");
      return `• ${o.orderType ?? "order"} ${o.side ?? ""} — ${status} (${id}…)`;
    });
    return {
      data: { orders },
      control: {
        type: "text",
        text: `your Flash orders:\n${lines.join("\n")}\n\nsay cancel flash order <id> to cancel.`,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Couldn't list orders.";
    return { data: { error: msg }, control: { type: "text", text: msg } };
  }
}

export async function flash_cancel_order(
  ctx: RespondCtx,
  args: { orderId: string },
): Promise<ToolResult> {
  if (!config.flash.enabled) {
    return {
      data: { error: "Flash not configured" },
      control: { type: "text", text: "advanced orders aren't live yet." },
    };
  }
  const orderId = args.orderId?.trim();
  if (!orderId) {
    return {
      data: { error: "Missing orderId" },
      control: { type: "text", text: "which order id should I cancel?" },
    };
  }

  const embedded = await WalletAdapter.getEmbeddedWallet(userKey(ctx));
  if (!embedded) {
    return {
      data: { error: "No wallet" },
      control: { type: "text", text: "connect your Basemate account first." },
    };
  }

  try {
    const cancelMessage = flashCancelMessage(orderId);
    const { signature } = await EmbeddedWalletAdapter.signMessage({
      userId: embedded.cdpUserId,
      address: embedded.address,
      message: cancelMessage,
    });
    await flashCancelOrder({
      orderId,
      cancelMessage,
      userSignature: signature,
    });
    return {
      data: { ok: true, orderId },
      control: {
        type: "text",
        text: `cancelled ${orderId.slice(0, 12)}…`,
      },
    };
  } catch (err) {
    if (err instanceof EmbeddedWalletError && err.needsReauth) {
      return {
        data: { error: "needs_reauth" },
        control: {
          type: "text",
          text: "your Basemate account authorization expired — reconnect, then try cancel again.",
        },
      };
    }
    const msg = err instanceof Error ? err.message : "Couldn't cancel that order.";
    return { data: { error: msg }, control: { type: "text", text: msg } };
  }
}
