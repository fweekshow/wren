import { createHash } from "node:crypto";

import { prepareAvantisOpen, isAvantisLive } from "@basemate/avantis-client";
import type { StrategyConfig } from "@basemate/shared";

import { resolveTpslReferencePrice } from "@/discovery/ai.js";
import { computeTpslPresetPrice } from "@/discovery/avantisTpsl.util.js";
import { StrategyAdapter } from "@/discovery/adapters/strategy.adapter.js";
import { getOrCreateStrategySmartWallet, sendStrategyCalls } from "@/wallet/cdp.js";
import { logger } from "@/utils/logger.js";

import {
  isStrategyLiveTradingPaused,
  LIVE_TRADING_PAUSED_MESSAGE,
} from "./liveTrading.js";
import type { TradeSignal } from "./signals.js";
import { resolveEffectiveTpslPercents } from "./tpsl.js";

/** Follower-only fallback — creators use cp- wallet via deployStrategy. */
export function strategyWalletName(strategyId: string): string {
  const hash = createHash("sha256").update(strategyId).digest("hex").slice(0, 30);
  return `st-${hash}`;
}

export interface ExecuteSignalInput {
  strategyId: string;
  creatorWallet: string;
  config: StrategyConfig;
  signal: TradeSignal;
  collateralUsdc: number;
  /** Mark at signal time — used for TP/SL anchoring. */
  entryPrice?: number;
  /** Override wallet (creator strategy wallet or follower copy wallet). */
  walletName?: string;
}

export interface ExecuteSignalResult {
  ok: boolean;
  txHash?: string;
  walletAddress?: string;
  error?: string;
}

const MARK_PRICE_RETRIES = 3;
const MARK_PRICE_RETRY_MS = 500;

async function resolveMarkPrice(pairBase: string, entryPrice?: number): Promise<number | null> {
  if (entryPrice != null && Number.isFinite(entryPrice) && entryPrice > 0) {
    return entryPrice;
  }
  for (let attempt = 0; attempt < MARK_PRICE_RETRIES; attempt++) {
    const price = await resolveTpslReferencePrice({ base: pairBase, order: "market" }).catch(
      () => null,
    );
    if (price != null && Number.isFinite(price) && price > 0) return price;
    if (attempt < MARK_PRICE_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, MARK_PRICE_RETRY_MS));
    }
  }
  return null;
}

/** Strategy config TP/SL only — never opens without both prices. */
async function resolveStrategyOpenTpsl(args: {
  pairBase: string;
  side: "long" | "short";
  config: StrategyConfig;
  entryPrice?: number;
}): Promise<{ takeProfit: string; stopLoss: string } | null> {
  const refPrice = await resolveMarkPrice(args.pairBase, args.entryPrice);
  if (refPrice == null) return null;

  const { tpPercent, slPercent } = resolveEffectiveTpslPercents(args.config);

  const takeProfit = computeTpslPresetPrice({
    refPrice,
    side: args.side,
    kind: "tp",
    percent: tpPercent,
  });
  const stopLoss = computeTpslPresetPrice({
    refPrice,
    side: args.side,
    kind: "sl",
    percent: slPercent,
  });

  if (!takeProfit || !stopLoss) return null;
  return { takeProfit, stopLoss };
}

/**
 * Open a perp on the strategy's isolated CDP wallet via prepareAvantisOpen +
 * sendStrategyCalls (sponsored user op when STRATEGY_USE_CDP_PAYMASTER=true).
 * Refuses to open without TP/SL — server-wallet strategies must always be protected.
 */
export async function executeStrategySignal(
  input: ExecuteSignalInput,
): Promise<ExecuteSignalResult> {
  if (isStrategyLiveTradingPaused()) {
    return { ok: false, error: LIVE_TRADING_PAUSED_MESSAGE };
  }

  if (!isAvantisLive()) {
    return { ok: false, error: "avantis unavailable" };
  }

  const pair = input.signal.pair.includes("-") ? input.signal.pair : `${input.signal.pair}-USD`;

  // Guard: refuse to open a second live position for the same strategy + pair.
  // Mirrors the paperExecutor "nothing is open for this pair" check.
  const alreadyOpen = await StrategyAdapter.hasOpenLiveTrade(input.strategyId, pair);
  if (alreadyOpen) {
    logger.info(
      `strategy exec skipped ${input.strategyId} ${pair}: live position already open`,
    );
    return { ok: false, error: "live position already open for this pair" };
  }

  const walletName = input.walletName ?? strategyWalletName(input.strategyId);
  let walletAddress: string;
  try {
    const wallet = await getOrCreateStrategySmartWallet(walletName);
    walletAddress = wallet.walletAddress;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const pairBase = pair.split("-")[0] ?? pair;
  const leverage = Math.max(1, Math.round(input.config.maxLeverage));

  const tpsl = await resolveStrategyOpenTpsl({
    pairBase,
    side: input.signal.side,
    config: input.config,
    entryPrice: input.entryPrice,
  });

  if (!tpsl) {
    const msg = "refusing to open without tp/sl (mark price unavailable)";
    logger.warn(`strategy exec blocked ${input.strategyId} ${pair}: ${msg}`);
    return { ok: false, error: msg, walletAddress };
  }

  const prep = await prepareAvantisOpen({
    trader: walletAddress,
    pair,
    side: input.signal.side,
    collateral: input.collateralUsdc.toFixed(2),
    leverage,
    orderType: "market",
    takeProfit: tpsl.takeProfit,
    stopLoss: tpsl.stopLoss,
  });

  if (!prep.ok) {
    const msg =
      prep.kind === "min_position"
        ? `min position ~$${prep.minPos} (collateral ${prep.collateral} @ ${prep.leverage}x)`
        : prep.kind === "error"
          ? prep.message
          : prep.kind;
    return { ok: false, error: String(msg), walletAddress };
  }

  try {
    const { hashes } = await sendStrategyCalls({ accountName: walletName, calls: prep.calls });
    const txHash = hashes[hashes.length - 1] ?? hashes[0];
    logger.info(
      `strategy exec ${input.strategyId} ${pair} ${input.signal.side} tp=${tpsl.takeProfit} sl=${tpsl.stopLoss} tx=${txHash}`,
    );
    return { ok: true, txHash, walletAddress };
  } catch (err) {
    return { ok: false, error: (err as Error).message, walletAddress };
  }
}
