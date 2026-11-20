import { StrategyAdapter, type StrategyRow, type StrategyStatus } from "@/discovery/adapters/strategy.adapter.js";
import { StrategySubscriptionAdapter } from "@/discovery/adapters/strategySubscription.adapter.js";
import { fetchAvantisMarkPrice, fetchAvantisUserData, isAvantisLive } from "@basemate/avantis-client";
import { hasOrderbookOnlyModes, minStrategyCollateralUsdc, oracleExecutableModes } from "@basemate/shared";

import type { PollerJobHandle } from "@/infra/queues/base.js";
import { logger } from "@/utils/logger.js";

import { isMultiStrategyAllowed } from "./allowlist.js";
import { executeStrategySignal } from "./executor.js";
import {
  isStrategyLiveTradingPaused,
  LIVE_TRADING_PAUSED_MESSAGE,
  PAPER_TRADING_OFF_MESSAGE,
} from "./liveTrading.js";
import { closeAllPaperTrades, runPaperStrategyTick } from "./paperExecutor.js";
import { pushMarkSample } from "./priceHistory.js";
import { checkPublishGate } from "./publishGate.js";
import { evaluateEntryRiskGate } from "./riskGate.js";
import { evaluateOracleSignals, ORACLE_MIN_SAMPLES, smokeTestEntrySignal, type TradeSignal } from "./signals.js";
import { getUsdcBalance, isStrategyPaymasterEnabled } from "@/wallet/cdp.js";
import { resolveCreatorExecutionWallet } from "./wallet.js";
import { syncStrategyWalletPnl } from "./pnlSync.js";
import { clearExecFailureNotice, maybeNotifyExecFailure } from "./strategyExecNotify.js";

/**
 * Resolve the live execution wallet, re-binding DB when paymaster migrates
 * stored EOA → smart account address (or any other address drift).
 */
async function ensureExecutionWallet(
  row: StrategyRow,
): Promise<{ walletName: string; walletAddress: string } | null> {
  const resolved = await resolveCreatorExecutionWallet(row.creator_inbox_id).catch(() => null);
  if (!resolved) return null;

  const storedName = row.execution_wallet_name;
  const storedAddress = row.execution_wallet_address;
  const addressChanged =
    !storedAddress || storedAddress.toLowerCase() !== resolved.walletAddress.toLowerCase();
  const nameChanged = !storedName || storedName !== resolved.walletName;

  // Always persist when paymaster is on and address drifted (EOA → smart account).
  // Also persist when wallet was never bound.
  if (nameChanged || addressChanged) {
    if (isStrategyPaymasterEnabled() && addressChanged && storedAddress) {
      logger.info(
        `strategy ${row.id} rebinding execution wallet ${storedAddress} → ${resolved.walletAddress} (paymaster smart account)`,
      );
    }
    await StrategyAdapter.setExecutionWallet(row.id, resolved.walletName, resolved.walletAddress);
  }

  return resolved;
}

const DEFAULT_COLLATERAL_USDC = 25;

/** Log warmup progress when sample count advances (survives restarts via postgres buffer). */
const lastWarmupLog = new Map<string, number>();

function pairBase(pair: string): string {
  return pair.split("-")[0] ?? pair;
}

async function inferOpenedTradeIndex(
  wallet: string,
  pair: string,
  side: "long" | "short",
): Promise<{ tradeIndex?: number; pairIndex?: number; openPrice?: string }> {
  try {
    const data = await fetchAvantisUserData(wallet);
    const base = pairBase(pair).toUpperCase();
    const matches = data.positions.filter(
      (position) =>
        position.side === side &&
        position.pair.toUpperCase().replace(/[-/_]/g, "").includes(base),
    );
    if (matches.length === 0) return {};
    const latest = matches.reduce((best, current) =>
      current.tradeIndex >= best.tradeIndex ? current : best,
    );
    return {
      tradeIndex: latest.tradeIndex,
      pairIndex: latest.pairIndex,
      openPrice: latest.openPrice ?? undefined,
    };
  } catch {
    return {};
  }
}

async function tickStrategy(row: StrategyRow): Promise<void> {
  const isPaper = row.status === "paper";
  // Paper strategies only read marks (no on-chain exec), so they keep ticking
  // even when Avantis live execution is gated off.
  if (!isPaper && !isAvantisLive()) return;

  // Prefer live-resolved address (smart account under paymaster) over stale DB EOA.
  // Skip CDP for paper ticks — they never execute on-chain.
  let walletAddress = row.execution_wallet_address;
  if (!isPaper && (!walletAddress || isStrategyPaymasterEnabled())) {
    const bound = await ensureExecutionWallet(row).catch(() => null);
    if (bound) walletAddress = bound.walletAddress;
  }

  const modes = oracleExecutableModes(row.config);
  if (!modes.length) {
    if (hasOrderbookOnlyModes(row.config)) {
      if (walletAddress) await syncStrategyWalletPnl(walletAddress).catch(() => undefined);
      return;
    }
  }

  const pairs = row.config.pairs.filter(Boolean);
  if (!pairs.length) {
    if (walletAddress) await syncStrategyWalletPnl(walletAddress).catch(() => undefined);
    return;
  }

  const smokePair = pairs[0]!;
  let smokeSignal: TradeSignal | null =
    row.trade_count === 0 && row.config.smokeTest
      ? smokeTestEntrySignal(row.config, smokePair)
      : null;

  if (smokeSignal && row.config.smokeTest) {
    logger.info(`strategy ${row.id} instant entry armed — firing ${smokeSignal.side} ${smokePair}`);
  }

  let touchedEval = false;
  const [entriesToday, openPaperTrades] = await Promise.all([
    StrategyAdapter.countTodayEntries(row.id).catch(() => 0),
    isPaper ? StrategyAdapter.listOpenPaperTrades(row.id).catch(() => []) : Promise.resolve([]),
  ]);
  const openPaperPairs = new Set(openPaperTrades.map((t) => t.pair));

  for (const pair of pairs) {
    const base = pairBase(pair);
    const mark = await fetchAvantisMarkPrice(base).catch(() => null);
    if (mark == null || !Number.isFinite(mark)) continue;

    if (!touchedEval) {
      await StrategyAdapter.touchEval(row.id);
      touchedEval = true;
    }

    let signal: TradeSignal | null = null;
    if (smokeSignal && pair === smokePair) {
      signal = smokeSignal;
    } else if (!smokeSignal) {
      const samples = await pushMarkSample(pair, mark);
      signal = evaluateOracleSignals({
        pair,
        price: mark,
        samples,
        config: row.config,
      });
      if (!signal && samples.length < ORACLE_MIN_SAMPLES) {
        const prev = lastWarmupLog.get(pair) ?? -1;
        if (samples.length !== prev) {
          lastWarmupLog.set(pair, samples.length);
          logger.info(
            `strategy warmup ${pair} — ${samples.length}/${ORACLE_MIN_SAMPLES} mark samples before entries`,
          );
        }
      }
    }

    if (isPaper) {
      await runPaperStrategyTick({
        row,
        pair,
        mark,
        signal,
        entriesToday,
        openPaperPairs,
      });
      continue;
    }

    if (isStrategyLiveTradingPaused()) {
      continue;
    }

    if (!signal) continue;

    let walletName = row.execution_wallet_name;
    if (!walletName || !walletAddress || isStrategyPaymasterEnabled()) {
      const resolved = await ensureExecutionWallet(row);
      if (!resolved) {
        logger.warn(`strategy ${row.id} — CDP wallet unavailable`);
        continue;
      }
      walletName = resolved.walletName;
      walletAddress = resolved.walletAddress;
    }

    const creatorWallet = row.creator_wallet ?? walletAddress!;
    const collateral =
      row.default_collateral_usdc != null
        ? Number(row.default_collateral_usdc)
        : row.config.defaultCollateralUsdc ?? DEFAULT_COLLATERAL_USDC;

    const gate = await evaluateEntryGate(row, signal, collateral, walletAddress, entriesToday);
    if (!gate.ok) {
      logger.info(`strategy ${row.id} entry blocked (${gate.code}): ${gate.reason ?? ""}`);
      continue;
    }

    const result = await executeStrategySignal({
      strategyId: row.id,
      creatorWallet,
      config: row.config,
      signal,
      collateralUsdc: collateral,
      entryPrice: mark,
      walletName: walletName!,
    });

    if (result.ok) {
      const opened = await inferOpenedTradeIndex(walletAddress!, pair, signal.side);
      await StrategyAdapter.recordTrade(row.id, {
        pair,
        side: signal.side,
        mode: signal.mode,
        txHash: result.txHash ?? null,
        collateralUsdc: collateral,
        pnlUsd: 0,
        tradeIndex: opened.tradeIndex ?? null,
        pairIndex: opened.pairIndex ?? null,
        openPrice: opened.openPrice ?? null,
        entryRegime: signal.regime ?? null,
      });
      clearExecFailureNotice(row.id);
      if (!row.config.smokeTest) {
        const publishGate = checkPublishGate(await StrategyAdapter.getById(row.id) ?? row);
        if (publishGate.ok && row.status === "testing") {
          await StrategyAdapter.updateStatus(row.id, "publishable");
        }
      }

      if (row.status === "published") {
        await replicateSignalToFollowers(row, signal, collateral, mark);
      }
    } else {
      logger.warn(`strategy ${row.id} exec failed: ${result.error}`);
      await maybeNotifyExecFailure({
        strategyId: row.id,
        strategyName: row.name,
        creatorInboxId: row.creator_inbox_id,
        creatorWallet: row.creator_wallet,
        walletAddress,
        marginUsdc: collateral,
        error: result.error,
      }).catch(() => undefined);
    }
  }

  if (isPaper) return;

  if (isStrategyLiveTradingPaused()) {
    logger.info(`strategy ${row.id} new entries paused — ${LIVE_TRADING_PAUSED_MESSAGE} (maintenance only)`);
  }

  if (walletAddress) await syncStrategyWalletPnl(walletAddress).catch(() => undefined);
}

/** Gather live inputs (equity, today's PnL, recent closes, open pairs) and run the pure risk gate. */
async function evaluateEntryGate(
  row: StrategyRow,
  signal: TradeSignal,
  collateralUsdc: number,
  walletAddress: string | null,
  entriesToday: number,
): Promise<ReturnType<typeof evaluateEntryRiskGate>> {
  const pair = signal.pair.includes("-") ? signal.pair : `${signal.pair}-USD`;

  let equityUsd: number | null = null;
  if (walletAddress) {
    const raw = await getUsdcBalance(walletAddress).catch(() => null);
    if (raw != null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) equityUsd = parsed;
    }
  }

  const [todayRealizedPnlUsd, recent, alreadyOpen, lastEntryAt] = await Promise.all([
    StrategyAdapter.getTodayRealizedPnlUsd(row.id).catch(() => 0),
    StrategyAdapter.listClosedTrades(row.id, 10).catch(() => []),
    StrategyAdapter.hasOpenLiveTrade(row.id, pair).catch(() => false),
    StrategyAdapter.getLastEntryAt(row.id, pair).catch(() => null),
  ]);

  const recentClosedTrades = recent
    .filter((t) => !t.is_paper)
    .map((t) => ({ pnlUsd: t.pnl_usd, closedAt: t.closed_at }));

  return evaluateEntryRiskGate({
    config: row.config,
    signal: { pair, side: signal.side },
    collateralUsdc,
    equityUsd,
    todayRealizedPnlUsd,
    recentClosedTrades,
    openPairs: alreadyOpen ? [pair] : [],
    lastEntryAtMs: lastEntryAt?.getTime() ?? null,
    entriesToday,
  });
}

async function replicateSignalToFollowers(
  row: StrategyRow,
  signal: import("./signals.js").TradeSignal,
  defaultCollateral: number,
  entryPrice: number,
): Promise<void> {
  if (isStrategyLiveTradingPaused()) return;

  const subs = await StrategySubscriptionAdapter.listByStrategy(row.id);
  if (!subs.length || !row.creator_wallet) return;

  for (const sub of subs) {
    const collateral = sub.allocation_usdc > 0 ? sub.allocation_usdc : defaultCollateral;
    try {
      await executeStrategySignal({
        strategyId: row.id,
        creatorWallet: row.creator_wallet,
        config: row.config,
        signal,
        collateralUsdc: collateral,
        entryPrice,
        walletName: sub.copy_wallet_name,
      });
    } catch (err) {
      logger.warn(`follower exec ${sub.id}: ${(err as Error).message}`);
    }
  }
}

/**
 * Polls strategies in `testing` or `published` status, evaluates oracle signals,
 * and executes via the per-strategy CDP wallet.
 */
export class StrategyRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(_intervalMs = 60_000): void {
    logger.info("StrategyRunner disabled — paper trading and VibeTrading are off");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Start the strategy runner as a BullMQ repeatable job.
   * Distributed lock (concurrency: 1) ensures only one replica fires per tick,
   * preventing duplicate trade entries when horizontally scaled.
   */
  async startBullMq(_intervalMs = 60_000): Promise<PollerJobHandle> {
    logger.info("StrategyRunner disabled — paper trading and VibeTrading are off");
    return {
      queue: null as unknown as PollerJobHandle["queue"],
      worker: null as unknown as PollerJobHandle["worker"],
      stop: async () => {},
    };
  }

  /** Paper trading and VibeTrading are off — ticks do not evaluate or open trades. */
  async tickOnce(): Promise<void> {
    return;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tickOnce();
    } catch (err) {
      logger.warn(`StrategyRunner tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

/** Per-creator strategy caps (admin allowlist is unlimited). */
export const MAX_LIVE_STRATEGIES = 3;
export const MAX_PAPER_STRATEGIES = 10;
const LIVE_STATUSES: StrategyStatus[] = ["testing", "publishable", "published"];

/**
 * Start a strategy in paper mode: no wallet bind, no on-chain trades — the runner
 * simulates fills against the live mark. Capped at MAX_PAPER_STRATEGIES per creator.
 */
export async function deployPaperStrategy(
  _strategyId: string,
  _creatorInboxId?: string,
): Promise<{ ok: boolean; error?: string }> {
  return { ok: false, error: PAPER_TRADING_OFF_MESSAGE };
}

/** Deploy a strategy to testing: bind creator's existing cp- wallet + set status. */
export async function deployStrategy(
  strategyId: string,
  creatorInboxId?: string,
  collateralUsdc?: number,
): Promise<{
  ok: boolean;
  walletName?: string;
  walletAddress?: string;
  error?: string;
  blockedStrategy?: StrategyRow;
}> {
  if (isStrategyLiveTradingPaused()) {
    return { ok: false, error: LIVE_TRADING_PAUSED_MESSAGE };
  }

  const row = await StrategyAdapter.getById(strategyId);
  if (!row) return { ok: false, error: "strategy not found" };

  const config = row.config;
  const margin = collateralUsdc ?? config.defaultCollateralUsdc ?? DEFAULT_COLLATERAL_USDC;
  const notional = margin * config.maxLeverage;
  const minMargin = minStrategyCollateralUsdc(config.maxLeverage);
  if (notional < 100) {
    return {
      ok: false,
      error: `margin $${margin} @ ${config.maxLeverage}x = $${notional.toFixed(0)} notional — need ~$100+ (try $${minMargin} margin or higher leverage)`,
    };
  }

  const inboxId = creatorInboxId ?? row.creator_inbox_id;
  const allowed = await isMultiStrategyAllowed({
    wallet: row.creator_wallet,
    basename: row.creator_basename,
  });
  if (!allowed) {
    // Paper rows aren't in LIVE_STATUSES, so a paper→live promotion isn't self-counted.
    const liveCount = await StrategyAdapter.countByCreatorStatuses(inboxId, LIVE_STATUSES);
    if (liveCount >= MAX_LIVE_STRATEGIES) {
      const others = await StrategyAdapter.getActiveByCreator(inboxId, strategyId);
      return {
        ok: false,
        error: `live strategy limit reached (${MAX_LIVE_STRATEGIES})`,
        blockedStrategy: others[0],
      };
    }
  }

  const wallet = await resolveCreatorExecutionWallet(inboxId);
  if (!wallet) {
    return { ok: false, error: "server wallets not configured — CDP keys missing" };
  }

  await StrategyAdapter.setExecutionWallet(
    strategyId,
    wallet.walletName,
    wallet.walletAddress,
    margin,
  );
  await StrategyAdapter.updateStatus(strategyId, "testing");
  if (!row.deployed_at) {
    await StrategyAdapter.markDeployed(strategyId);
  }
  logger.info(
    `strategy ${strategyId} deployed on ${wallet.walletName} (${wallet.walletAddress})`,
  );
  return { ok: true, walletName: wallet.walletName, walletAddress: wallet.walletAddress };
}

/**
 * Promote a paper strategy to live: settle its open virtual trades at the current
 * mark (so paper PnL doesn't leak into the live track record), then deploy live.
 */
export async function promotePaperToLive(
  strategyId: string,
  creatorInboxId?: string,
  collateralUsdc?: number,
): Promise<Awaited<ReturnType<typeof deployStrategy>>> {
  if (isStrategyLiveTradingPaused()) {
    return { ok: false, error: LIVE_TRADING_PAUSED_MESSAGE };
  }

  const row = await StrategyAdapter.getById(strategyId);
  if (!row) return { ok: false, error: "strategy not found" };

  if (row.status === "paper") {
    const markByPair = new Map<string, number>();
    for (const pair of row.config.pairs) {
      const mark = await fetchAvantisMarkPrice(pairBase(pair)).catch(() => null);
      if (mark != null && Number.isFinite(mark)) markByPair.set(pair, mark);
    }
    await closeAllPaperTrades(row, markByPair).catch((err) =>
      logger.warn(`paper close-before-live ${strategyId}: ${(err as Error).message}`),
    );
  }

  return deployStrategy(strategyId, creatorInboxId, collateralUsdc);
}
