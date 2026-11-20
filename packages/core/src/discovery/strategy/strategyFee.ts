import type { WalletCall } from "@basemate/shared";
import { encodeFunctionData, formatUnits, isAddress, parseUnits, type Address } from "viem";

import { StrategyAdapter } from "@/discovery/adapters/strategy.adapter.js";
import { getBalances, sendStrategyCalls } from "@/wallet/cdp.js";
import { logger } from "@/utils/logger.js";

/** Performance fee on realized profit above the high-water mark: 10% (1000 bps). */
export const STRATEGY_PROFIT_FEE_BPS = 1000n;

const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;
const BPS_DENOMINATOR = 10_000n;

const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

export interface ProfitFeeComputation {
  /** New all-time-high realized PnL (max of previous HWM and current realized PnL). */
  newHwm: number;
  /** Realized profit above the previous high-water mark (>= 0). */
  incrementalProfit: number;
  /** Fee owed on the increment, in USD. */
  feeUsd: number;
}

/**
 * High-water-mark profit fee on cumulative realized PnL. Only the increment
 * above the previous HWM is charged, so repeated calls (polls / backfills) and
 * drawdown-recovery never double-charge.
 */
export function computeProfitFee(previousHwm: number, currentRealizedPnl: number): ProfitFeeComputation {
  const newHwm = Math.max(previousHwm, currentRealizedPnl);
  const incrementalProfit = Math.max(0, newHwm - previousHwm);
  const feeUsd = (incrementalProfit * Number(STRATEGY_PROFIT_FEE_BPS)) / Number(BPS_DENOMINATOR);
  return { newHwm, incrementalProfit, feeUsd };
}

/**
 * Paper parity for the creator performance fee. Call IMMEDIATELY after
 * `recomputeRealizedPnl` (which resets realized_pnl_usd to the gross trade sum):
 * advances the HWM and rewrites realized_pnl_usd net of the cumulative 10% fee
 * on profit above the high-water mark — no on-chain transfer. Cumulative fee on
 * an HWM ladder equals 10% of the all-time-high realized PnL, so this is
 * idempotent and fee-free during drawdown recovery, matching live.
 */
export async function applyPaperProfitFee(strategyId: string): Promise<void> {
  const strategy = await StrategyAdapter.getById(strategyId);
  if (!strategy) return;

  const grossRealized = strategy.realized_pnl_usd;
  const previousHwm = await StrategyAdapter.getHighWaterMark(strategyId);
  const newHwm = Math.max(previousHwm, grossRealized);
  if (newHwm <= 0) return; // never been in profit → no fee

  if (newHwm > previousHwm) {
    await StrategyAdapter.setHighWaterMark(strategyId, newHwm);
  }
  const cumulativeFee = (newHwm * Number(STRATEGY_PROFIT_FEE_BPS)) / Number(BPS_DENOMINATOR);
  await StrategyAdapter.setRealizedPnl(strategyId, grossRealized - cumulativeFee);
}

function resolveVibeTradingFeeWallet(): Address | null {
  const wallet = (process.env.VIBE_TRADING_FEE_WALLET ?? "").trim();
  return isAddress(wallet) ? wallet : null;
}

function buildUsdcTransferCall(feeRaw: bigint, feeWallet: Address): WalletCall {
  const feeUsdc = formatUnits(feeRaw, USDC_DECIMALS);
  return {
    to: BASE_USDC_ADDRESS as Address,
    value: "0x0",
    data: encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [feeWallet, feeRaw],
    }),
    metadata: {
      description: `Pay ${feeUsdc} USDC Basemate strategy profit fee`,
      transactionType: "transfer",
    },
  };
}

export interface SettleProfitFeeResult {
  status: "settled" | "skipped" | "failed";
  feeUsd?: number;
  txHash?: string;
  reason?: string;
}

/**
 * Settle the creator-side performance fee for a strategy when its cumulative
 * realized PnL advances past the stored high-water mark. Transfers 10% of the
 * new profit increment from the strategy's cp- execution wallet to the
 * VIBE_TRADING_FEE_WALLET. The HWM only advances after a successful transfer,
 * so an under-funded wallet simply retries on the next sync tick.
 */
export async function settleCreatorStrategyProfitFee(strategyId: string): Promise<SettleProfitFeeResult> {
  const strategy = await StrategyAdapter.getById(strategyId);
  if (!strategy) return { status: "skipped", reason: "strategy not found" };
  if (!strategy.execution_wallet_name) {
    return { status: "skipped", reason: "no execution wallet" };
  }

  // Fee finality: charge only on reconciled realized PnL. `realized_pnl_usd` can
  // include interim/estimated closes (from `closeTrade` before the USDC backfill
  // reconciles them), which could advance the HWM on a number that later moves.
  // Basing the fee on reconciled trades only means the HWM never advances on an
  // unreconciled or misattributed close.
  const reconciledRealizedPnl = await StrategyAdapter.getReconciledRealizedPnlUsd(strategyId);
  const previousHwm = await StrategyAdapter.getHighWaterMark(strategyId);
  const { newHwm, incrementalProfit, feeUsd } = computeProfitFee(
    previousHwm,
    reconciledRealizedPnl,
  );
  if (incrementalProfit <= 0 || feeUsd <= 0) return { status: "skipped", reason: "no new profit" };

  const feeWallet = resolveVibeTradingFeeWallet();
  if (!feeWallet) {
    logger.warn(
      `strategy profit fee skipped ${strategyId.slice(0, 8)}: VIBE_TRADING_FEE_WALLET not configured`,
    );
    return { status: "skipped", reason: "fee wallet not configured" };
  }

  const feeRaw = parseUnits(feeUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS);
  if (feeRaw <= 0n) return { status: "skipped", reason: "fee below USDC precision" };

  // Don't attempt a transfer the wallet can't cover — retry next tick instead.
  if (strategy.execution_wallet_address) {
    try {
      const balances = await getBalances(strategy.execution_wallet_address);
      const usdc = balances.find(
        (b) => b.contractAddress.toLowerCase() === BASE_USDC_ADDRESS.toLowerCase(),
      );
      if ((usdc?.amount ?? 0n) < feeRaw) {
        logger.warn(
          `strategy profit fee deferred ${strategyId.slice(0, 8)}: wallet USDC ${formatUnits(usdc?.amount ?? 0n, USDC_DECIMALS)} < fee ${feeUsd.toFixed(2)}`,
        );
        return { status: "skipped", reason: "insufficient USDC" };
      }
    } catch {
      // Balance check is best-effort; fall through and let sendStrategyCalls surface failures.
    }
  }

  // Advance the HWM BEFORE the transfer. This is the idempotency guard:
  // if the transfer succeeds but the HWM update were after it (old order),
  // a crash or silent DB failure between the two would cause the same increment
  // to be charged again on the next tick, draining the wallet.
  // Advancing first means a failed transfer loses the fee for that increment —
  // acceptable. A failed HWM write still throws and we abort before transferring.
  await StrategyAdapter.setHighWaterMark(strategyId, newHwm);

  try {
    const { hashes } = await sendStrategyCalls({
      accountName: strategy.execution_wallet_name,
      calls: [buildUsdcTransferCall(feeRaw, feeWallet)],
    });
    const txHash = hashes[hashes.length - 1] ?? hashes[0] ?? null;

    await StrategyAdapter.recordFeeSettlement({
      strategyId,
      feeUsd,
      profitIncrementUsd: incrementalProfit,
      hwmAfter: newHwm,
      txHash,
    });

    logger.info(
      `strategy profit fee ${strategyId.slice(0, 8)}: $${feeUsd.toFixed(2)} on +$${incrementalProfit.toFixed(2)} (hwm $${newHwm.toFixed(2)}) tx=${txHash ?? "n/a"}`,
    );
    return { status: "settled", feeUsd, txHash: txHash ?? undefined };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`strategy profit fee failed ${strategyId.slice(0, 8)}: ${reason} (retry next tick)`);
    return { status: "failed", reason };
  }
}
