/**
 * USD amount parsing, swap limits, and hex-encoding helpers for the DiscoveryAI.
 * Extracted from discovery/ai.ts; re-exported from that module for callers.
 */

import { toHex } from "viem";

import { sanitizeAmount } from "@basemate/shared";

import { fetchTokenPriceUsd, isStablecoinAddress } from "@/discovery/ai/tokens.js";

export const WETH_BASE_ADDRESS = "0x4200000000000000000000000000000000000006";
export const MAX_SWAP_USD = parseFloat(process.env.MAX_SWAP_USD ?? "10000");

/**
 * Normalise an API-returned value string to a `0x`-prefixed hex string.
 * External APIs (Uniswap Trade API, KyberSwap) may return decimal strings like
 * "0" or "500000000000000000" instead of "0x0" / "0x6F05B59D3B20000". Passing
 * a decimal string as `value` in a wallet_sendCalls payload causes Base App to
 * reject the transaction as malformed.
 */
export function normalizeHexValue(v: string | undefined | null): `0x${string}` {
  if (!v || v === "0" || v === "0x0" || v === "0x00") return "0x0";
  if (v.startsWith("0x")) return v as `0x${string}`;
  try {
    return toHex(BigInt(v));
  } catch {
    return "0x0";
  }
}

/** USD notional for protocol_volume_log — works for $ amounts and token amounts. */
export async function resolveProtocolVolumeUsdc(args: {
  usdAmount: string;
  isUsd?: boolean;
  tokenAmount: string;
  symbol: string;
  tokenAddress: string;
}): Promise<number | null> {
  if (args.isUsd) {
    const usd = parseFloat(args.usdAmount);
    return Number.isFinite(usd) && usd > 0 ? usd : null;
  }
  const qty = parseFloat(args.tokenAmount);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  if (args.tokenAddress === "ETH") {
    const ethPrice = await fetchTokenPriceUsd(WETH_BASE_ADDRESS);
    return ethPrice ? qty * ethPrice : null;
  }
  if (isStablecoinAddress(args.tokenAddress)) return qty;
  const priceUsd = await fetchTokenPriceUsd(args.tokenAddress);
  return priceUsd ? qty * priceUsd : null;
}

/** @deprecated use resolveProtocolVolumeUsdc */
export const resolveYieldProtocolVolumeUsdc = resolveProtocolVolumeUsdc;

/** Perp notional = margin × leverage (position size). */
export function perpNotionalUsdc(collateral: string | number, leverage: number): number {
  const margin =
    typeof collateral === "string" ? parseFloat(collateral) : collateral;
  const lev = Number.isFinite(leverage) && leverage > 0 ? leverage : 1;
  if (!Number.isFinite(margin) || margin <= 0) return 0;
  return margin * lev;
}

function extractUsdAmountsFromMessage(message: string): string[] {
  return Array.from(message.matchAll(/\$\s*(\d[\d,]*(?:\.\d+)?|\.\d+)/g))
    .map((m) => (m[1] ? sanitizeAmount(m[1].replace(/,/g, "")) : null))
    .filter((amount): amount is string => Boolean(amount));
}

/** Pull the first $ amount from the user's message (e.g. "buy $1 bnkr" → "1"). */
export function extractUsdAmountFromMessage(message: string): string | null {
  return extractUsdAmountsFromMessage(message)[0] ?? null;
}

function pickUsdAmountForModelAmount(message: string, modelAmount: string): string | null {
  const amounts = extractUsdAmountsFromMessage(message);
  if (amounts.length === 0) return null;
  if (amounts.length === 1) return amounts[0] ?? null;

  const model = parseFloat(modelAmount);
  if (Number.isFinite(model)) {
    const matching = amounts.find((amount) => parseFloat(amount) === model);
    if (matching) return matching;
  }

  return amounts[0] ?? null;
}

/**
 * When the model mis-reads "$1" as "1000000000", prefer the dollar figure the
 * user typed if the model amount diverges by 10× or more.
 */
export function coerceUsdAmountFromUserMessage(
  modelAmount: string,
  userMessage?: string,
): string {
  if (!userMessage) return modelAmount;
  const fromMsg = pickUsdAmountForModelAmount(userMessage, modelAmount);
  if (!fromMsg) return modelAmount;
  const model = parseFloat(modelAmount);
  const msg = parseFloat(fromMsg);
  if (!Number.isFinite(model) || !Number.isFinite(msg) || msg <= 0) return modelAmount;
  const ratio = model > msg ? model / msg : msg / model;
  if (ratio >= 10) {
    console.warn(
      `⚠️ Swap amount corrected from model ${modelAmount} → user message $${fromMsg}`,
    );
    return fromMsg;
  }
  return modelAmount;
}

/** User named ETH/WETH as the asset being spent (not a bare "$X of TOKEN" buy). */
export function userNamedEthSpend(message: string): boolean {
  return (
    /\b(?:swap|sell|convert)\s+\$?\s*[\d.]+\s*(?:usd|usdc|dollars?)?\s*(?:of|worth\s+of|in)?\s*(?:eth|weth)\b/i.test(
      message,
    ) || /\b(?:swap|sell)\s+\$?\s*[\d.]+\s*(?:eth|weth)\b/i.test(message)
  );
}

/** "buy/get $X of TOKEN" spending USDC — not "swap $X eth for …". */
export function isBareUsdBuyMessage(message: string): boolean {
  return /\b(?:buy|get)\b/i.test(message) && !userNamedEthSpend(message);
}

/**
 * Trust the $ figure the user typed over model/tool amounts. Fixes LLM passing
 * raw USDC base units (5000000) or omitting isUsd on "buy $5 of …".
 */
export function resolveUsdQuotedSwapAmount(args: {
  modelAmount: string;
  userMessage?: string;
  fromStablecoin: boolean;
  isUsd?: boolean;
}): { amount: string; isUsd: boolean } {
  const msgUsd = args.userMessage
    ? pickUsdAmountForModelAmount(args.userMessage, args.modelAmount)
    : null;
  let amount = args.modelAmount;
  let isUsd = args.isUsd ?? false;

  if (msgUsd) {
    const coerced = coerceUsdAmountFromUserMessage(amount, args.userMessage);
    const bareUsdBuy =
      args.fromStablecoin && isBareUsdBuyMessage(args.userMessage ?? "");
    if (bareUsdBuy || isUsd || coerced !== amount) {
      amount = msgUsd;
      isUsd = bareUsdBuy || isUsd || coerced !== amount;
    }
  } else if (isUsd) {
    amount = coerceUsdAmountFromUserMessage(amount, args.userMessage);
  }

  return { amount, isUsd };
}

export function assertSwapUsdWithinLimit(usdAmount: string): string | null {
  const n = parseFloat(usdAmount);
  if (!Number.isFinite(n) || n <= 0) return "What amount should I swap?";
  if (n > MAX_SWAP_USD) {
    return `that's over $${MAX_SWAP_USD.toLocaleString()} — try a smaller amount or split it up.`;
  }
  return null;
}

export async function usdToTokenAmount(
  usdAmount: string,
  from: { address: string; decimals: number; symbol: string },
): Promise<{ amount: string } | { error: string }> {
  if (isStablecoinAddress(from.address)) {
    return { amount: usdAmount };
  }
  const priceLookupAddr = from.address === "ETH" ? WETH_BASE_ADDRESS : from.address;
  const priceUsd = await fetchTokenPriceUsd(priceLookupAddr);
  if (!priceUsd) {
    return {
      error: `can't price ${from.symbol} right now — try specifying the token amount directly (e.g. "swap 5 ${from.symbol} for ...").`,
    };
  }
  const tokenAmt = parseFloat(usdAmount) / priceUsd;
  return { amount: tokenAmt.toFixed(Math.min(from.decimals, 8)) };
}
