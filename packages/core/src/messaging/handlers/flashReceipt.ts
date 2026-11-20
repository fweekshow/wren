import { isFlashOrderFilled, type FlashOrderDetail, type FlashPreparedOrder } from "@/discovery/flash/index.js";
import { APP_ACTIVITY_HINT, formatReceipt } from "@/messaging/utils/wallet.utils.js";

/** Compact token amounts for chat receipts (normie-friendly, not scientific). */
export function formatFlashAmount(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return raw.trim() || "0";
  if (n >= 1_000_000) {
    return `${trimZeros((n / 1_000_000).toFixed(2))}M`;
  }
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${trimZeros((n / 1000).toFixed(1))}k`;
  if (n >= 1) return trimZeros(n.toFixed(n >= 100 ? 0 : 4));
  if (n >= 0.01) return trimZeros(n.toFixed(4));
  return trimZeros(n.toPrecision(3));
}

function trimZeros(s: string): string {
  // Only strip fractional trailing zeros — never turn "100" into "1".
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

/** Chat-facing ticker: BASEMATE → Basemate, stables stay USDC. */
export function formatFlashAssetName(symbol: string): string {
  const s = symbol.trim();
  if (!s) return s;
  if (/^usdc$/i.test(s)) return "USDC";
  if (/^usdbc$/i.test(s)) return "USDbC";
  if (/^weth$/i.test(s)) return "WETH";
  if (/^eth$/i.test(s)) return "ETH";
  if (s.length <= 5 && s === s.toUpperCase()) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function isUsdStable(symbol: string): boolean {
  return /^(usdc|usdbc)$/i.test(symbol);
}

function formatUsdAmount(fromNotional: string): string {
  const n = Number(fromNotional);
  if (!Number.isFinite(n) || n <= 0) return "$0";
  return `$${trimZeros(n.toFixed(2))}`;
}

/**
 * Same shape as legacy swap confirms (no chain — everything is Base):
 * `Swap 1 USDC ($1) → BASEMATE`
 */
export function formatFlashSwapLine(prepared: FlashPreparedOrder): string {
  const spentQty = formatFlashAmount(prepared.qty);
  const usd = formatUsdGloss(prepared.fromNotional);

  if (prepared.side === "buy") {
    return `Swap ${spentQty} ${prepared.contraSymbol}${usd} → ${prepared.targetSymbol}`;
  }
  return `Swap ${spentQty} ${prepared.targetSymbol}${usd} → ${prepared.contraSymbol}`;
}

function formatUsdGloss(fromNotional: string): string {
  const n = Number(fromNotional);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1) return ` ($${trimZeros(n.toFixed(2))})`;
  if (n >= 0.01) return ` ($${trimZeros(n.toFixed(2))})`;
  return ` ($${n.toFixed(2)})`;
}

/**
 * Normie Flash receipt — mirrors swap confirms:
 * `✅ Swap 1 USDC ($1) → BASEMATE — confirmed.`
 */
export function formatFlashReceipt(
  prepared: FlashPreparedOrder,
  detail?: Pick<FlashOrderDetail, "status" | "filled"> | null,
): string {
  const filled = isFlashOrderFilled(detail?.status);
  const spentQty = formatFlashAmount(prepared.qty);
  const swapLine = formatFlashSwapLine(prepared);

  if (filled || prepared.orderType === "market") {
    const status = filled ? "confirmed" : "submitted";
    const usd = formatUsdAmount(prepared.fromNotional);
    const receivedQty = formatFlashAmount(prepared.toAmount || prepared.qty);
    let spent: string;
    let got: string;
    if (prepared.side === "buy") {
      const contra = formatFlashAssetName(prepared.contraSymbol);
      const target = formatFlashAssetName(prepared.targetSymbol);
      spent = isUsdStable(prepared.contraSymbol)
        ? `${usd} ${contra}`
        : `${spentQty} ${contra}`;
      got = isUsdStable(prepared.targetSymbol)
        ? `${usd} ${target}`
        : `${receivedQty} ${target}`;
    } else {
      const target = formatFlashAssetName(prepared.targetSymbol);
      const contra = formatFlashAssetName(prepared.contraSymbol);
      spent = isUsdStable(prepared.targetSymbol)
        ? `${usd} ${target}`
        : `${spentQty} ${target}`;
      got = isUsdStable(prepared.contraSymbol)
        ? `${usd} ${contra}`
        : `${receivedQty} ${contra}`;
    }
    return formatReceipt({
      title: `✅ Swap ${status}`,
      lines: [`Spent: ${spent}`, `Got: ${got}`],
      footer: APP_ACTIVITY_HINT,
    });
  }

  // Resting advanced orders
  let what: string;
  if (prepared.orderType === "limit" && prepared.limitNotionalPrice) {
    const spend =
      prepared.side === "buy"
        ? `${spentQty} ${prepared.contraSymbol}`
        : `${spentQty} ${prepared.targetSymbol}`;
    what = `Limit ${prepared.side} ${spend} of ${prepared.targetSymbol} @ $${prepared.limitNotionalPrice}`;
  } else if (prepared.orderType === "stop-loss" || prepared.orderType === "take-profit" || prepared.orderType === "stop") {
    const trigger = prepared.triggers?.[0]?.notionalPrice;
    const kind =
      prepared.orderType === "take-profit"
        ? "Take-profit"
        : prepared.orderType === "stop-loss"
          ? "Stop-loss"
          : "Stop";
    what = trigger
      ? `${kind} ${prepared.side} ${spentQty} ${prepared.targetSymbol} @ $${trigger}`
      : `${kind} ${prepared.side} ${spentQty} ${prepared.targetSymbol}`;
  } else if (prepared.orderType === "twap" && prepared.durationSeconds) {
    const hours = (prepared.durationSeconds / 3600).toFixed(1).replace(/\.0$/, "");
    what =
      prepared.side === "buy"
        ? `TWAP buy ${spentQty} ${prepared.contraSymbol} of ${prepared.targetSymbol} over ${hours}h`
        : `TWAP sell ${spentQty} ${prepared.targetSymbol} over ${hours}h`;
  } else {
    what = swapLine;
  }

  return formatReceipt({
    title: `✅ ${what} — placed.`,
    footer: `i'll ping you when it fills · ${APP_ACTIVITY_HINT}`,
  });
}

/** Friendlier chat errors for common Flash rejections. */
export function friendlyFlashPlaceError(message: string): string {
  if (/below minimum notional/i.test(message) || /minimum.*\$0\.10/i.test(message)) {
    return "that trade's too small — need at least $0.10. try a bigger amount.";
  }
  if (/Flash rejected the order:\s*/i.test(message)) {
    const rest = message.replace(/^Flash rejected the order:\s*/i, "").trim();
    if (/below minimum notional/i.test(rest)) {
      return "that trade's too small — need at least $0.10. try a bigger amount.";
    }
  }
  return message;
}
