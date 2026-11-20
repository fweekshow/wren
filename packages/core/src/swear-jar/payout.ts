import type { Address } from "viem";
import { encodeFunctionData, isAddress, parseUnits } from "viem";

import { ERC20_ABI } from "@/discovery/ai/tools/swap.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { TxConfirmationAdapter } from "@/discovery/adapters/txConfirmation.adapter.js";
import { invalidatePortfolioSnapshot } from "@/portfolio/snapshot.js";
import { BASE_USDC_ADDRESS, getUsdcBalance } from "@/wallet/cdp.js";
import { EmbeddedWalletAdapter, EmbeddedWalletError } from "@/wallet/embeddedWallet.js";
import { logger } from "@/utils/logger.js";

import { BASE_CHAIN_ID, SWEAR_FINE_USD } from "./constants.js";
import { sendFromGroupPot } from "./pot.js";
import {
  claimFineForPay,
  claimFineForRefund,
  markFinePaid,
  markFinePending,
  markFineRefunded,
  restoreFinePaid,
  type SwearJarFineRow,
  type SwearJarRow,
} from "./store.js";

function usdcTransferCall(to: string, amountUsd: number) {
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to as Address, parseUnits(String(amountUsd), 6)],
  });
  return {
    to: BASE_USDC_ADDRESS as Address,
    value: "0x0" as const,
    data,
  };
}

export function isDelegationLive(expiresAt: Date | null | undefined): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() > Date.now() + 60_000;
}

export type CollectFineResult =
  | { ok: true; txHash: string }
  | { ok: false; reason: "no_wallet" | "no_delegation" | "broke" | "opted_out" | "error" | "busy" };

/** Auto-take $1 USDC from swearer's embedded wallet into this group's pot. */
export async function collectFine(args: {
  fine: SwearJarFineRow;
  potAddress: string;
  optIn: boolean;
}): Promise<CollectFineResult> {
  if (!args.optIn) return { ok: false, reason: "opted_out" };
  if (!isAddress(args.potAddress)) return { ok: false, reason: "error" };

  const claimed = await claimFineForPay(args.fine.id);
  if (!claimed) return { ok: false, reason: "busy" };

  const embedded = await WalletAdapter.getEmbeddedWallet(args.fine.swearerSenderId);
  if (!embedded?.cdpUserId || !embedded.address) {
    await markFinePending(args.fine.id);
    return { ok: false, reason: "no_wallet" };
  }
  if (!isDelegationLive(embedded.delegationExpiresAt)) {
    await markFinePending(args.fine.id);
    return { ok: false, reason: "no_delegation" };
  }

  try {
    const bal = await getUsdcBalance(embedded.address);
    if (Number(bal) < SWEAR_FINE_USD) {
      await markFinePending(args.fine.id);
      return { ok: false, reason: "broke" };
    }

    const result = await EmbeddedWalletAdapter.sendCalls({
      userId: embedded.cdpUserId,
      address: embedded.address,
      calls: [usdcTransferCall(args.potAddress, SWEAR_FINE_USD)],
    });
    await markFinePaid(args.fine.id, result.txHash);

    try {
      await TxConfirmationAdapter.recordConfirmedActivity({
        senderId: args.fine.swearerSenderId,
        fromAddress: embedded.address,
        chainId: BASE_CHAIN_ID,
        label: "Alexander swear jar — $1 USDC",
        txHash: result.txHash,
        transferAmount: String(SWEAR_FINE_USD),
        transferAsset: "USDC",
        transferMemo: "tribute",
      });
    } catch (err) {
      logger.warn({ err, txHash: result.txHash }, "[swear-jar] activity record failed");
    }
    try {
      await invalidatePortfolioSnapshot(args.fine.swearerSenderId);
    } catch (err) {
      logger.warn({ err }, "[swear-jar] portfolio invalidate failed");
    }

    return { ok: true, txHash: result.txHash };
  } catch (err) {
    await markFinePending(args.fine.id);
    if (err instanceof EmbeddedWalletError && err.needsReauth) {
      return { ok: false, reason: "no_delegation" };
    }
    logger.warn({ err, fineId: args.fine.id }, "[swear-jar] collectFine failed");
    return { ok: false, reason: "error" };
  }
}

export type RefundResult =
  | { ok: true; txHash: string }
  | { ok: false; reason: "none" | "error" };

/** Refund the swearer's most recent paid fine from this group's pot (paymaster). */
export async function refundLatestFine(args: {
  jar: SwearJarRow;
  swearerSenderId: string;
  getLatestPaid: () => Promise<SwearJarFineRow | null>;
}): Promise<RefundResult> {
  const fine = await args.getLatestPaid();
  if (!fine) return { ok: false, reason: "none" };

  const claimed = await claimFineForRefund(fine.id);
  if (!claimed) return { ok: false, reason: "none" };

  const embedded = await WalletAdapter.getEmbeddedWallet(args.swearerSenderId);
  if (!embedded?.address || !isAddress(embedded.address)) {
    await restoreFinePaid(fine.id);
    return { ok: false, reason: "error" };
  }

  try {
    const result = await sendFromGroupPot({
      conversationId: args.jar.conversationId,
      calls: [usdcTransferCall(embedded.address, SWEAR_FINE_USD)],
    });
    await markFineRefunded(fine.id, result.txHash);
    return { ok: true, txHash: result.txHash };
  } catch (err) {
    await restoreFinePaid(fine.id);
    logger.warn({ err, fineId: fine.id }, "[swear-jar] refund failed");
    return { ok: false, reason: "error" };
  }
}

export type SettlePayoutResult =
  | { ok: true; txHash: string }
  | { ok: false; reason: "no_dest" | "error"; amountUsd: number };

/** Pay this group's pot (paid fine count × $1) to the winner (paymaster). */
export async function settleToWinner(args: {
  jar: SwearJarRow;
  winnerSenderId: string;
  amountUsd: number;
}): Promise<SettlePayoutResult> {
  if (args.amountUsd <= 0) return { ok: false, reason: "error", amountUsd: 0 };

  const embedded = await WalletAdapter.getEmbeddedWallet(args.winnerSenderId);
  if (!embedded?.address || !isAddress(embedded.address)) {
    return { ok: false, reason: "no_dest", amountUsd: args.amountUsd };
  }

  try {
    const result = await sendFromGroupPot({
      conversationId: args.jar.conversationId,
      calls: [usdcTransferCall(embedded.address, args.amountUsd)],
    });
    return { ok: true, txHash: result.txHash };
  } catch (err) {
    logger.warn({ err, winner: args.winnerSenderId }, "[swear-jar] settle payout failed");
    return { ok: false, reason: "error", amountUsd: args.amountUsd };
  }
}
