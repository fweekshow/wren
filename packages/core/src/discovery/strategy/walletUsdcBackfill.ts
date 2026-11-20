import { createPublicClient, http, parseAbiItem, type Log } from "viem";
import { base } from "viem/chains";

import { StrategyAdapter } from "@/discovery/adapters/strategy.adapter.js";
import { resolveBaseRpcUrl } from "@/chain/base-rpc.js";
import { BASE_USDC_ADDRESS } from "@/wallet/cdp.js";
import { logger } from "@/utils/logger.js";

/** Avantis TradingStorage — USDC collateral on open. */
const AVANTIS_TRADING_STORAGE = "0x8a311d7048c35985aa31c131b9a13e03a5f7422d".toLowerCase();
/** Avantis payout contract — USDC returned to wallet on close. */
const AVANTIS_TRADING_PAYOUT = "0xe9fb8c70af1b99f2baaa07aa926fcf3d237348dd".toLowerCase();

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const LOG_CHUNK_SIZE = 10n;
/** ~Jun 2026 — strategies on this wallet started around here. */
const DEFAULT_FROM_BLOCK = 47_400_000n;

function resolveAlchemyBaseUrl(): string | null {
  const key = process.env.ALCHEMY_API_KEY?.trim();
  return key ? `https://base-mainnet.g.alchemy.com/v2/${key}` : null;
}

interface AlchemyAssetTransfer {
  hash: string;
  blockNum: string;
  from: string;
  to: string;
  value?: number | null;
  rawContract?: { value?: string | null; decimal?: string | null };
}

async function fetchAlchemyAssetTransfers(
  params: Record<string, unknown>,
): Promise<AlchemyAssetTransfer[]> {
  const url = resolveAlchemyBaseUrl();
  if (!url) return [];

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getAssetTransfers",
      params: [params],
    }),
  });
  const json = (await res.json()) as {
    result?: { transfers?: AlchemyAssetTransfer[]; pageKey?: string };
    error?: { message?: string };
  };
  if (json.error) throw new Error(json.error.message ?? "alchemy_getAssetTransfers failed");

  const out = [...(json.result?.transfers ?? [])];
  let pageKey = json.result?.pageKey;
  while (pageKey) {
    const pageRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "alchemy_getAssetTransfers",
        params: [{ ...params, pageKey }],
      }),
    });
    const pageJson = (await pageRes.json()) as {
      result?: { transfers?: AlchemyAssetTransfer[]; pageKey?: string };
      error?: { message?: string };
    };
    if (pageJson.error) throw new Error(pageJson.error.message ?? "alchemy_getAssetTransfers failed");
    out.push(...(pageJson.result?.transfers ?? []));
    pageKey = pageJson.result?.pageKey;
  }
  return out;
}

function alchemyTransferAmountUsd(transfer: AlchemyAssetTransfer): number {
  if (transfer.value != null && Number.isFinite(transfer.value)) return transfer.value;
  const raw = transfer.rawContract?.value;
  if (!raw) return 0;
  const decimals = Number(transfer.rawContract?.decimal ?? 6);
  return Number(BigInt(raw)) / 10 ** decimals;
}

function alchemyTransferToUsdc(transfer: AlchemyAssetTransfer): UsdcTransfer | null {
  const amountUsd = alchemyTransferAmountUsd(transfer);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return null;
  return {
    txHash: transfer.hash.toLowerCase(),
    blockNumber: BigInt(transfer.blockNum),
    logIndex: 0,
    from: transfer.from.toLowerCase(),
    to: transfer.to.toLowerCase(),
    amountUsd,
  };
}

async function fetchUsdcTransfersViaAlchemy(wallet: string): Promise<UsdcTransfer[]> {
  const normalized = wallet.toLowerCase();
  const baseParams = {
    fromBlock: `0x${DEFAULT_FROM_BLOCK.toString(16)}`,
    toBlock: "latest",
    contractAddresses: [BASE_USDC_ADDRESS],
    category: ["erc20"],
    excludeZeroValue: true,
    maxCount: "0x3e8",
  };

  const [outs, ins] = await Promise.all([
    fetchAlchemyAssetTransfers({
      ...baseParams,
      fromAddress: normalized,
      toAddress: AVANTIS_TRADING_STORAGE,
    }),
    fetchAlchemyAssetTransfers({
      ...baseParams,
      fromAddress: AVANTIS_TRADING_PAYOUT,
      toAddress: normalized,
    }),
  ]);

  const transfers = [...outs, ...ins]
    .map(alchemyTransferToUsdc)
    .filter((row): row is UsdcTransfer => row != null);

  transfers.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.txHash.localeCompare(b.txHash);
  });
  return transfers;
}

export interface UsdcTransfer {
  txHash: string;
  blockNumber: bigint;
  logIndex: number;
  from: string;
  to: string;
  amountUsd: number;
}

export interface StrategyTradeBackfillRow {
  id: string;
  strategy_id: string;
  tx_hash: string | null;
  collateral_usdc: number;
  created_at: Date;
}

function parseTransferLog(log: Log): UsdcTransfer | null {
  if (log.topics.length < 3 || !log.blockNumber) return null;
  const from = `0x${log.topics[1]!.slice(26)}`.toLowerCase();
  const to = `0x${log.topics[2]!.slice(26)}`.toLowerCase();
  const raw = BigInt(log.data);
  return {
    txHash: log.transactionHash!.toLowerCase(),
    blockNumber: log.blockNumber,
    logIndex: Number(log.logIndex),
    from,
    to,
    amountUsd: Number(raw) / 1_000_000,
  };
}

async function fetchUsdcTransfersForWallet(
  wallet: string,
  fromBlock = DEFAULT_FROM_BLOCK,
): Promise<UsdcTransfer[]> {
  const normalized = wallet.toLowerCase();
  if (resolveAlchemyBaseUrl()) {
    try {
      return await fetchUsdcTransfersViaAlchemy(normalized);
    } catch (err) {
      logger.warn(`strategy pnl Alchemy scan failed ${normalized}, falling back to getLogs: ${(err as Error).message}`);
    }
  }

  const client = createPublicClient({
    chain: base,
    transport: http(resolveBaseRpcUrl(), { timeout: 30_000 }),
  });
  const latest = await client.getBlockNumber();

  const transfers: UsdcTransfer[] = [];
  for (let start = fromBlock; start <= latest; start += LOG_CHUNK_SIZE) {
    const end = start + LOG_CHUNK_SIZE - 1n > latest ? latest : start + LOG_CHUNK_SIZE - 1n;
    const [outs, ins] = await Promise.all([
      client.getLogs({
        address: BASE_USDC_ADDRESS as `0x${string}`,
        event: TRANSFER_EVENT,
        args: { from: normalized as `0x${string}`, to: AVANTIS_TRADING_STORAGE as `0x${string}` },
        fromBlock: start,
        toBlock: end,
      }),
      client.getLogs({
        address: BASE_USDC_ADDRESS as `0x${string}`,
        event: TRANSFER_EVENT,
        args: { from: AVANTIS_TRADING_PAYOUT as `0x${string}`, to: normalized as `0x${string}` },
        fromBlock: start,
        toBlock: end,
      }),
    ]);
    for (const log of [...outs, ...ins]) {
      const row = parseTransferLog(log);
      if (row) transfers.push(row);
    }
  }

  transfers.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });
  return transfers;
}

function amountsRoughlyEqual(a: number, b: number, tolerance = 0.05): boolean {
  return Math.abs(a - b) <= tolerance;
}

/**
 * Match closed strategy_trades to USDC out (open) / in (close) on the execution wallet.
 * Uses open tx_hash when available, otherwise FIFO pairing by collateral size.
 */
export function matchTradePnlFromUsdcFlows(
  trades: StrategyTradeBackfillRow[],
  transfers: UsdcTransfer[],
  wallet: string,
): Map<string, number> {
  const normalized = wallet.toLowerCase();
  const opens = transfers.filter(
    (t) => t.from === normalized && t.to === AVANTIS_TRADING_STORAGE,
  );
  const closes = transfers.filter(
    (t) => t.from === AVANTIS_TRADING_PAYOUT && t.to === normalized,
  );
  const usedOpen = new Set<number>();
  const usedClose = new Set<number>();
  const pnlByTradeId = new Map<string, number>();

  const sortedTrades = [...trades].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  for (const trade of sortedTrades) {
    let openIdx = -1;

    if (trade.tx_hash) {
      const tx = trade.tx_hash.toLowerCase();
      openIdx = opens.findIndex(
        (o, i) =>
          !usedOpen.has(i) &&
          o.txHash === tx &&
          amountsRoughlyEqual(o.amountUsd, trade.collateral_usdc, 0.25),
      );
      if (openIdx < 0) {
        openIdx = opens.findIndex((o, i) => !usedOpen.has(i) && o.txHash === tx);
      }
    }

    if (openIdx < 0) {
      openIdx = opens.findIndex(
        (o, i) =>
          !usedOpen.has(i) &&
          amountsRoughlyEqual(o.amountUsd, trade.collateral_usdc, 0.25),
      );
    }

    if (openIdx < 0) continue;
    const open = opens[openIdx]!;
    usedOpen.add(openIdx);

    const closeIdx = closes.findIndex(
      (c, i) =>
        !usedClose.has(i) &&
        (c.blockNumber > open.blockNumber ||
          (c.blockNumber === open.blockNumber && c.logIndex > open.logIndex)),
    );
    if (closeIdx < 0) continue;
    const close = closes[closeIdx]!;
    usedClose.add(closeIdx);

    const pnl = close.amountUsd - open.amountUsd;
    if (Number.isFinite(pnl)) pnlByTradeId.set(trade.id, pnl);
  }

  return pnlByTradeId;
}

/**
 * Reconcile a wallet's trades to their TRUE on-chain net (close payout - open
 * collateral, which includes Avantis fees + funding):
 * - CLOSED-unreconciled trades get their gross estimate overwritten with the net.
 * - STALE OPEN trades (phantoms whose on-chain position already closed but was
 *   never recorded — e.g. null slot indices) are matched by their open tx and
 *   CLOSED with the real net. Genuinely-open recent trades are excluded by the
 *   grace window and left untouched.
 * Each reconciled trade is marked one-shot so it isn't re-touched.
 */
export async function backfillStrategyPnlFromWalletUsdc(walletAddress: string): Promise<number> {
  const wallet = walletAddress.toLowerCase();
  const trades = await StrategyAdapter.listTradesNeedingReconcile(wallet);
  if (!trades.length) return 0;

  let transfers: UsdcTransfer[];
  try {
    transfers = await fetchUsdcTransfersForWallet(wallet);
  } catch (err) {
    logger.warn(`strategy pnl USDC scan failed ${wallet}: ${(err as Error).message}`);
    return 0;
  }

  if (!transfers.length) return 0;

  // matchTradePnlFromUsdcFlows pairs each open (by tx_hash) with the next close
  // payout; it only yields a net when BOTH legs exist — so a still-open trade with
  // no close payout produces no match and is left open.
  const matches = matchTradePnlFromUsdcFlows(trades, transfers, wallet);
  if (!matches.size) return 0;

  const touchedStrategies = new Set<string>();
  let healed = 0;
  for (const [tradeId, net] of matches) {
    const trade = trades.find((t) => t.id === tradeId);
    if (!trade) continue;
    await StrategyAdapter.markTradeReconciled(tradeId, net);
    if (trade.is_open) healed += 1;
    touchedStrategies.add(trade.strategy_id);
  }

  for (const strategyId of touchedStrategies) {
    await StrategyAdapter.recomputeRealizedPnl(strategyId);
  }

  logger.info(
    `strategy pnl reconcile ${wallet}: ${matches.size} trades booked to net (${healed} stale-open healed)`,
  );
  return matches.size;
}
