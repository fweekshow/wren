import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseUnits,
  type Address,
} from "viem";
import { base } from "viem/chains";

import { resolveBaseRpcUrl } from "@/chain/base-rpc.js";
import { formatSpotBuyableNames } from "@/discovery/doppler/stockCatalog.js";
import { isB20StockAddress } from "@/discovery/ai/tokens.js";
import {
  buildSlipstreamUsdcToTokenSwap,
  getSlipstreamUsdcPoolPriceUsd,
} from "@/discovery/ai/tools/swap.js";
import type { WalletCall } from "@/discovery/ai/types.js";
import {
  formatStockPlainName,
  isSpotBuyableStock,
  resolveStockNumerairePrice,
  resolveStockToken,
  type StockTokenEntry,
} from "@/discovery/doppler/stockRegistry.js";
import { ONRAMP_MIN_USD } from "@/wallet/onramp.js";
import { PhoneEscrowAdapter } from "@/wallet/phoneEscrow.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const USDC_DECIMALS = 6;
/** Buffer on share-count quotes only (price * qty). Dollar gifts charge the asked amount. */
const QUOTE_BUFFER_BPS = 150n; // 1.5%
const MAX_POOL_DRIFT_BPS = 300n; // 3%. prefer pool when Chainlink drifts further

/** Our take on every stock send (1%). Coinbase's 2.5% is separate (taken out of Apple Pay). */
export const STOCK_GIFT_FEE_BPS = 100;
/** Headless card (Apple Pay / Google Pay): Coinbase ~2.5% subtracted from paymentAmount. */
export const COINBASE_HEADLESS_CARD_BPS = 250;
export const ONRAMP_GROSS_BPS = COINBASE_HEADLESS_CARD_BPS;
/** @deprecated use STOCK_GIFT_FEE_BPS */
export const STOCK_GIFT_FEE_MIN_USD = 0;
export const STOCK_GIFT_FEE_USD = 0;
const BASEMATE_TREASURY_SAFE = "0xDF58fb99b8D1EcE29869fA55317978a719696d81" as Address;

export function roundUsd(n: number): number {
  return Math.round(n * 100) / 100;
}

export function formatUsdAmount(n: number): string {
  const rounded = roundUsd(n);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

export function resolveStockGiftTreasury(): Address {
  const override = process.env.STOCK_GIFT_FEE_TREASURY?.trim();
  if (override && isAddress(override)) return getAddress(override);
  return BASEMATE_TREASURY_SAFE;
}

/** 1% of the USDC we spend on the stock (notional or maxUsd for share quotes). */
export function ourStockGiftFeeUsd(spendUsd: number): number {
  const stockUsd = roundUsd(Math.max(0, spendUsd));
  return roundUsd((stockUsd * STOCK_GIFT_FEE_BPS) / 10_000);
}

/** USD gifts spend the asked dollars. Share gifts spend price + 1.5% buffer. */
export function giftSpendUsd(quote: {
  isUsd: boolean;
  notionalUsd: number;
  maxUsd: number;
}): number {
  return roundUsd(quote.isUsd ? quote.notionalUsd : quote.maxUsd);
}

function ceilUsd(n: number): number {
  return Math.ceil(n * 100 - 1e-9) / 100;
}

export function giftChargeUsd(
  notionalUsd: number,
  opts?: { applePay?: boolean },
): {
  stockUsd: number;
  feeUsd: number;
  ourFeeUsd: number;
  onrampFeeUsd: number;
  usdcNeeded: number;
  totalUsd: number;
} {
  const stockUsd = roundUsd(Math.max(0, notionalUsd));
  const ourFeeUsd = ourStockGiftFeeUsd(stockUsd);
  const usdcNeeded = roundUsd(stockUsd + ourFeeUsd);
  if (!opts?.applePay) {
    return {
      stockUsd,
      feeUsd: ourFeeUsd,
      ourFeeUsd,
      onrampFeeUsd: 0,
      usdcNeeded,
      totalUsd: usdcNeeded,
    };
  }
  // Coinbase subtracts ~2.5% from paymentAmount. Size the card so stock + 1% remain.
  const totalUsd = ceilUsd(usdcNeeded / (1 - ONRAMP_GROSS_BPS / 10_000));
  const onrampFeeUsd = roundUsd(totalUsd - usdcNeeded);
  return {
    stockUsd,
    feeUsd: roundUsd(ourFeeUsd + onrampFeeUsd),
    ourFeeUsd,
    onrampFeeUsd,
    usdcNeeded,
    totalUsd,
  };
}

// ── Wren pricing ─────────────────────────────────────────────────────────────
// Wren charges a flat $2.99 per send, and the first send is free. Buying for
// yourself has no Wren fee. The card cost (Coinbase's ~2.5%) is passed through
// at cost. Basemate keeps the 1% fee above; Wren sends save their fee on the
// gift intent (intent.feeUsd) so fulfilment never recomputes 1% for them.
export const WREN_SEND_FEE_USD = 2.99;

export function wrenSendFeeUsd(opts: { firstSend: boolean }): number {
  return opts.firstSend ? 0 : WREN_SEND_FEE_USD;
}

/** What a Wren send costs. Card total is never below Coinbase's $2 floor. */
export function wrenSendCharge(
  stockUsdIn: number,
  opts: { firstSend: boolean },
): { stockUsd: number; feeUsd: number; usdcNeeded: number; cardUsd: number; totalUsd: number } {
  const stockUsd = roundUsd(Math.max(0, stockUsdIn));
  const feeUsd = wrenSendFeeUsd(opts);
  const usdcNeeded = roundUsd(stockUsd + feeUsd);
  const totalUsd = Math.max(ceilUsd(usdcNeeded / (1 - ONRAMP_GROSS_BPS / 10_000)), ONRAMP_MIN_USD);
  return { stockUsd, feeUsd, usdcNeeded, cardUsd: roundUsd(totalUsd - usdcNeeded), totalUsd };
}

/** Apple Pay checkout amount, never below Coinbase's $2 guest-checkout floor. */
export function giftOnrampUsd(notionalUsd: number): number {
  return Math.max(giftChargeUsd(notionalUsd, { applePay: true }).totalUsd, ONRAMP_MIN_USD);
}

export async function readErc20Balance(token: string, wallet: string): Promise<bigint> {
  const client = createPublicClient({
    chain: base,
    transport: http(resolveBaseRpcUrl()),
  });
  return client.readContract({
    address: token as Address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [wallet as Address],
  });
}

export async function walletHasStockGiftShares(
  wallet: string,
  symbol: string,
  sharesHuman: string,
): Promise<boolean> {
  const entry = resolveStockToken(symbol);
  if (!entry) return false;
  let sharesRaw: bigint;
  try {
    sharesRaw = parseUnits(sharesHuman, entry.decimals);
  } catch {
    return false;
  }
  if (sharesRaw <= 0n) return false;
  try {
    const bal = await readErc20Balance(entry.address, wallet);
    return bal >= sharesRaw;
  } catch {
    return false;
  }
}

export type StockGiftQuote = {
  entry: StockTokenEntry;
  plainName: string;
  /** Whole shares when qty mode; estimated shares when usd mode. */
  sharesHuman: string;
  sharesRaw: bigint;
  usdcCostHuman: string;
  usdcCostRaw: bigint;
  /** Dollars of stock the user asked for (or share * price). No Apple Pay ceil. */
  notionalUsd: number;
  /** USDC spent on the stock swap (may include a small share-count buffer). */
  maxUsd: number;
  sharePriceUsd: number;
  priceSource: "chainlink" | "pool" | "blend";
  isUsd: boolean;
  amountLabel: string;
};

export type GiftDeliveryChannel = "imessage" | "text" | "email" | "whatsapp";

export type StockGiftRecipient =
  | {
      kind: "wallet";
      address: string;
      display: string;
      phone?: string | null;
      email?: string | null;
      name?: string;
      channel?: GiftDeliveryChannel;
    }
  | {
      kind: "claim_phone";
      phone: string;
      display: string;
      email?: string | null;
      name?: string;
      channel?: GiftDeliveryChannel;
      isOnBasemate?: boolean;
    };

/**
 * USDC → Coinbase B20 stock on Aerodrome Slipstream.
 * Does not apply the swap service fee and does not go through Flash.
 */
export async function buildB20UsdcSpotBuy(args: {
  toAddress: string;
  toSymbol: string;
  toDecimals: number;
  usdcHuman: string;
  walletAddress: string;
  amountUsd?: string;
  /** Qty gifts: require at least this many shares out. */
  amountOutMinimum?: bigint;
}): Promise<{ calls: WalletCall[]; label: string; amountOutMinimum: bigint } | null> {
  if (!isB20StockAddress(args.toAddress)) return null;
  const rawAmountIn = parseUnits(args.usdcHuman, USDC_DECIMALS);
  if (rawAmountIn <= 0n) return null;
  const plain = formatStockPlainName(args.toSymbol);
  const built = await buildSlipstreamUsdcToTokenSwap({
    rawAmountIn,
    toAddress: args.toAddress,
    toSymbol: args.toSymbol,
    toDecimals: args.toDecimals,
    humanAmount: args.usdcHuman,
    fromSymbol: "USDC",
    walletAddress: args.walletAddress,
    isUsd: args.amountUsd != null,
    amountUsd: args.amountUsd,
    ...(args.amountOutMinimum != null ? { amountOutMinimum: args.amountOutMinimum } : {}),
  });
  if (!built) return null;
  if (plain) {
    return {
      ...built,
      label: built.label.replace(`→ ${args.toSymbol}`, `→ ${plain}`),
    };
  }
  return built;
}

/**
 * Quote a stock gift: whole shares (`qty`) or dollar notional (`usd`).
 * Prices via Chainlink cross-checked against the Slipstream pool.
 */
export async function quoteStockGift(args: {
  symbol: string;
  qty?: string;
  usd?: string;
}): Promise<{ ok: true; quote: StockGiftQuote } | { ok: false; error: string }> {
  const entry = resolveStockToken(args.symbol);
  if (!entry) {
    return {
      ok: false,
      error: `couldn't find stock "${args.symbol}". try ${formatSpotBuyableNames()}.`,
    };
  }
  if (!isSpotBuyableStock(entry.symbol)) {
    return {
      ok: false,
      error: `$${entry.symbol} isn't buyable on Basemate yet. try ${formatSpotBuyableNames()}.`,
    };
  }

  const qtyRaw = args.qty?.trim();
  const usdRaw = args.usd?.trim();
  const hasQty = Boolean(qtyRaw && Number(qtyRaw) > 0);
  const hasUsd = Boolean(usdRaw && Number(usdRaw) > 0);
  if (hasQty === hasUsd) {
    return { ok: false, error: "say how many shares (e.g. 1 Apple) or a dollar amount (e.g. $25 of Apple)." };
  }

  let sharePriceUsd: number;
  let priceSource: StockGiftQuote["priceSource"] = "chainlink";
  try {
    const chainlink = await resolveStockNumerairePrice(entry);
    sharePriceUsd = chainlink.priceUsd;
    const pool = await getSlipstreamUsdcPoolPriceUsd(entry.address);
    if (pool && pool > 0) {
      const driftBps = BigInt(Math.round((Math.abs(pool - sharePriceUsd) / sharePriceUsd) * 10_000));
      if (driftBps > MAX_POOL_DRIFT_BPS || !chainlink.inMarketHours) {
        sharePriceUsd = pool;
        priceSource = driftBps > MAX_POOL_DRIFT_BPS ? "pool" : "blend";
      }
    }
  } catch {
    const pool = await getSlipstreamUsdcPoolPriceUsd(entry.address);
    if (!pool || !(pool > 0)) {
      return { ok: false, error: `couldn't price ${entry.symbol} right now — try again in a bit.` };
    }
    sharePriceUsd = pool;
    priceSource = "pool";
  }

  const plainName = formatStockPlainName(entry.symbol) ?? `${entry.name} stock`;
  let sharesHuman: string;
  let sharesRaw: bigint;
  let usdcBeforeBuffer: number;
  let isUsd: boolean;
  let amountLabel: string;

  if (hasQty) {
    const qty = Number(qtyRaw);
    if (!Number.isFinite(qty) || qty <= 0) {
      return { ok: false, error: "share amount must be a positive number." };
    }
    // Whole shares preferred; allow fractional for flexibility.
    sharesHuman = trimAmount(qtyRaw!);
    sharesRaw = parseUnits(sharesHuman, entry.decimals);
    usdcBeforeBuffer = qty * sharePriceUsd;
    isUsd = false;
    amountLabel = `${sharesHuman} ${plainName}`;
  } else {
    const usd = Number(usdRaw);
    if (!Number.isFinite(usd) || usd <= 0) {
      return { ok: false, error: "dollar amount must be a positive number." };
    }
    usdcBeforeBuffer = usd;
    const shares = usd / sharePriceUsd;
    sharesHuman = trimAmount(shares.toFixed(Math.min(entry.decimals, 6)));
    sharesRaw = parseUnits(sharesHuman, entry.decimals);
    isUsd = true;
    amountLabel = `$${trimAmount(usdRaw!)} of ${plainName}`;
  }

  if (sharesRaw <= 0n) {
    return { ok: false, error: "amount is too small. try a larger amount." };
  }

  const notionalUsd = usdcBeforeBuffer;
  const usdcRawBefore = parseUnits(usdcBeforeBuffer.toFixed(USDC_DECIMALS), USDC_DECIMALS);
  // Dollar gifts charge the asked amount. Share-count quotes keep a small buffer.
  const usdcCostRaw = isUsd
    ? usdcRawBefore
    : usdcRawBefore + (usdcRawBefore * QUOTE_BUFFER_BPS) / 10_000n;
  const usdcCostHuman = formatUnits(usdcCostRaw, USDC_DECIMALS);
  const maxUsd = Number(usdcCostHuman);

  return {
    ok: true,
    quote: {
      entry,
      plainName,
      sharesHuman,
      sharesRaw,
      usdcCostHuman,
      usdcCostRaw,
      notionalUsd,
      maxUsd,
      sharePriceUsd,
      priceSource,
      isUsd,
      amountLabel,
    },
  };
}

/** Don't send more shares than the swap's min-out — the batch would revert. */
export function clampGiftSharesToSwapOut(
  quote: StockGiftQuote,
  amountOutMinimum: bigint,
): StockGiftQuote {
  if (amountOutMinimum <= 0n || quote.sharesRaw <= amountOutMinimum) return quote;
  return {
    ...quote,
    sharesRaw: amountOutMinimum,
    sharesHuman: trimAmount(formatUnits(amountOutMinimum, quote.entry.decimals)),
  };
}

export async function buildStockBuyCalls(args: {
  quote: StockGiftQuote;
  walletAddress: string;
}): Promise<{ calls: WalletCall[]; label: string; amountOutMinimum: bigint } | null> {
  return buildB20UsdcSpotBuy({
    toAddress: args.quote.entry.address,
    toSymbol: args.quote.entry.symbol,
    toDecimals: args.quote.entry.decimals,
    usdcHuman: args.quote.usdcCostHuman,
    walletAddress: args.walletAddress,
    amountUsd: String(args.quote.maxUsd),
    // Qty gifts: require exactly the asked shares (or more). USD gifts keep default 5% min-out.
    ...(!args.quote.isUsd ? { amountOutMinimum: args.quote.sharesRaw } : {}),
  });
}

function stockTransferCall(quote: StockGiftQuote, recipientAddress: string, memo?: string): WalletCall {
  return {
    to: quote.entry.address as Address,
    value: "0x0",
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipientAddress as Address, quote.sharesRaw],
    }),
    metadata: {
      description: `Send ${quote.sharesHuman} ${quote.entry.symbol} to recipient`,
      transactionType: "transfer",
      ...(memo ? { memo } : {}),
      amountUsd: String(quote.notionalUsd),
    },
  };
}

function holdingsFeeLabel(spendUsd: number, feeUsd: number): string {
  if (feeUsd > 0) return `$${formatUsdAmount(spendUsd)} + $${formatUsdAmount(feeUsd)} fee`;
  return `$${formatUsdAmount(spendUsd)}`;
}

export function buildStockTransferCalls(args: {
  quote: StockGiftQuote;
  recipientAddress: string;
  memo?: string;
  feeUsd?: number;
}): { calls: WalletCall[]; label: string; estimatedShares: string } {
  const spendUsd = giftSpendUsd(args.quote);
  const feeUsd = args.feeUsd ?? 0;
  const memoLabel = args.memo ? ` - ${args.memo}` : "";
  return {
    calls: [stockTransferCall(args.quote, args.recipientAddress, args.memo), ...stockGiftFeeCalls(feeUsd)],
    label: `Send ${args.quote.amountLabel} from wallet (${holdingsFeeLabel(spendUsd, feeUsd)})${memoLabel}`,
    estimatedShares: args.quote.sharesHuman,
  };
}

export function buildStockEscrowCalls(args: {
  quote: StockGiftQuote;
  phone: string;
  contactName: string;
  memo?: string;
  feeUsd?: number;
}): {
  calls: WalletCall[];
  label: string;
  estimatedShares: string;
  escrow: ReturnType<typeof PhoneEscrowAdapter.buildDepositDraft>;
} {
  const draft = PhoneEscrowAdapter.buildDepositDraft(args.phone, args.quote.sharesHuman, {
    address: args.quote.entry.address,
    symbol: args.quote.entry.symbol,
    decimals: args.quote.entry.decimals,
  });
  const spendUsd = giftSpendUsd(args.quote);
  const feeUsd = args.feeUsd ?? 0;
  const memoLabel = args.memo ? ` - ${args.memo}` : "";
  return {
    calls: [...draft.calls, ...stockGiftFeeCalls(feeUsd)],
    label: `Send ${args.quote.amountLabel} to ${args.contactName} to claim from wallet (${holdingsFeeLabel(spendUsd, feeUsd)})${memoLabel}`,
    estimatedShares: args.quote.sharesHuman,
    escrow: draft,
  };
}

/** Buy AAPLc (etc.) then transfer to a wallet, in one call batch. */
export async function buildStockBuyAndTransferCalls(args: {
  quote: StockGiftQuote;
  walletAddress: string;
  recipientAddress: string;
  memo?: string;
  /** A fee fixed at checkout (Wren). Defaults to the 1% Basemate fee. */
  feeUsd?: number;
}): Promise<{ calls: WalletCall[]; label: string; estimatedShares: string } | null> {
  const buy = await buildStockBuyCalls({
    quote: args.quote,
    walletAddress: args.walletAddress,
  });
  if (!buy) return null;
  const quote = clampGiftSharesToSwapOut(args.quote, buy.amountOutMinimum);
  const spendUsd = giftSpendUsd(quote);
  const feeUsd = args.feeUsd ?? ourStockGiftFeeUsd(spendUsd);
  const transfer = buildStockTransferCalls({
    quote,
    recipientAddress: args.recipientAddress,
    memo: args.memo,
    feeUsd,
  });
  const memoLabel = args.memo ? ` - ${args.memo}` : "";
  return {
    calls: [...buy.calls, ...transfer.calls],
    label: `Send ${quote.amountLabel} ($${formatUsdAmount(spendUsd)} + $${formatUsdAmount(feeUsd)} fee)${memoLabel}`,
    estimatedShares: quote.sharesHuman,
  };
}

/** Buy then escrow-deposit for a phone claim recipient, in one call batch. */
export async function buildStockBuyAndEscrowCalls(args: {
  quote: StockGiftQuote;
  walletAddress: string;
  phone: string;
  contactName: string;
  memo?: string;
  /** A fee fixed at checkout (Wren). Defaults to the 1% Basemate fee. */
  feeUsd?: number;
}): Promise<{
  calls: WalletCall[];
  label: string;
  estimatedShares: string;
  escrow: ReturnType<typeof PhoneEscrowAdapter.buildDepositDraft>;
} | null> {
  const buy = await buildStockBuyCalls({
    quote: args.quote,
    walletAddress: args.walletAddress,
  });
  if (!buy) return null;
  const quote = clampGiftSharesToSwapOut(args.quote, buy.amountOutMinimum);
  const spendUsd = giftSpendUsd(quote);
  const feeUsd = args.feeUsd ?? ourStockGiftFeeUsd(spendUsd);
  const escrow = buildStockEscrowCalls({
    quote,
    phone: args.phone,
    contactName: args.contactName,
    memo: args.memo,
    feeUsd,
  });
  const memoLabel = args.memo ? ` - ${args.memo}` : "";
  return {
    calls: [...buy.calls, ...escrow.calls],
    label:
      `Send ${quote.amountLabel} to ${args.contactName} to claim` +
      ` ($${formatUsdAmount(spendUsd)} + $${formatUsdAmount(feeUsd)} fee)${memoLabel}`,
    estimatedShares: quote.sharesHuman,
    escrow: escrow.escrow,
  };
}

function stockGiftFeeCalls(feeUsd: number): WalletCall[] {
  if (feeUsd <= 0) return [];
  const feeRaw = parseUnits(feeUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS);
  const treasury = resolveStockGiftTreasury();
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [treasury, feeRaw],
  });
  return [
    {
      to: USDC,
      value: "0x0",
      data,
      metadata: {
        description: `$${formatUsdAmount(feeUsd)} stock send fee`,
        transactionType: "transfer",
        amountUsd: String(feeUsd),
      },
    },
  ];
}

function trimAmount(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw.trim();
  if (Number.isInteger(n)) return String(n);
  return raw.trim().replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}
