import { randomBytes } from "node:crypto";
import { createPublicClient, erc20Abi, http, parseUnits, type Address } from "viem";
import { base } from "viem/chains";

import { resolveBaseRpcUrl } from "@/chain/base-rpc.js";
import { config } from "@/config/config.js";
import { db } from "@/discovery/db.js";
import {
  buildStockBuyAndEscrowCalls,
  buildStockBuyAndTransferCalls,
  buildStockEscrowCalls,
  buildStockTransferCalls,
  giftSpendUsd,
  quoteStockGift,
  ourStockGiftFeeUsd,
  readErc20Balance,
  type StockGiftQuote,
  type StockGiftRecipient,
} from "@/discovery/stocks/giftStock.service.js";
import { logger } from "@/utils/logger.js";
import { basemateAccountOrigin } from "@/wallet/accountOrigin.js";
import { PhoneEscrowAdapter } from "@/wallet/phoneEscrow.js";
import { EmbeddedWalletAdapter, EmbeddedWalletError } from "@/wallet/embeddedWallet.js";
import { WalletSetupSessionAdapter, CLAIM_SESSION_TTL_MS } from "@/wallet/walletSetupSession.js";
import { smsOptInAskFor } from "@/messaging/smsConsentGate.js";
import { sendFundingConfirmDm } from "@/wallet/fundingNotify.js";
import { TxConfirmationAdapter } from "@/discovery/adapters/txConfirmation.adapter.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { acquireLock, releaseLock } from "@/state/conversationState.store.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const MAX_GIFT_RETRIES = 3;
const USDC_SETTLE_ATTEMPTS = 8;
const USDC_SETTLE_DELAY_MS = 2_500;
/** Longer than a full fulfil (USDC settle wait + userOp) so a concurrent trigger can't double-send. */
const FULFILL_LOCK_TTL_MS = 3 * 60 * 1000;
/** A gift "started" this long ago with no tx or failure is a crashed run — safe to pick up again. */
const STALE_START_MS = 10 * 60 * 1000;

export type StockGiftIntent = {
  kind: "gift_stock";
  symbol: string;
  qty?: string;
  usd?: string;
  memo?: string;
  recipient: StockGiftRecipient;
  quotedAt: string;
  maxUsd: number;
  sharePriceUsd?: number;
  /** Fee fixed at checkout (Wren: $2.99, or 0 on a first send). Absent = 1%. */
  feeUsd?: number;
  /** Paid from cash: always buy new, never send the sender's own shares. */
  buyNew?: boolean;
};

export type StockGiftRow = {
  id: string;
  senderId: string;
  walletAddress: string;
  fundSessionToken: string | null;
  intent: StockGiftIntent;
  amountUsd: number;
  coinbaseOrderId: string | null;
  giftStartedAt: Date | null;
  giftTxHash: string | null;
  giftFailedAt: Date | null;
  retryCount: number;
  claimUrl: string | null;
  createdAt: Date;
};

let tableReady: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS stock_gifts (
          id                 TEXT PRIMARY KEY,
          sender_id          TEXT NOT NULL,
          wallet_address     TEXT NOT NULL,
          fund_session_token TEXT,
          intent             JSONB NOT NULL,
          amount_usd         NUMERIC NOT NULL,
          coinbase_order_id  TEXT,
          gift_started_at    TIMESTAMPTZ,
          gift_tx_hash       TEXT,
          gift_failed_at     TIMESTAMPTZ,
          retry_count        INTEGER NOT NULL DEFAULT 0,
          claim_url          TEXT,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_stock_gifts_wallet_open
          ON stock_gifts (lower(wallet_address))
          WHERE gift_started_at IS NULL AND gift_tx_hash IS NULL;
        CREATE INDEX IF NOT EXISTS idx_stock_gifts_sender
          ON stock_gifts (sender_id, created_at DESC);
      `);
    })().catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

function newId(): string {
  return randomBytes(16).toString("hex");
}

function mapRow(row: Record<string, unknown>): StockGiftRow {
  return {
    id: String(row.id),
    senderId: String(row.sender_id),
    walletAddress: String(row.wallet_address),
    fundSessionToken: typeof row.fund_session_token === "string" ? row.fund_session_token : null,
    intent: row.intent as StockGiftIntent,
    amountUsd: Number(row.amount_usd),
    coinbaseOrderId: typeof row.coinbase_order_id === "string" ? row.coinbase_order_id : null,
    giftStartedAt: row.gift_started_at ? new Date(String(row.gift_started_at)) : null,
    giftTxHash: typeof row.gift_tx_hash === "string" ? row.gift_tx_hash : null,
    giftFailedAt: row.gift_failed_at ? new Date(String(row.gift_failed_at)) : null,
    retryCount: Number(row.retry_count ?? 0),
    claimUrl: typeof row.claim_url === "string" ? row.claim_url : null,
    createdAt: new Date(String(row.created_at)),
  };
}

export class StockGiftAdapter {
  static async create(input: {
    senderId: string;
    walletAddress: string;
    intent: StockGiftIntent;
    amountUsd: number;
    fundSessionToken?: string | null;
  }): Promise<StockGiftRow> {
    await ensureTable();
    const id = newId();
    const result = await db.query(
      `INSERT INTO stock_gifts (
         id, sender_id, wallet_address, fund_session_token, intent, amount_usd
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING *`,
      [
        id,
        input.senderId,
        input.walletAddress.toLowerCase(),
        input.fundSessionToken ?? null,
        JSON.stringify(input.intent),
        input.amountUsd,
      ],
    );
    return mapRow(result.rows[0]);
  }

  /** Mark unpaid Apple Pay checkouts failed so they don't linger as "pending sends". */
  static async abandonUnpaidCheckouts(input: {
    senderId: string;
    walletAddress: string;
    exceptGiftId?: string;
  }): Promise<number> {
    await ensureTable();
    const result = await db.query(
      `UPDATE stock_gifts
       SET gift_failed_at = NOW()
       WHERE gift_tx_hash IS NULL
         AND gift_started_at IS NULL
         AND gift_failed_at IS NULL
         AND fund_session_token IS NOT NULL
         AND (sender_id = $1 OR lower(wallet_address) = lower($2))
         AND ($3::text IS NULL OR id <> $3)`,
      [input.senderId, input.walletAddress, input.exceptGiftId ?? null],
    );
    return result.rowCount ?? 0;
  }

  static async get(id: string): Promise<StockGiftRow | null> {
    await ensureTable();
    const result = await db.query(`SELECT * FROM stock_gifts WHERE id = $1`, [id]);
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  /** Open gift for a funded wallet (webhook has no session token). */
  static async findOpenByWallet(walletAddress: string): Promise<StockGiftRow | null> {
    await ensureTable();
    const result = await db.query(
      `SELECT * FROM stock_gifts
       WHERE lower(wallet_address) = lower($1)
         AND gift_started_at IS NULL
         AND gift_tx_hash IS NULL
         AND gift_failed_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [walletAddress],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  static async findByFundSessionToken(token: string): Promise<StockGiftRow | null> {
    await ensureTable();
    const result = await db.query(
      `SELECT * FROM stock_gifts WHERE fund_session_token = $1 LIMIT 1`,
      [token],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  static async setFundSessionToken(giftId: string, token: string): Promise<void> {
    await ensureTable();
    await db.query(`UPDATE stock_gifts SET fund_session_token = $2 WHERE id = $1`, [giftId, token]);
  }

  /**
   * Atomic start lock — only one caller wins. Returns the claimed row or null
   * if another worker already started (or the gift is done/failed).
   */
  static async claimGiftStart(
    giftId: string,
    opts?: { coinbaseOrderId?: string | null },
  ): Promise<StockGiftRow | null> {
    await ensureTable();
    const result = await db.query(
      `UPDATE stock_gifts
       SET gift_started_at = NOW(),
           coinbase_order_id = COALESCE($2, coinbase_order_id),
           gift_failed_at = NULL
       WHERE id = $1
         AND gift_started_at IS NULL
         AND gift_tx_hash IS NULL
       RETURNING *`,
      [giftId, opts?.coinbaseOrderId ?? null],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  /** Allow a bounded retry after a failed userOp (clears started_at). */
  static async releaseForRetry(giftId: string): Promise<StockGiftRow | null> {
    await ensureTable();
    const result = await db.query(
      `UPDATE stock_gifts
       SET gift_started_at = NULL,
           retry_count = retry_count + 1,
           gift_failed_at = CASE
             WHEN retry_count + 1 >= $2 THEN NOW()
             ELSE NULL
           END
       WHERE id = $1
         AND gift_tx_hash IS NULL
         AND retry_count < $2
       RETURNING *`,
      [giftId, MAX_GIFT_RETRIES],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  static async markTxHash(giftId: string, txHash: string, claimUrl?: string | null): Promise<void> {
    await ensureTable();
    await db.query(
      `UPDATE stock_gifts
       SET gift_tx_hash = $2,
           claim_url = COALESCE($3, claim_url),
           gift_failed_at = NULL
       WHERE id = $1`,
      [giftId, txHash, claimUrl ?? null],
    );
  }

  /** Sends this sender completed (on-chain). Wren's first send is free. */
  static async countCompletedBySender(senderId: string): Promise<number> {
    await ensureTable();
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM stock_gifts WHERE sender_id = $1 AND gift_tx_hash IS NOT NULL`,
      [senderId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  static async markFailed(giftId: string): Promise<void> {
    await ensureTable();
    await db.query(
      `UPDATE stock_gifts SET gift_failed_at = NOW() WHERE id = $1 AND gift_tx_hash IS NULL`,
      [giftId],
    );
  }

  static async setClaimUrl(giftId: string, claimUrl: string): Promise<void> {
    await ensureTable();
    await db.query(`UPDATE stock_gifts SET claim_url = $2 WHERE id = $1`, [giftId, claimUrl]);
  }
}

async function readUsdcBalance(wallet: string): Promise<bigint> {
  const client = createPublicClient({
    chain: base,
    transport: http(resolveBaseRpcUrl()),
  });
  return client.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [wallet as Address],
  });
}

async function waitForUsdc(wallet: string, minRaw: bigint): Promise<boolean> {
  for (let i = 0; i < USDC_SETTLE_ATTEMPTS; i++) {
    try {
      const bal = await readUsdcBalance(wallet);
      if (bal >= minRaw) return true;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, USDC_SETTLE_DELAY_MS));
  }
  return false;
}

function buildClaimUrl(token: string): string {
  return `${basemateAccountOrigin(config.payPage.origin)}/wallet/connect?s=${token}`;
}

export type FulfillStockGiftResult = {
  ok: boolean;
  txHash?: string;
  claimUrl?: string | null;
  error?: string;
  needsReauth?: boolean;
};

/**
 * Re-quote and execute transfer or buy+send/escrow. Caller must already hold claimGiftStart.
 * Never invoke from recordOnrampFunding — webhook/bot fire-and-forget only.
 */
export async function fulfillStockGift(
  giftId: string,
  opts?: { notifySender?: boolean },
): Promise<FulfillStockGiftResult> {
  // record-funding (pay page), the onramp webhook and "retry gift" can all
  // fire for the same gift within seconds. Without this lock each one built
  // and submitted its own buy+send userOp — the loser reverted on-chain.
  const lockKey = `lock:stock-gift:${giftId}`;
  if (!(await acquireLock(lockKey, FULFILL_LOCK_TTL_MS))) {
    return { ok: false, error: "gift already in progress" };
  }
  try {
    return await fulfillStockGiftLocked(giftId, opts);
  } finally {
    await releaseLock(lockKey);
  }
}

async function fulfillStockGiftLocked(
  giftId: string,
  opts?: { notifySender?: boolean },
): Promise<FulfillStockGiftResult> {
  const gift = await StockGiftAdapter.get(giftId);
  if (!gift) return { ok: false, error: "gift not found" };
  if (gift.giftTxHash) return { ok: true, txHash: gift.giftTxHash, claimUrl: gift.claimUrl };
  if (gift.giftFailedAt && gift.retryCount >= MAX_GIFT_RETRIES) {
    return { ok: false, error: "gift retries exhausted" };
  }
  if (!gift.giftStartedAt) {
    return { ok: false, error: "gift not claimed — call claimGiftStart first" };
  }

  const intent = gift.intent;
  const quoted = await quoteStockGift({
    symbol: intent.symbol,
    qty: intent.qty,
    usd: intent.usd,
  });
  if (!quoted.ok) {
    await StockGiftAdapter.releaseForRetry(giftId);
    return { ok: false, error: quoted.error };
  }

  let quote: StockGiftQuote = quoted.quote;
  const spendUsd = giftSpendUsd(quote);
  const ourFeeUsd =
    typeof intent.feeUsd === "number" && intent.feeUsd >= 0 ? intent.feeUsd : ourStockGiftFeeUsd(spendUsd);
  // Apple Pay gifts must spend the USDC that was just bought for them. Deciding
  // "from holdings" here again let fee payouts that landed mid-checkout get
  // sent instead, leaving the sender's onramp USDC idle in the wallet.
  const onrampFunded = Boolean(gift.fundSessionToken);
  const stockBal = onrampFunded
    ? 0n
    : await readErc20Balance(quote.entry.address, gift.walletAddress).catch(() => 0n);
  const fromHoldings = !onrampFunded && !intent.buyNew && stockBal >= quote.sharesRaw;
  const stockBudget = Math.max(0, gift.amountUsd - ourFeeUsd);
  // USD gifts only: if price drifted above the stock budget, buy what the funded amount covers.
  // Qty gifts keep the asked share count — do not downsize to fractional shares.
  if (!fromHoldings && quote.isUsd && quote.notionalUsd > stockBudget && stockBudget > 0) {
    const capped = await quoteStockGift({
      symbol: intent.symbol,
      usd: String(stockBudget),
    });
    if (!capped.ok) {
      await StockGiftAdapter.releaseForRetry(giftId);
      return { ok: false, error: capped.error };
    }
    quote = capped.quote;
  }

  let feeUsd = ourFeeUsd;
  if (fromHoldings) {
    const feeRaw = parseUnits(ourFeeUsd.toFixed(6), 6);
    const usdcBal = await readErc20Balance(USDC, gift.walletAddress).catch(() => 0n);
    if (usdcBal < feeRaw) feeUsd = 0;
  } else {
    const feeRaw = parseUnits(ourFeeUsd.toFixed(6), 6);
    const settled = await waitForUsdc(gift.walletAddress, quote.usdcCostRaw + feeRaw);
    if (!settled) {
      await StockGiftAdapter.releaseForRetry(giftId);
      void sendFundingConfirmDm(
        gift.senderId,
        `your Apple Pay went through, but the money hasn't landed yet. reply "retry gift" in a minute and I'll send the ${quote.plainName}.`,
      );
      return { ok: false, error: "usdc not settled" };
    }
  }

  const embedded = await WalletAdapter.getEmbeddedWallet(gift.senderId);
  if (!embedded) {
    await StockGiftAdapter.markFailed(giftId);
    return { ok: false, error: "no embedded wallet", needsReauth: true };
  }

  let calls;
  let label: string;
  let claimUrl: string | null = null;
  let escrowDraft: ReturnType<typeof PhoneEscrowAdapter.buildDepositDraft> | null = null;

  if (intent.recipient.kind === "wallet" && intent.recipient.address) {
    const built = fromHoldings
      ? buildStockTransferCalls({
          quote,
          recipientAddress: intent.recipient.address,
          memo: intent.memo,
          feeUsd,
        })
      : await buildStockBuyAndTransferCalls({
          quote,
          walletAddress: gift.walletAddress,
          recipientAddress: intent.recipient.address,
          memo: intent.memo,
          feeUsd,
        });
    if (!built) {
      await StockGiftAdapter.releaseForRetry(giftId);
      return {
        ok: false,
        error: fromHoldings ? "could not build transfer" : "could not build buy+transfer",
      };
    }
    calls = built.calls;
    label = built.label;
  } else if (intent.recipient.kind === "claim_phone" && intent.recipient.phone) {
    const built = fromHoldings
      ? buildStockEscrowCalls({
          quote,
          phone: intent.recipient.phone,
          contactName: intent.recipient.name ?? intent.recipient.display,
          memo: intent.memo,
          feeUsd,
        })
      : await buildStockBuyAndEscrowCalls({
          quote,
          walletAddress: gift.walletAddress,
          phone: intent.recipient.phone,
          contactName: intent.recipient.name ?? intent.recipient.display,
          memo: intent.memo,
          feeUsd,
        });
    if (!built) {
      await StockGiftAdapter.releaseForRetry(giftId);
      return {
        ok: false,
        error: fromHoldings ? "could not build escrow" : "could not build buy+escrow",
      };
    }
    calls = built.calls;
    label = built.label;
    escrowDraft = built.escrow;

    const setupToken = await WalletSetupSessionAdapter.create(
      intent.recipient.phone,
      CLAIM_SESSION_TTL_MS,
    );
    claimUrl = buildClaimUrl(setupToken);
  } else {
    await StockGiftAdapter.markFailed(giftId);
    return { ok: false, error: "invalid recipient" };
  }

  if (escrowDraft) {
    await PhoneEscrowAdapter.recordDepositIntent({
      senderId: gift.senderId,
      phone: escrowDraft.phone,
      phoneHash: escrowDraft.phoneHash,
      tokenAddress: escrowDraft.tokenAddress as Address,
      tokenSymbol: escrowDraft.tokenSymbol,
      tokenDecimals: escrowDraft.tokenDecimals,
      amountAtomic: escrowDraft.amountAtomic,
      amount: escrowDraft.amount,
      sourceId: `stock-gift:${gift.id}`,
    });
  }

  try {
    const result = await EmbeddedWalletAdapter.sendCalls({
      userId: embedded.cdpUserId,
      address: embedded.address,
      calls,
    });
    const txHash = result.txHash;
    await StockGiftAdapter.markTxHash(gift.id, txHash, claimUrl);

    const recipientPhone =
      intent.recipient.kind === "claim_phone"
        ? intent.recipient.phone
        : intent.recipient.phone ?? null;

    await TxConfirmationAdapter.recordConfirmedActivity({
      senderId: gift.senderId,
      fromAddress: gift.walletAddress,
      chainId: "0x2105",
      label,
      transferAmount: quote.amountLabel,
      transferAsset: "",
      transferMemo: intent.memo ?? null,
      recipientPhone,
      txHash,
    });

    // Start the 72h claim clock so unclaimed stock escrow refunds to the sender.
    if (escrowDraft && recipientPhone) {
      try {
        await PhoneEscrowAdapter.confirmDeposit({
          senderId: gift.senderId,
          recipientPhone,
          depositTxHash: txHash,
          senderRefundAddress: gift.walletAddress,
          amountDisplay: escrowDraft.amount,
          tokenSymbol: escrowDraft.tokenSymbol,
          tokenAddress: escrowDraft.tokenAddress,
          amountAtomic: escrowDraft.amountAtomic,
        });
      } catch (err) {
        logger.error(
          { err, giftId },
          "[stock-gift] confirmDeposit failed — 72h refund clock not started",
        );
      }
    }

    const memoLine = intent.memo ? `\nnote: ${intent.memo}` : "";
    if (opts?.notifySender !== false) {
      const optInAsk = await smsOptInAskFor(recipientPhone);
      void sendFundingConfirmDm(
        gift.senderId,
        [`Sent ${quote.amountLabel} to ${intent.recipient.display}.${memoLine}`, optInAsk]
          .filter(Boolean)
          .join("\n\n"),
      );
    }

    return { ok: true, txHash, claimUrl };
  } catch (err) {
    if (err instanceof EmbeddedWalletError && err.needsReauth) {
      void sendFundingConfirmDm(
        gift.senderId,
        `your funds are in. reconnect your Basemate wallet on basemate.app, then reply "retry gift" to finish sending ${quote.plainName}.`,
      );
      await StockGiftAdapter.releaseForRetry(giftId);
      return { ok: false, error: "needs reauth", needsReauth: true };
    }
    logger.error({ err, giftId }, "[stock-gift] sendCalls failed");
    const released = await StockGiftAdapter.releaseForRetry(giftId);
    if (released?.giftFailedAt) {
      void sendFundingConfirmDm(
        gift.senderId,
        `couldn't send the ${quote.plainName} after a few tries. your money is still in your Basemate account. reply "retry gift" to try again.`,
      );
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Fire-and-forget fulfill after onramp webhook / funding record. */
export function scheduleStockGiftFulfill(giftId: string): void {
  void fulfillStockGift(giftId).catch((err) => {
    logger.error({ err, giftId }, "[stock-gift] async fulfill failed");
  });
}

/** After Apple Pay: lock the gift and buy+send. Safe to call from iframe and webhook. */
export async function startStockGiftAfterFunding(input: {
  giftId?: string | null;
  fundSessionToken?: string | null;
  walletAddress?: string | null;
  coinbaseOrderId?: string | null;
}): Promise<string | null> {
  let gift = input.giftId ? await StockGiftAdapter.get(input.giftId) : null;
  if (!gift && input.fundSessionToken) {
    gift = await StockGiftAdapter.findByFundSessionToken(input.fundSessionToken);
  }
  if (!gift && input.walletAddress) {
    gift = await StockGiftAdapter.findOpenByWallet(input.walletAddress);
  }
  if (!gift || gift.giftTxHash) return gift?.id ?? null;
  if (!gift.giftStartedAt) {
    const claimed = await StockGiftAdapter.claimGiftStart(gift.id, {
      coinbaseOrderId: input.coinbaseOrderId,
    });
    if (!claimed) return gift.id;
    scheduleStockGiftFulfill(claimed.id);
    return claimed.id;
  }
  // Already started by another trigger. Only re-run if that run is clearly
  // dead (crashed mid-flight) — otherwise the fulfil lock would just bounce it.
  const startedAgo = Date.now() - gift.giftStartedAt.getTime();
  if (startedAgo >= STALE_START_MS) {
    scheduleStockGiftFulfill(gift.id);
  }
  return gift.id;
}

export { MAX_GIFT_RETRIES };
