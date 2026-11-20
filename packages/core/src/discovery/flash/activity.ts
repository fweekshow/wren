import { TxConfirmationAdapter } from "@/discovery/adapters/txConfirmation.adapter.js";
import { logger } from "@/utils/logger.js";

import type { FlashFill, FlashOrderDetail, FlashOrderStatus, FlashPreparedOrder } from "./types.js";

const BASE_CHAIN_ID = "0x2105";

const FILLED: FlashOrderStatus = "ORDER_STATUS_FILLED";
const TERMINAL_FAIL = new Set<FlashOrderStatus>([
  "ORDER_STATUS_CANCELLED",
  "ORDER_STATUS_REJECTED",
  "ORDER_STATUS_TERMINATED",
]);

export function isFlashOrderFilled(status?: string | null): boolean {
  return status === FILLED;
}

export function isFlashOrderTerminalFail(status?: string | null): boolean {
  return Boolean(status && TERMINAL_FAIL.has(status as FlashOrderStatus));
}

/** Activity feed label — swap shape without chain (everything is Base). */
export function formatFlashActivityLabel(prepared: FlashPreparedOrder): string {
  const qty = prepared.qty.trim();
  const usdN = Number(prepared.fromNotional);
  const usd =
    Number.isFinite(usdN) && usdN > 0
      ? ` ($${usdN >= 0.01 ? usdN.toFixed(2).replace(/\.?0+$/, "") : usdN.toFixed(2)})`
      : "";
  if (prepared.side === "buy") {
    return `Swap ${qty} ${prepared.contraSymbol}${usd} → ${prepared.targetSymbol}`;
  }
  return `Swap ${qty} ${prepared.targetSymbol}${usd} → ${prepared.contraSymbol}`;
}

export function flashFillTxHash(detail?: FlashOrderDetail | null): string | null {
  const fills = detail?.fills ?? [];
  for (const fill of fills) {
    const tx = fillTxId(fill);
    if (tx) return tx;
  }
  return null;
}

function fillTxId(fill: FlashFill): string | null {
  const id = fill.transactionId?.trim();
  if (!id) return null;
  return id.startsWith("0x") ? id : `0x${id}`;
}

export function flashActivityAmountAsset(prepared: FlashPreparedOrder): {
  amount: string;
  asset: string;
} {
  if (prepared.side === "buy") {
    return { amount: prepared.qty, asset: prepared.contraSymbol };
  }
  return { amount: prepared.qty, asset: prepared.targetSymbol };
}

/**
 * Write a confirmed Flash fill into `tx_confirmations` (app Activity feed).
 * Best-effort — never throws to callers.
 */
export async function recordFlashFillActivity(args: {
  senderId: string;
  prepared: FlashPreparedOrder;
  orderId: string;
  detail?: FlashOrderDetail | null;
}): Promise<{ sid: string | null; txHash: string | null }> {
  const label = formatFlashActivityLabel(args.prepared);
  const { amount, asset } = flashActivityAmountAsset(args.prepared);
  const txHash = flashFillTxHash(args.detail);
  try {
    const sid = await TxConfirmationAdapter.recordConfirmedActivity({
      senderId: args.senderId,
      fromAddress: args.prepared.funderAddress,
      chainId: BASE_CHAIN_ID,
      label,
      txHash,
      transferAmount: amount,
      transferAsset: asset,
      transferMemo: `flash:${args.orderId}`,
    });
    return { sid, txHash };
  } catch (err) {
    logger.error(
      { err, orderId: args.orderId, senderId: args.senderId },
      "[flash] failed to record activity",
    );
    return { sid: null, txHash };
  }
}
