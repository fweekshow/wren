// Buy for yourself: spend cash (USDC) already in your Wren account on a
// stock, into the same account. No Wren fee. If cash doesn't cover it, the
// app sends the person to Add cash for the difference.

import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import {
  buildStockBuyCalls,
  quoteStockGift,
  readErc20Balance,
} from "@/discovery/stocks/giftStock.service.js";
import { EmbeddedWalletAdapter } from "@/wallet/embeddedWallet.js";
import { logger } from "@/utils/logger.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export class WrenBuyError extends Error {
  status: number;
  details?: Record<string, unknown>;
  constructor(message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "WrenBuyError";
    this.status = status;
    this.details = details;
  }
}

export type WrenBuyResult = {
  txHash: string;
  symbol: string;
  usd: number;
  amountLabel: string;
  shares: string;
};

/** What a Buy costs: the amount, from cash, nothing added. */
export function wrenBuyCharge(usd: number): { stockUsd: number; feeUsd: 0; totalUsd: number } {
  const stockUsd = Math.round(Math.max(0, usd) * 100) / 100;
  return { stockUsd, feeUsd: 0, totalUsd: stockUsd };
}

export async function buyStockFromCash(input: {
  senderId: string;
  symbol: string;
  usd: number;
}): Promise<WrenBuyResult> {
  if (!(input.usd > 0)) throw new WrenBuyError("Enter an amount.");
  const embedded = await WalletAdapter.getEmbeddedWallet(input.senderId);
  if (!embedded?.address || !embedded.cdpUserId) throw new WrenBuyError("Sign in again, then try.", 404);

  const quoted = await quoteStockGift({ symbol: input.symbol, usd: input.usd.toFixed(2) });
  if (!quoted.ok) throw new WrenBuyError(quoted.error);
  const quote = quoted.quote;

  const cashRaw = await readErc20Balance(USDC, embedded.address).catch(() => 0n);
  if (cashRaw < quote.usdcCostRaw) {
    throw new WrenBuyError("not_enough_cash", 402, {
      cashUsd: Number(cashRaw) / 1_000_000,
      neededUsd: Number(quote.usdcCostRaw) / 1_000_000,
    });
  }

  const built = await buildStockBuyCalls({ quote, walletAddress: embedded.address });
  if (!built) throw new WrenBuyError("That didn't go through.", 502);

  const result = await EmbeddedWalletAdapter.sendCalls({
    userId: embedded.cdpUserId,
    address: embedded.address,
    calls: built.calls,
  });
  logger.info({ symbol: quote.entry.symbol, usd: input.usd }, "[wren] buy sent");
  return {
    txHash: result.txHash,
    symbol: quote.entry.symbol,
    usd: input.usd,
    amountLabel: quote.amountLabel,
    shares: quote.sharesHuman,
  };
}
