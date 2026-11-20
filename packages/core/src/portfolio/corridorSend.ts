/**
 * Build batched swap-then-send calls for corridor phone remittance.
 *
 * Exact-in USDC → local stable, then transfer or phone-escrow the minOut amount.
 * Callers fall back to plain USDC when this returns `{ fallback: "USDC" }`.
 */
import { encodeFunctionData, formatUnits, parseUnits, type Address } from "viem";
import type { WalletCall } from "@basemate/shared";

import { BASE_TOKENS } from "@/discovery/ai/tokens.js";
import { getBestSwapQuote } from "@/discovery/ai/tools/swap.js";
import type { VerifiedStable } from "@/portfolio/verifiedStables.js";
import { PhoneEscrowAdapter } from "@/wallet/phoneEscrow.js";

/** Slippage floor applied to quoted out before transfer/escrow (matches ~1% venue mins). */
export const CORRIDOR_SEND_SLIPPAGE_BPS = 100n; // 1%
const BPS_DENOM = 10_000n;

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export type CorridorSendSuccess = {
  fallback?: undefined;
  calls: WalletCall[];
  /** Human-readable local amount actually sent (minOut). */
  localAmount: string;
  localAmountAtomic: bigint;
  /** Expected out before slippage haircut (for "~X" confirm copy). */
  quotedLocalAmount: string;
  localStable: VerifiedStable;
  usdcAmount: string;
  label: string;
  dex: "uniswap" | "aerodrome";
};

export type CorridorSendFallback = {
  fallback: "USDC";
  reason: string;
};

export type CorridorSendResult = CorridorSendSuccess | CorridorSendFallback;

export type BuildCorridorSendCallsArgs = {
  usdcAmount: string;
  localStable: VerifiedStable;
  senderAddress: string;
} & (
  | { mode: "transfer"; recipientAddress: string; phone?: string }
  | { mode: "escrow"; phone: string; recipientAddress?: string }
);

function applyMinOut(rawAmountOut: bigint): bigint {
  if (rawAmountOut <= 0n) return 0n;
  const minOut = (rawAmountOut * (BPS_DENOM - CORRIDOR_SEND_SLIPPAGE_BPS)) / BPS_DENOM;
  return minOut > 0n ? minOut : 0n;
}

function formatLocalAmount(atomic: bigint, decimals: number): string {
  const formatted = formatUnits(atomic, decimals);
  // Trim trailing zeros for clean chat copy while keeping enough precision.
  if (!formatted.includes(".")) return formatted;
  return formatted.replace(/\.?0+$/, "") || "0";
}

/**
 * Quote USDC→local and build swap + transfer/escrow calls.
 * Returns `{ fallback: "USDC" }` when the stable lacks an address or no route exists.
 */
export async function buildCorridorSendCalls(
  args: BuildCorridorSendCallsArgs,
): Promise<CorridorSendResult> {
  const { usdcAmount, localStable, senderAddress } = args;
  if (!localStable.address) {
    return { fallback: "USDC", reason: `${localStable.symbol} has no Base address` };
  }

  const usdc = BASE_TOKENS.USDC;
  const label = `Swap ${usdcAmount} USDC → ${localStable.symbol}`;

  let rawAmountIn: bigint;
  try {
    rawAmountIn = parseUnits(usdcAmount, usdc.decimals);
  } catch {
    return { fallback: "USDC", reason: "invalid USDC amount" };
  }
  if (rawAmountIn <= 0n) {
    return { fallback: "USDC", reason: "USDC amount must be greater than 0" };
  }

  let quote: Awaited<ReturnType<typeof getBestSwapQuote>>;
  try {
    quote = await getBestSwapQuote({
      fromAddress: usdc.address,
      fromIsEth: false,
      fromDecimals: usdc.decimals,
      fromSymbol: "USDC",
      toAddress: localStable.address,
      toSymbol: localStable.symbol,
      toDecimals: localStable.decimals,
      rawAmountIn,
      humanAmount: usdcAmount,
      walletAddress: senderAddress,
      label,
    });
  } catch (err) {
    console.warn(`⚠️ [corridor] quote failed for ${localStable.symbol}:`, err);
    return { fallback: "USDC", reason: `quote error for ${localStable.symbol}` };
  }

  if (!quote || quote.rawAmountOut <= 0n) {
    return { fallback: "USDC", reason: `no route USDC→${localStable.symbol}` };
  }

  const minOutAtomic = applyMinOut(quote.rawAmountOut);
  if (minOutAtomic <= 0n) {
    return { fallback: "USDC", reason: `amount too small after slippage for ${localStable.symbol}` };
  }

  const localAmount = formatLocalAmount(minOutAtomic, localStable.decimals);
  const quotedLocalAmount = formatLocalAmount(quote.rawAmountOut, localStable.decimals);

  if (args.mode === "transfer") {
    const transferData = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [args.recipientAddress as Address, minOutAtomic],
    });
    const sendLabel =
      `Convert ${usdcAmount} USDC → ~${quotedLocalAmount} ${localStable.symbol} and send`;
    const calls: WalletCall[] = [
      ...quote.calls,
      {
        to: localStable.address as Address,
        value: "0x0",
        data: transferData,
        metadata: {
          description: `Send ${localAmount} ${localStable.symbol}`,
          transactionType: "transfer",
        },
      },
    ];
    return {
      calls,
      localAmount,
      localAmountAtomic: minOutAtomic,
      quotedLocalAmount,
      localStable,
      usdcAmount,
      label: sendLabel,
      dex: quote.dex,
    };
  }

  // Escrow mode: swap into sender, then approve + deposit minOut.
  try {
    const draft = PhoneEscrowAdapter.buildDepositDraft(args.phone, localAmount, {
      address: localStable.address,
      symbol: localStable.symbol,
      decimals: localStable.decimals,
    });
    const sendLabel =
      `Convert ${usdcAmount} USDC → ~${quotedLocalAmount} ${localStable.symbol} for claim`;
    return {
      calls: [...quote.calls, ...draft.calls],
      localAmount: draft.amount,
      localAmountAtomic: draft.amountAtomic,
      quotedLocalAmount,
      localStable,
      usdcAmount,
      label: sendLabel,
      dex: quote.dex,
    };
  } catch (err) {
    console.warn(`⚠️ [corridor] escrow draft failed for ${localStable.symbol}:`, err);
    return { fallback: "USDC", reason: `escrow draft failed for ${localStable.symbol}` };
  }
}
