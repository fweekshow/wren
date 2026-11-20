import { config } from "@/config/config.js";
import { resolveTokenAsync } from "@/discovery/ai/tokens.js";

import { flashQuote, FlashApiError } from "./client.js";
import type {
  FlashOrderSide,
  FlashOrderType,
  FlashPreparedOrder,
  FlashPriceTrigger,
  FlashQuoteResponse,
} from "./types.js";

const NATIVE_ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const WETH = "0x4200000000000000000000000000000000000006";

export class FlashPrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlashPrepareError";
  }
}

export type PrepareFlashOrderArgs = {
  funderAddress: string;
  /** Traded asset (target) — symbol or address. */
  targetAsset: string;
  /** Counter asset (contra) — symbol or address. Spent on buys. */
  contraAsset: string;
  side: FlashOrderSide;
  qty: string;
  orderType: FlashOrderType;
  limitNotionalPrice?: string;
  durationSeconds?: number;
  twapBucketCount?: number;
  triggers?: FlashPriceTrigger[];
  maxSlippage?: string;
  expireTime?: string;
};

async function resolveFlashAsset(input: string): Promise<{ address: string; symbol: string }> {
  const trimmed = input.trim();
  if (!trimmed) throw new FlashPrepareError("Missing asset.");

  // v1: spend/receive native ETH as WETH for advanced orders (no wrap.evmTx path yet).
  if (
    trimmed.toLowerCase() === "eth" ||
    trimmed.toLowerCase() === NATIVE_ETH.toLowerCase()
  ) {
    return { address: WETH, symbol: "WETH" };
  }

  const token = await resolveTokenAsync(trimmed);
  if (!token?.address) {
    throw new FlashPrepareError(`I don't recognize that token: ${trimmed}`);
  }
  const address = token.address.toLowerCase() === NATIVE_ETH ? WETH : token.address;
  const symbol =
    token.address.toLowerCase() === NATIVE_ETH || trimmed.toLowerCase() === "eth"
      ? "WETH"
      : token.symbol;
  return { address, symbol };
}

export function formatFlashOrderPreview(prepared: FlashPreparedOrder): string {
  const spent =
    prepared.side === "buy"
      ? `${prepared.qty} ${prepared.contraSymbol}`
      : `${prepared.qty} ${prepared.targetSymbol}`;

  let headline: string;
  if (prepared.orderType === "limit" && prepared.limitNotionalPrice) {
    headline = `Limit ${prepared.side} ${spent} of ${prepared.targetSymbol} @ $${prepared.limitNotionalPrice}`;
  } else if (prepared.triggers?.length) {
    const kind =
      prepared.orderType === "take-profit"
        ? "Take-profit"
        : prepared.orderType === "stop-loss"
          ? "Stop-loss"
          : "Stop";
    headline = `${kind} ${prepared.side} ${spent} of ${prepared.targetSymbol} @ $${prepared.triggers[0]!.notionalPrice}`;
  } else if (prepared.orderType === "twap" && prepared.durationSeconds) {
    const hours = (prepared.durationSeconds / 3600).toFixed(1).replace(/\.0$/, "");
    headline =
      prepared.side === "buy"
        ? `TWAP buy ${spent} of ${prepared.targetSymbol} over ${hours}h`
        : `TWAP sell ${spent} over ${hours}h`;
  } else if (prepared.side === "buy") {
    headline = `Buy ${spent} of ${prepared.targetSymbol}`;
  } else {
    headline = `Sell ${spent}`;
  }

  const approveNote = prepared.approveTx
    ? "\n(first time for this token — I'll approve, then place the order)"
    : "";

  return `${headline}${approveNote}`;
}

export function amountUsdFromPrepared(prepared: FlashPreparedOrder): number | null {
  const n = Number(prepared.fromNotional);
  return Number.isFinite(n) ? n : null;
}

/**
 * Quote a Flash order and build a confirmable snapshot.
 * Follows Definitive's EVM flow: respond to approveTx and/or permitTypedData
 * instead of assuming a single allowance path.
 */
export async function prepareFlashOrder(
  args: PrepareFlashOrderArgs,
): Promise<FlashPreparedOrder> {
  if (!config.flash.enabled) {
    throw new FlashPrepareError("Flash trading isn't configured yet.");
  }

  const qty = args.qty.trim();
  if (!qty || Number(qty) <= 0) {
    throw new FlashPrepareError("Enter a positive amount to trade.");
  }

  if (args.orderType === "limit" && !args.limitNotionalPrice?.trim()) {
    throw new FlashPrepareError("Limit orders need a USD limit price.");
  }
  if (
    (args.orderType === "stop" ||
      args.orderType === "stop-loss" ||
      args.orderType === "take-profit") &&
    (!args.triggers || args.triggers.length < 1)
  ) {
    throw new FlashPrepareError("Trigger orders need a USD trigger price.");
  }
  if (args.orderType === "twap" && (!args.durationSeconds || args.durationSeconds < 300)) {
    throw new FlashPrepareError("TWAP needs a duration of at least 5 minutes.");
  }

  const [target, contra] = await Promise.all([
    resolveFlashAsset(args.targetAsset),
    resolveFlashAsset(args.contraAsset),
  ]);

  const feeBps = config.flash.integratorFeeBps.trim() || undefined;

  let quote: FlashQuoteResponse;
  try {
    quote = await flashQuote({
      targetChain: "base",
      contraChain: "base",
      targetAsset: target.address,
      contraAsset: contra.address,
      side: args.side,
      qty,
      orderType: args.orderType,
      funderAddress: args.funderAddress,
      maxSlippage: args.maxSlippage ?? "0.05",
      limitNotionalPrice: args.limitNotionalPrice,
      durationSeconds: args.durationSeconds,
      twapBucketCount: args.twapBucketCount,
      triggers: args.triggers,
      expireTime: args.expireTime,
      flashIntegratorFeeBps: feeBps,
    });
  } catch (err) {
    if (err instanceof FlashApiError) {
      throw new FlashPrepareError(`Couldn't quote that order: ${err.message}`);
    }
    throw err;
  }

  if (!quote.evm?.orderTypedData) {
    throw new FlashPrepareError(
      "Flash didn't return a signing payload — make sure the wallet address is set on the quote.",
    );
  }
  if (quote.wrap?.evmTx) {
    throw new FlashPrepareError(
      "Native ETH wrap isn't supported for advanced orders yet — use WETH.",
    );
  }

  return {
    quoteId: quote.quoteId,
    orderType: quote.orderType,
    side: quote.side,
    targetAsset: quote.targetAsset,
    contraAsset: quote.contraAsset,
    targetSymbol: target.symbol,
    contraSymbol: contra.symbol,
    qty,
    funderAddress: args.funderAddress,
    orderTypedData: quote.evm.orderTypedData,
    approveTx: quote.evm.approveTx,
    permitTypedData: quote.evm.permitTypedData ?? null,
    estimatedFeeNotional: quote.fees.estimatedFeeNotional,
    fromNotional: quote.from.notional,
    toNotional: quote.to.notional,
    fromAmount: quote.from.amount,
    toAmount: quote.to.amount,
    limitNotionalPrice: args.limitNotionalPrice,
    durationSeconds: args.durationSeconds,
    triggers: args.triggers,
    flashIntegratorFeeBps: feeBps,
    maxSlippage: args.maxSlippage ?? "0.05",
  };
}
