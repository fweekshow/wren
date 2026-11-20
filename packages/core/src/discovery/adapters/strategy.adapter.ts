import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import { db } from "@/discovery/db.js";
import {
  platformBrainHistory,
  strategies,
  strategyFeeSettlements,
  strategyMarkBuffers,
  strategyTrades,
  strategyWikiHistory,
} from "@/db/schema/index.js";
import { clampToRails, type StrategyConfig, type StrategyId } from "@basemate/shared";

export type StrategyStatus =
  | "draft"
  | "paper"
  | "testing"
  | "publishable"
  | "published"
  | "archived";

export interface StrategyRow {
  id: string;
  name: string;
  creator_inbox_id: string;
  creator_wallet: string | null;
  creator_basename: string | null;
  prompt: string;
  config: StrategyConfig;
  status: StrategyStatus;
  execution_wallet_name: string | null;
  execution_wallet_address: string | null;
  default_collateral_usdc: number | null;
  featured: boolean;
  realized_pnl_usd: number;
  high_water_mark_usd: number;
  trade_count: number;
  max_drawdown_pct: number;
  days_live: number;
  deployed_at: Date | null;
  last_eval_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateStrategyInput {
  name: string;
  creatorInboxId: string;
  creatorWallet?: string | null;
  creatorBasename?: string | null;
  prompt: string;
  config: StrategyConfig;
}

export interface StrategyTradeInput {
  pair: string;
  side: "long" | "short";
  mode: StrategyId;
  txHash: string | null;
  collateralUsdc: number;
  pnlUsd: number;
  tradeIndex?: number | null;
  pairIndex?: number | null;
  openPrice?: string | null;
  entryRegime?: string | null;
}

/** Optional diagnostics recorded when a trade closes (Improve-flow inputs). */
export interface TradeCloseDiagnostics {
  exitReason?: "tp" | "sl" | "live_close" | "live_close_recovered" | null;
  closePrice?: number | null;
}

/** A closed trade row with the full diagnostic surface for wiki compilation. */
export interface StrategyClosedTradeRow {
  pair: string;
  side: "long" | "short";
  mode: string;
  pnl_usd: number;
  collateral_usdc: number;
  open_price: number | null;
  close_price: number | null;
  exit_reason: string | null;
  entry_regime: string | null;
  duration_s: number | null;
  max_favorable_move_pct: number | null;
  max_adverse_move_pct: number | null;
  is_paper: boolean;
  created_at: Date;
  closed_at: Date | null;
}

export interface StrategyTradeAttribution {
  wallet: string;
  pairIndex: number;
  tradeIndex: number;
  strategyId: string;
  strategyName: string;
  archived: boolean;
}

export interface StrategyPendingTradeRow {
  id: string;
  strategy_id: string;
  pair: string;
  side: string | null;
  pair_index: number | null;
  trade_index: number | null;
  wallet_address: string | null;
  last_unrealized_usd: number | null;
  created_at: Date;
}

export interface StrategyTradePnlRow {
  pair: string;
  side: "long" | "short";
  mode: string;
  pnl_usd: number;
  last_unrealized_usd: number | null;
  exit_reason: string | null;
  is_open: boolean;
  is_paper: boolean;
  created_at: Date;
}

/**
 * Prompt-a-Strategy drafts + execution metrics. Stores the raw user prompt alongside
 * the resolved config (the learning loop: correlate prompt -> config -> outcomes).
 */
export class StrategyAdapter {
  /** @deprecated Tables are now managed via Drizzle migrations. */
  static async createTable(): Promise<void> {}

  /** @deprecated Schema changes are now managed via Drizzle migrations. */
  static async migrateColumns(): Promise<void> {
    try {
      await db.query(`ALTER TABLE strategy_trades ADD COLUMN IF NOT EXISTS leverage NUMERIC`);
    } catch (error) {
      console.error("StrategyAdapter.migrateColumns leverage failed:", error);
    }

    // HWM seed data-fix: only runs once on first startup on upgraded installs.
    try {
      await db.query(`
        UPDATE strategies
        SET high_water_mark_usd = realized_pnl_usd
        WHERE high_water_mark_usd = 0
          AND realized_pnl_usd > 0
      `);
    } catch (error) {
      console.error("StrategyAdapter.migrateColumns HWM seed failed:", error);
    }
  }

  static async createDraft(input: CreateStrategyInput): Promise<StrategyRow | null> {
    try {
      const rows = await drizzleDb
        .insert(strategies)
        .values({
          name: input.name,
          creatorInboxId: input.creatorInboxId,
          creatorWallet: input.creatorWallet ?? null,
          creatorBasename: input.creatorBasename ?? null,
          prompt: input.prompt,
          config: input.config,
          status: "draft",
        })
        .returning();
      return rows[0] ? StrategyAdapter.mapDrizzleRow(rows[0]) : null;
    } catch (error) {
      console.error("StrategyAdapter.createDraft error:", error);
      return null;
    }
  }

  static async updateStatus(id: string, status: StrategyStatus): Promise<void> {
    try {
      await drizzleDb
        .update(strategies)
        .set({ status, updatedAt: sql`NOW()` })
        .where(eq(strategies.id, id));
    } catch (error) {
      console.error("StrategyAdapter.updateStatus error:", error);
    }
  }

  static async updateConfig(id: string, config: StrategyConfig, name?: string): Promise<void> {
    try {
      await drizzleDb
        .update(strategies)
        .set({
          config,
          name: name ? name : sql`${strategies.name}`,
          defaultCollateralUsdc: config.defaultCollateralUsdc
            ? String(config.defaultCollateralUsdc)
            : sql`${strategies.defaultCollateralUsdc}`,
          updatedAt: sql`NOW()`,
        })
        .where(eq(strategies.id, id));
    } catch (error) {
      console.error("StrategyAdapter.updateConfig error:", error);
    }
  }

  static async setExecutionWallet(
    id: string,
    walletName: string,
    walletAddress: string | null,
    collateralUsdc?: number,
  ): Promise<void> {
    try {
      await drizzleDb
        .update(strategies)
        .set({
          executionWalletName: walletName,
          executionWalletAddress: walletAddress
            ? walletAddress
            : sql`COALESCE(${strategies.executionWalletAddress}, ${walletAddress})`,
          defaultCollateralUsdc: collateralUsdc
            ? String(collateralUsdc)
            : sql`COALESCE(${strategies.defaultCollateralUsdc}, ${strategies.defaultCollateralUsdc})`,
          updatedAt: sql`NOW()`,
        })
        .where(eq(strategies.id, id));
    } catch (error) {
      console.error("StrategyAdapter.setExecutionWallet error:", error);
    }
  }

  static async markDeployed(id: string): Promise<void> {
    try {
      await drizzleDb
        .update(strategies)
        .set({ deployedAt: sql`NOW()`, updatedAt: sql`NOW()` })
        .where(eq(strategies.id, id));
    } catch (error) {
      console.error("StrategyAdapter.markDeployed error:", error);
    }
  }

  static async touchEval(id: string): Promise<void> {
    try {
      await drizzleDb
        .update(strategies)
        .set({ lastEvalAt: sql`NOW()`, updatedAt: sql`NOW()` })
        .where(eq(strategies.id, id));
    } catch (error) {
      console.error("StrategyAdapter.touchEval error:", error);
    }
  }

  static async recordTrade(id: string, trade: StrategyTradeInput): Promise<void> {
    try {
      const row = await drizzleDb.query.strategies.findFirst({
        columns: { executionWalletAddress: true },
        where: (s, { eq }) => eq(s.id, id),
      });
      const walletAddress = row?.executionWalletAddress ?? null;

      await drizzleDb.insert(strategyTrades).values({
        strategyId: id,
        pair: trade.pair,
        side: trade.side,
        mode: trade.mode,
        txHash: trade.txHash,
        collateralUsdc: String(trade.collateralUsdc),
        pnlUsd: String(trade.pnlUsd),
        tradeIndex: trade.tradeIndex ?? null,
        pairIndex: trade.pairIndex ?? null,
        openPrice: trade.openPrice ?? null,
        walletAddress,
        entryRegime: trade.entryRegime ?? null,
      });

      await drizzleDb
        .update(strategies)
        .set({
          tradeCount: sql`${strategies.tradeCount} + 1`,
          daysLive: sql`GREATEST(${strategies.daysLive}, EXTRACT(DAY FROM NOW() - COALESCE(${strategies.deployedAt}, ${strategies.createdAt}))::int)`,
          updatedAt: sql`NOW()`,
        })
        .where(eq(strategies.id, id));
    } catch (error) {
      console.error("StrategyAdapter.recordTrade error:", error);
    }
  }

  /** Open a virtual (paper) trade — no wallet, no on-chain calls. Returns the new trade id. */
  static async recordPaperTrade(
    strategyId: string,
    trade: {
      pair: string;
      side: "long" | "short";
      mode: StrategyId;
      collateralUsdc: number;
      leverage: number;
      openPrice: number;
      entryRegime?: string | null;
    },
  ): Promise<string | null> {
    try {
      const rows = await drizzleDb
        .insert(strategyTrades)
        .values({
          strategyId,
          pair: trade.pair,
          side: trade.side,
          mode: trade.mode,
          txHash: "paper",
          collateralUsdc: String(trade.collateralUsdc),
          leverage: String(trade.leverage),
          pnlUsd: "0",
          openPrice: String(trade.openPrice),
          isPaper: true,
          lastUnrealizedUsd: "0",
          entryRegime: trade.entryRegime ?? null,
        })
        .returning({ id: strategyTrades.id });

      await drizzleDb
        .update(strategies)
        .set({
          tradeCount: sql`${strategies.tradeCount} + 1`,
          daysLive: sql`GREATEST(${strategies.daysLive}, EXTRACT(DAY FROM NOW() - COALESCE(${strategies.deployedAt}, ${strategies.createdAt}))::int)`,
          updatedAt: sql`NOW()`,
        })
        .where(eq(strategies.id, strategyId));

      return rows[0]?.id ?? null;
    } catch (error) {
      console.error("StrategyAdapter.recordPaperTrade error:", error);
      return null;
    }
  }

  /** Open paper trades for a strategy (used to manage TP/SL + unrealized each tick). */
  /**
   * Returns true when a live (non-paper) position is already open for this
   * strategy + pair combination. Used by the executor as a guard against
   * duplicate opens when the runner ticks faster than Avantis settlement.
   */
  static async hasOpenLiveTrade(strategyId: string, pair: string): Promise<boolean> {
    try {
      const rows = await drizzleDb
        .select({ id: strategyTrades.id })
        .from(strategyTrades)
        .where(
          and(
            eq(strategyTrades.strategyId, strategyId),
            eq(strategyTrades.pair, pair),
            eq(strategyTrades.isPaper, false),
            isNull(strategyTrades.closedAt),
          ),
        )
        .limit(1);
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  static async listOpenPaperTrades(
    strategyId: string,
  ): Promise<Array<{ id: string; pair: string; side: "long" | "short"; collateral_usdc: number; leverage: number | null; open_price: number; created_at: Date | null }>> {
    try {
      const rows = await drizzleDb
        .select({
          id: strategyTrades.id,
          pair: strategyTrades.pair,
          side: strategyTrades.side,
          collateral_usdc: strategyTrades.collateralUsdc,
          leverage: strategyTrades.leverage,
          open_price: strategyTrades.openPrice,
          created_at: strategyTrades.createdAt,
        })
        .from(strategyTrades)
        .where(
          and(
            eq(strategyTrades.strategyId, strategyId),
            eq(strategyTrades.isPaper, true),
            isNull(strategyTrades.closedAt),
          ),
        )
        .orderBy(asc(strategyTrades.createdAt));

      return rows
        .map((row) => ({
          id: String(row.id),
          pair: String(row.pair),
          side: (String(row.side) === "short" ? "short" : "long") as "long" | "short",
          collateral_usdc: Number(row.collateral_usdc ?? 0),
          leverage: row.leverage != null ? Number(row.leverage) : null,
          open_price: Number(row.open_price ?? 0),
          created_at: (row.created_at as Date) ?? null,
        }))
        .filter((t) => t.open_price > 0);
    } catch (error) {
      console.error("StrategyAdapter.listOpenPaperTrades error:", error);
      return [];
    }
  }

  /** Count a creator's strategies in the given statuses (cap enforcement). */
  static async countByCreatorStatuses(inboxId: string, statuses: StrategyStatus[]): Promise<number> {
    try {
      const res = await db.query(
        `SELECT COUNT(*)::int AS count FROM strategies
         WHERE creator_inbox_id = $1 AND status = ANY($2::text[])`,
        [inboxId, statuses],
      );
      return Number(res.rows[0]?.count ?? 0);
    } catch (error) {
      console.error("StrategyAdapter.countByCreatorStatuses error:", error);
      return 0;
    }
  }

  /** Close all still-open paper trades for a strategy at the given realized PnL each. */
  static async closeOpenPaperTrades(
    strategyId: string,
    realizedByTradeId: Map<string, number>,
  ): Promise<void> {
    for (const [tradeId, pnl] of realizedByTradeId) {
      await StrategyAdapter.closeTrade(tradeId, pnl);
    }
    await StrategyAdapter.recomputeRealizedPnl(strategyId);
  }

  /** Distinct strategy ids whose live (on-chain) trades execute from this wallet. */
  static async listStrategyIdsForWallet(wallet: string): Promise<string[]> {
    try {
      const res = await db.query(
        `SELECT DISTINCT s.id
         FROM strategies s
         LEFT JOIN strategy_trades st ON st.strategy_id = s.id
         WHERE LOWER(COALESCE(st.wallet_address, s.execution_wallet_address)) = LOWER($1)`,
        [wallet],
      );
      return res.rows
        .map((row: Record<string, unknown>) => (row.id ? String(row.id) : null))
        .filter((id): id is string => Boolean(id));
    } catch (error) {
      console.error("StrategyAdapter.listStrategyIdsForWallet error:", error);
      return [];
    }
  }

  static async listPendingTradesForWallet(wallet: string): Promise<StrategyPendingTradeRow[]> {
    try {
      const res = await db.query(
        `SELECT st.id, st.strategy_id, st.pair, st.side, st.pair_index, st.trade_index,
                st.wallet_address, st.last_unrealized_usd, st.created_at
         FROM strategy_trades st
         JOIN strategies s ON s.id = st.strategy_id
         WHERE LOWER(COALESCE(st.wallet_address, s.execution_wallet_address)) = LOWER($1)
           AND st.closed_at IS NULL
         ORDER BY st.created_at ASC`,
        [wallet],
      );
      return res.rows.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        strategy_id: String(row.strategy_id),
        pair: String(row.pair ?? ""),
        side: row.side ? String(row.side) : null,
        pair_index: row.pair_index != null ? Number(row.pair_index) : null,
        trade_index: row.trade_index != null ? Number(row.trade_index) : null,
        wallet_address: row.wallet_address ? String(row.wallet_address) : null,
        last_unrealized_usd:
          row.last_unrealized_usd != null ? Number(row.last_unrealized_usd) : null,
        created_at: new Date(String(row.created_at)),
      }));
    } catch (error) {
      console.error("StrategyAdapter.listPendingTradesForWallet error:", error);
      return [];
    }
  }

  /** Back-fill null pair_index / trade_index on a trade whose slot was recovered from Avantis. */
  static async updateTradeSlotIndices(
    tradeId: string,
    pairIndex: number,
    tradeIndex: number,
  ): Promise<void> {
    try {
      await drizzleDb
        .update(strategyTrades)
        .set({ pairIndex, tradeIndex })
        .where(and(eq(strategyTrades.id, tradeId), isNull(strategyTrades.closedAt)));
    } catch (error) {
      console.error("StrategyAdapter.updateTradeSlotIndices error:", error);
    }
  }

  /**
   * Mark an open trade to market. Folds the favorable/adverse move high-water
   * marks into the same UPDATE so we don't add extra writes to the per-tick hot path.
   */
  static async updateTradeUnrealized(
    tradeId: string,
    unrealizedUsd: number,
    walletAddress?: string,
    moves?: { favorablePct?: number | null; adversePct?: number | null },
  ): Promise<void> {
    try {
      await drizzleDb
        .update(strategyTrades)
        .set({
          lastUnrealizedUsd: String(unrealizedUsd),
          walletAddress: walletAddress
            ? sql`COALESCE(${strategyTrades.walletAddress}, ${walletAddress})`
            : sql`${strategyTrades.walletAddress}`,
          maxFavorableMovePct: sql`GREATEST(COALESCE(${strategyTrades.maxFavorableMovePct}, 0), ${String(moves?.favorablePct ?? 0)})`,
          maxAdverseMovePct: sql`GREATEST(COALESCE(${strategyTrades.maxAdverseMovePct}, 0), ${String(moves?.adversePct ?? 0)})`,
        })
        .where(and(eq(strategyTrades.id, tradeId), isNull(strategyTrades.closedAt)));
    } catch (error) {
      console.error("StrategyAdapter.updateTradeUnrealized error:", error);
    }
  }

  static async closeTrade(
    tradeId: string,
    realizedUsd: number,
    diagnostics?: TradeCloseDiagnostics,
  ): Promise<void> {
    try {
      await drizzleDb
        .update(strategyTrades)
        .set({
          pnlUsd: String(realizedUsd),
          closedAt: sql`COALESCE(${strategyTrades.closedAt}, NOW())`,
          lastUnrealizedUsd: null,
          exitReason: diagnostics?.exitReason
            ? diagnostics.exitReason
            : sql`COALESCE(${strategyTrades.exitReason}, ${diagnostics?.exitReason ?? null})`,
          closePrice: diagnostics?.closePrice != null
            ? String(diagnostics.closePrice)
            : sql`COALESCE(${strategyTrades.closePrice}, ${diagnostics?.closePrice ?? null})`,
          durationS: sql`COALESCE(${strategyTrades.durationS}, EXTRACT(EPOCH FROM (NOW() - ${strategyTrades.createdAt}))::int)`,
        })
        .where(eq(strategyTrades.id, tradeId));
    } catch (error) {
      console.error("StrategyAdapter.closeTrade error:", error);
    }
  }

  static async setTradeRealizedPnl(tradeId: string, pnlUsd: number): Promise<void> {
    try {
      await drizzleDb
        .update(strategyTrades)
        .set({
          pnlUsd: String(pnlUsd),
          closedAt: sql`COALESCE(${strategyTrades.closedAt}, NOW())`,
        })
        .where(eq(strategyTrades.id, tradeId));
    } catch (error) {
      console.error("StrategyAdapter.setTradeRealizedPnl error:", error);
    }
  }

  /** Most recent closed trades with the full diagnostic surface (for wiki compilation). */
  static async listClosedTrades(
    strategyId: string,
    limit = 20,
  ): Promise<StrategyClosedTradeRow[]> {
    try {
      const rows = await drizzleDb
        .select({
          pair: strategyTrades.pair,
          side: strategyTrades.side,
          mode: strategyTrades.mode,
          pnl_usd: strategyTrades.pnlUsd,
          collateral_usdc: strategyTrades.collateralUsdc,
          open_price: strategyTrades.openPrice,
          close_price: strategyTrades.closePrice,
          exit_reason: strategyTrades.exitReason,
          entry_regime: strategyTrades.entryRegime,
          duration_s: strategyTrades.durationS,
          max_favorable_move_pct: strategyTrades.maxFavorableMovePct,
          max_adverse_move_pct: strategyTrades.maxAdverseMovePct,
          is_paper: strategyTrades.isPaper,
          created_at: strategyTrades.createdAt,
          closed_at: strategyTrades.closedAt,
        })
        .from(strategyTrades)
        .where(
          and(eq(strategyTrades.strategyId, strategyId), isNotNull(strategyTrades.closedAt)),
        )
        .orderBy(desc(strategyTrades.closedAt))
        .limit(limit);

      return rows.map((row) => ({
        pair: String(row.pair),
        side: (String(row.side) === "short" ? "short" : "long") as "long" | "short",
        mode: String(row.mode),
        pnl_usd: Number(row.pnl_usd ?? 0),
        collateral_usdc: Number(row.collateral_usdc ?? 0),
        open_price: row.open_price != null ? Number(row.open_price) : null,
        close_price: row.close_price != null ? Number(row.close_price) : null,
        exit_reason: row.exit_reason ?? null,
        entry_regime: row.entry_regime ?? null,
        duration_s: row.duration_s ?? null,
        max_favorable_move_pct: row.max_favorable_move_pct != null ? Number(row.max_favorable_move_pct) : null,
        max_adverse_move_pct: row.max_adverse_move_pct != null ? Number(row.max_adverse_move_pct) : null,
        is_paper: Boolean(row.is_paper),
        created_at: row.created_at as Date,
        closed_at: (row.closed_at as Date) ?? null,
      }));
    } catch (error) {
      console.error("StrategyAdapter.listClosedTrades error:", error);
      return [];
    }
  }

  // ── Per-strategy wiki (Improve flow) ───────────────────────────────────────

  static async setWikiDirty(strategyId: string, dirty: boolean): Promise<void> {
    try {
      await drizzleDb
        .update(strategies)
        .set({ wikiDirty: dirty })
        .where(eq(strategies.id, strategyId));
    } catch (error) {
      console.error("StrategyAdapter.setWikiDirty error:", error);
    }
  }

  static async listWikiDirtyStrategyIds(limit = 25): Promise<string[]> {
    try {
      const rows = await drizzleDb
        .select({ id: strategies.id })
        .from(strategies)
        .where(and(eq(strategies.wikiDirty, true), ne(strategies.status, "archived")))
        .orderBy(asc(strategies.updatedAt))
        .limit(limit);
      return rows.map((r) => String(r.id));
    } catch (error) {
      console.error("StrategyAdapter.listWikiDirtyStrategyIds error:", error);
      return [];
    }
  }

  static async getLatestWiki(strategyId: string): Promise<string | null> {
    try {
      const row = await drizzleDb.query.strategyWikiHistory.findFirst({
        columns: { content: true },
        where: (w, { eq }) => eq(w.strategyId, strategyId),
        orderBy: (w, { desc }) => [desc(w.compiledAt)],
      });
      return row?.content ?? null;
    } catch (error) {
      console.error("StrategyAdapter.getLatestWiki error:", error);
      return null;
    }
  }

  /** Append a new wiki version (append-only) and prune to the latest `keep` rows. */
  static async appendWiki(strategyId: string, content: string, keep = 10): Promise<void> {
    try {
      await drizzleDb.insert(strategyWikiHistory).values({ strategyId, content });
      // Prune via raw SQL (Drizzle doesn't support DELETE with subquery LIMIT well).
      await db.query(
        `DELETE FROM strategy_wiki_history
         WHERE strategy_id = $1
           AND id NOT IN (
             SELECT id FROM strategy_wiki_history
             WHERE strategy_id = $1
             ORDER BY compiled_at DESC
             LIMIT $2
           )`,
        [strategyId, keep],
      );
    } catch (error) {
      console.error("StrategyAdapter.appendWiki error:", error);
    }
  }

  // ── Platform meta-brain ────────────────────────────────────────────────────

  static async getLatestPlatformBrain(): Promise<string | null> {
    try {
      const row = await drizzleDb.query.platformBrainHistory.findFirst({
        columns: { content: true },
        orderBy: (p, { desc }) => [desc(p.compiledAt)],
      });
      return row?.content ?? null;
    } catch (error) {
      console.error("StrategyAdapter.getLatestPlatformBrain error:", error);
      return null;
    }
  }

  static async appendPlatformBrain(
    content: string,
    meta: { strategyCount: number; tradeCount: number },
    keep = 5,
  ): Promise<void> {
    try {
      await drizzleDb.insert(platformBrainHistory).values({
        content,
        strategyCount: meta.strategyCount,
        tradeCount: meta.tradeCount,
      });
      await db.query(
        `DELETE FROM platform_brain_history
         WHERE id NOT IN (
           SELECT id FROM platform_brain_history ORDER BY compiled_at DESC LIMIT $1
         )`,
        [keep],
      );
    } catch (error) {
      console.error("StrategyAdapter.appendPlatformBrain error:", error);
    }
  }

  static async listStrategiesWithClosedTrades(): Promise<string[]> {
    try {
      const res = await db.query(
        `SELECT DISTINCT strategy_id FROM strategy_trades WHERE closed_at IS NOT NULL`,
      );
      return res.rows.map((r: Record<string, unknown>) => String(r.strategy_id));
    } catch (error) {
      console.error("StrategyAdapter.listStrategiesWithClosedTrades error:", error);
      return [];
    }
  }

  static async countClosedTrades(): Promise<number> {
    try {
      const res = await db.query(
        `SELECT COUNT(*)::int AS count FROM strategy_trades WHERE closed_at IS NOT NULL`,
      );
      return Number(res.rows[0]?.count ?? 0);
    } catch (error) {
      console.error("StrategyAdapter.countClosedTrades error:", error);
      return 0;
    }
  }

  static async listTradesNeedingReconcile(
    wallet: string,
    graceMinutes = 15,
  ): Promise<
    Array<{
      id: string;
      strategy_id: string;
      tx_hash: string | null;
      collateral_usdc: number;
      created_at: Date;
      is_open: boolean;
    }>
  > {
    try {
      const res = await db.query(
        `SELECT st.id, st.strategy_id, st.tx_hash, st.collateral_usdc, st.created_at,
                (st.closed_at IS NULL) AS is_open
         FROM strategy_trades st
         JOIN strategies s ON s.id = st.strategy_id
         WHERE LOWER(COALESCE(st.wallet_address, s.execution_wallet_address)) = LOWER($1)
           AND st.is_paper = FALSE
           AND st.tx_hash IS NOT NULL
           AND (
             (st.closed_at IS NOT NULL AND st.pnl_reconciled = FALSE)
             OR (st.closed_at IS NULL AND st.created_at < NOW() - ($2 || ' minutes')::interval)
           )
         ORDER BY st.created_at ASC`,
        [wallet, String(graceMinutes)],
      );
      return res.rows.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        strategy_id: String(row.strategy_id),
        tx_hash: row.tx_hash ? String(row.tx_hash) : null,
        collateral_usdc: Number(row.collateral_usdc ?? 0),
        created_at: new Date(String(row.created_at)),
        is_open: Boolean(row.is_open),
      }));
    } catch (error) {
      console.error("StrategyAdapter.listTradesNeedingReconcile error:", error);
      return [];
    }
  }

  static async markTradeReconciled(tradeId: string, netPnlUsd: number): Promise<void> {
    try {
      await drizzleDb
        .update(strategyTrades)
        .set({
          pnlUsd: String(netPnlUsd),
          pnlReconciled: true,
          closedAt: sql`COALESCE(${strategyTrades.closedAt}, NOW())`,
          exitReason: sql`COALESCE(${strategyTrades.exitReason}, 'reconciled')`,
          lastUnrealizedUsd: null,
          durationS: sql`COALESCE(${strategyTrades.durationS}, EXTRACT(EPOCH FROM (NOW() - ${strategyTrades.createdAt}))::int)`,
        })
        .where(eq(strategyTrades.id, tradeId));
    } catch (error) {
      console.error("StrategyAdapter.markTradeReconciled error:", error);
    }
  }

  static async listClosedTradesNeedingPnlBackfill(
    wallet: string,
  ): Promise<
    Array<{
      id: string;
      strategy_id: string;
      tx_hash: string | null;
      collateral_usdc: number;
      created_at: Date;
    }>
  > {
    try {
      const res = await db.query(
        `SELECT st.id, st.strategy_id, st.tx_hash, st.collateral_usdc, st.created_at
         FROM strategy_trades st
         JOIN strategies s ON s.id = st.strategy_id
         WHERE LOWER(COALESCE(st.wallet_address, s.execution_wallet_address)) = LOWER($1)
           AND st.closed_at IS NOT NULL
           AND COALESCE(st.pnl_usd, 0) = 0
           AND st.pair_index IS NOT NULL
         ORDER BY st.created_at ASC`,
        [wallet],
      );
      return res.rows.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        strategy_id: String(row.strategy_id),
        tx_hash: row.tx_hash ? String(row.tx_hash) : null,
        collateral_usdc: Number(row.collateral_usdc ?? 0),
        created_at: new Date(String(row.created_at)),
      }));
    } catch (error) {
      console.error("StrategyAdapter.listClosedTradesNeedingPnlBackfill error:", error);
      return [];
    }
  }

  /**
   * Sum of realized PnL for live trades that are fully reconciled against the
   * on-chain USDC flows. This is the ONLY basis for the performance fee: the
   * high-water mark must never advance on an interim/estimated close, only on a
   * reconciled net result. Returns 0 when nothing is reconciled yet.
   */
  static async getReconciledRealizedPnlUsd(strategyId: string): Promise<number> {
    try {
      const res = await db.query<{ sum: string | null }>(
        `SELECT COALESCE(SUM(pnl_usd), 0)::text AS sum
         FROM strategy_trades
         WHERE strategy_id = $1
           AND is_paper = FALSE
           AND closed_at IS NOT NULL
           AND pnl_reconciled = TRUE`,
        [strategyId],
      );
      return Number(res.rows[0]?.sum ?? 0);
    } catch (error) {
      console.error("StrategyAdapter.getReconciledRealizedPnlUsd error:", error);
      return 0;
    }
  }

  /**
   * Sum of realized PnL for live trades closed since UTC midnight. Used by the
   * pre-entry risk gate to enforce the daily drawdown stop. Losses are negative.
   */
  static async getTodayRealizedPnlUsd(strategyId: string): Promise<number> {
    try {
      const res = await db.query<{ sum: string | null }>(
        `SELECT COALESCE(SUM(pnl_usd), 0)::text AS sum
         FROM strategy_trades
         WHERE strategy_id = $1
           AND is_paper = FALSE
           AND closed_at IS NOT NULL
           AND closed_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
        [strategyId],
      );
      return Number(res.rows[0]?.sum ?? 0);
    } catch (error) {
      console.error("StrategyAdapter.getTodayRealizedPnlUsd error:", error);
      return 0;
    }
  }

  /** Count trade opens (paper + live) since UTC midnight — entry frequency guardrail. */
  static async countTodayEntries(strategyId: string): Promise<number> {
    try {
      const res = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM strategy_trades
         WHERE strategy_id = $1
           AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
        [strategyId],
      );
      return Number(res.rows[0]?.count ?? 0);
    } catch (error) {
      console.error("StrategyAdapter.countTodayEntries error:", error);
      return 0;
    }
  }

  /** Most recent open time for a pair on this strategy (paper or live). */
  static async getLastEntryAt(strategyId: string, pair: string): Promise<Date | null> {
    try {
      const res = await db.query<{ created_at: Date | null }>(
        `SELECT created_at
         FROM strategy_trades
         WHERE strategy_id = $1 AND pair = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [strategyId, pair],
      );
      return res.rows[0]?.created_at ?? null;
    } catch (error) {
      console.error("StrategyAdapter.getLastEntryAt error:", error);
      return null;
    }
  }

  static async recomputeRealizedPnl(strategyId: string): Promise<void> {
    try {
      await db.query(
        `UPDATE strategies s SET
           realized_pnl_usd = COALESCE((
             SELECT SUM(pnl_usd) FROM strategy_trades
             WHERE strategy_id = s.id AND closed_at IS NOT NULL AND is_paper = FALSE
           ), 0),
           updated_at = NOW()
         WHERE s.id = $1`,
        [strategyId],
      );
    } catch (error) {
      console.error("StrategyAdapter.recomputeRealizedPnl error:", error);
    }
  }

  static async getHighWaterMark(strategyId: string): Promise<number> {
    try {
      const row = await drizzleDb.query.strategies.findFirst({
        columns: { highWaterMarkUsd: true },
        where: (s, { eq }) => eq(s.id, strategyId),
      });
      return Number(row?.highWaterMarkUsd ?? 0);
    } catch (error) {
      console.error("StrategyAdapter.getHighWaterMark error:", error);
      return 0;
    }
  }

  static async setHighWaterMark(strategyId: string, hwm: number): Promise<void> {
    // Intentionally does NOT swallow errors — settleCreatorStrategyProfitFee
    // calls this BEFORE the USDC transfer. If the write fails we must throw.
    await drizzleDb
      .update(strategies)
      .set({ highWaterMarkUsd: String(hwm), updatedAt: sql`NOW()` })
      .where(eq(strategies.id, strategyId));
  }

  static async recordFeeSettlement(input: {
    strategyId: string;
    feeUsd: number;
    profitIncrementUsd: number;
    hwmAfter: number;
    txHash: string | null;
  }): Promise<void> {
    try {
      await drizzleDb.insert(strategyFeeSettlements).values({
        strategyId: input.strategyId,
        feeUsd: String(input.feeUsd),
        profitIncrementUsd: String(input.profitIncrementUsd),
        hwmAfter: String(input.hwmAfter),
        txHash: input.txHash,
      });
    } catch (error) {
      console.error("StrategyAdapter.recordFeeSettlement error:", error);
    }
  }

  static async setRealizedPnl(strategyId: string, realizedUsd: number): Promise<void> {
    try {
      await drizzleDb
        .update(strategies)
        .set({ realizedPnlUsd: String(realizedUsd), updatedAt: sql`NOW()` })
        .where(eq(strategies.id, strategyId));
    } catch (error) {
      console.error("StrategyAdapter.setRealizedPnl error:", error);
    }
  }

  static async listExecutionWalletsForCreator(
    inboxId: string,
    statuses: string[],
  ): Promise<string[]> {
    try {
      const res = await db.query(
        `SELECT DISTINCT execution_wallet_address AS wallet
         FROM strategies
         WHERE creator_inbox_id = $1
           AND status = ANY($2::text[])
           AND execution_wallet_address IS NOT NULL`,
        [inboxId, statuses],
      );
      return res.rows
        .map((row: { wallet?: string }) => row.wallet)
        .filter((w): w is string => typeof w === "string" && /^0x[a-fA-F0-9]{40}$/.test(w));
    } catch (error) {
      console.error("StrategyAdapter.listExecutionWalletsForCreator error:", error);
      return [];
    }
  }

  static async listExecutionWalletTargetsForCreator(
    inboxId: string,
    statuses: string[],
  ): Promise<Array<{ walletAddress: string; walletName: string | null }>> {
    try {
      const res = await db.query(
        `SELECT DISTINCT ON (execution_wallet_address)
           execution_wallet_address,
           execution_wallet_name
         FROM strategies
         WHERE creator_inbox_id = $1
           AND status = ANY($2::text[])
           AND execution_wallet_address IS NOT NULL
         ORDER BY execution_wallet_address, deployed_at DESC NULLS LAST, created_at DESC`,
        [inboxId, statuses],
      );
      return res.rows
        .map((row: Record<string, unknown>) => ({
          walletAddress: String(row.execution_wallet_address),
          walletName: row.execution_wallet_name ? String(row.execution_wallet_name) : null,
        }))
        .filter((row) => /^0x[a-fA-F0-9]{40}$/.test(row.walletAddress));
    } catch (error) {
      console.error("StrategyAdapter.listExecutionWalletTargetsForCreator error:", error);
      return [];
    }
  }

  static async summarizeTradePnl(
    strategyId: string,
    openPnlBySlot: Map<string, number>,
    opts: { paperOnly?: boolean } = {},
  ): Promise<{
    realized: number;
    unrealized: number;
    openCount: number;
    closedCount: number;
    wins: number;
    losses: number;
    total: number;
  }> {
    try {
      const filter =
        opts.paperOnly === undefined
          ? ""
          : ` AND is_paper = ${opts.paperOnly ? "TRUE" : "FALSE"}`;
      const res = await db.query(
        `SELECT pair_index, trade_index, pnl_usd, closed_at, last_unrealized_usd
         FROM strategy_trades
         WHERE strategy_id = $1${filter}
         ORDER BY created_at ASC`,
        [strategyId],
      );

      let realized = 0;
      let unrealized = 0;
      let openCount = 0;
      let closedCount = 0;
      let wins = 0;
      let losses = 0;

      for (const row of res.rows as Array<Record<string, unknown>>) {
        const pairIndex = row.pair_index != null ? Number(row.pair_index) : null;
        const tradeIndex = row.trade_index != null ? Number(row.trade_index) : null;
        const closed = row.closed_at != null;

        if (closed) {
          const pnl = Number(row.pnl_usd ?? 0);
          realized += pnl;
          closedCount += 1;
          if (pnl > 0) wins += 1;
          else if (pnl < 0) losses += 1;
          continue;
        }

        openCount += 1;
        let slotPnl: number | null = null;
        if (pairIndex != null && tradeIndex != null) {
          slotPnl = openPnlBySlot.get(`${pairIndex}:${tradeIndex}`) ?? null;
        }
        if (slotPnl == null && row.last_unrealized_usd != null) {
          slotPnl = Number(row.last_unrealized_usd);
        }
        if (slotPnl != null && Number.isFinite(slotPnl)) {
          unrealized += slotPnl;
        }
      }

      return { realized, unrealized, openCount, closedCount, wins, losses, total: realized + unrealized };
    } catch (error) {
      console.error("StrategyAdapter.summarizeTradePnl error:", error);
      return { realized: 0, unrealized: 0, openCount: 0, closedCount: 0, wins: 0, losses: 0, total: 0 };
    }
  }

  static async listTradePnlRows(
    strategyId: string,
    opts: { paperOnly?: boolean } = {},
  ): Promise<StrategyTradePnlRow[]> {
    try {
      const filter =
        opts.paperOnly === undefined
          ? ""
          : ` AND is_paper = ${opts.paperOnly ? "TRUE" : "FALSE"}`;
      const res = await db.query(
        `SELECT pair, side, mode, pnl_usd, last_unrealized_usd, exit_reason,
                closed_at IS NULL AS is_open, is_paper, created_at
         FROM strategy_trades
         WHERE strategy_id = $1${filter}
         ORDER BY created_at ASC`,
        [strategyId],
      );

      return res.rows.map((row: Record<string, unknown>) => ({
        pair: String(row.pair),
        side: (String(row.side) === "short" ? "short" : "long") as "long" | "short",
        mode: String(row.mode),
        pnl_usd: Number(row.pnl_usd ?? 0),
        last_unrealized_usd:
          row.last_unrealized_usd != null ? Number(row.last_unrealized_usd) : null,
        exit_reason: row.exit_reason != null ? String(row.exit_reason) : null,
        is_open: Boolean(row.is_open),
        is_paper: Boolean(row.is_paper),
        created_at: new Date(String(row.created_at)),
      }));
    } catch (error) {
      console.error("StrategyAdapter.listTradePnlRows error:", error);
      return [];
    }
  }

  static async listOpenTradeAttributions(
    walletAddresses: string[],
  ): Promise<StrategyTradeAttribution[]> {
    const wallets = walletAddresses
      .filter((w) => /^0x[a-fA-F0-9]{40}$/.test(w))
      .map((w) => w.toLowerCase());
    if (wallets.length === 0) return [];

    try {
      const res = await db.query(
        `SELECT DISTINCT ON (LOWER(COALESCE(st.wallet_address, s.execution_wallet_address)), st.pair_index, st.trade_index)
           LOWER(COALESCE(st.wallet_address, s.execution_wallet_address)) AS wallet,
           st.pair_index,
           st.trade_index,
           s.id AS strategy_id,
           s.name AS strategy_name,
           s.status
         FROM strategy_trades st
         JOIN strategies s ON s.id = st.strategy_id
         WHERE LOWER(COALESCE(st.wallet_address, s.execution_wallet_address)) = ANY($1::text[])
           AND st.trade_index IS NOT NULL
           AND st.pair_index IS NOT NULL
           AND st.closed_at IS NULL
         ORDER BY LOWER(COALESCE(st.wallet_address, s.execution_wallet_address)), st.pair_index, st.trade_index, st.created_at DESC`,
        [wallets],
      );
      return res.rows.map((row: Record<string, unknown>) => ({
        wallet: String(row.wallet),
        pairIndex: Number(row.pair_index),
        tradeIndex: Number(row.trade_index),
        strategyId: String(row.strategy_id),
        strategyName: String(row.strategy_name),
        archived: row.status === "archived",
      }));
    } catch (error) {
      console.error("StrategyAdapter.listOpenTradeAttributions error:", error);
      return [];
    }
  }

  static async setFeatured(id: string, featured: boolean): Promise<void> {
    try {
      await drizzleDb
        .update(strategies)
        .set({ featured, updatedAt: sql`NOW()` })
        .where(eq(strategies.id, id));
    } catch (error) {
      console.error("StrategyAdapter.setFeatured error:", error);
    }
  }

  static async getById(id: string): Promise<StrategyRow | null> {
    try {
      const row = await drizzleDb.query.strategies.findFirst({
        where: (s, { eq }) => eq(s.id, id),
      });
      return row ? StrategyAdapter.mapDrizzleRow(row) : null;
    } catch (error) {
      console.error("StrategyAdapter.getById error:", error);
      return null;
    }
  }

  static async getExistingExecutionWallet(
    inboxId: string,
  ): Promise<{ walletName: string; walletAddress: string | null } | null> {
    try {
      const res = await db.query(
        `SELECT execution_wallet_name, execution_wallet_address
         FROM strategies
         WHERE creator_inbox_id = $1
           AND execution_wallet_name LIKE 'cp-%'
           AND execution_wallet_address IS NOT NULL
         GROUP BY execution_wallet_name, execution_wallet_address
         ORDER BY COUNT(*) DESC, MIN(created_at) ASC
         LIMIT 1`,
        [inboxId],
      );
      const row = res.rows[0];
      if (!row?.execution_wallet_name) return null;
      return {
        walletName: String(row.execution_wallet_name),
        walletAddress: row.execution_wallet_address ? String(row.execution_wallet_address) : null,
      };
    } catch (error) {
      console.error("StrategyAdapter.getExistingExecutionWallet error:", error);
      return null;
    }
  }

  static async listByCreator(inboxId: string, limit = 20): Promise<StrategyRow[]> {
    try {
      const rows = await drizzleDb
        .select()
        .from(strategies)
        .where(eq(strategies.creatorInboxId, inboxId))
        .orderBy(desc(strategies.createdAt))
        .limit(limit);
      return rows.map((r) => StrategyAdapter.mapDrizzleRow(r));
    } catch (error) {
      console.error("StrategyAdapter.listByCreator error:", error);
      return [];
    }
  }

  static async listByCreatorStatuses(
    inboxId: string,
    statuses: StrategyStatus[],
    limit = 30,
  ): Promise<StrategyRow[]> {
    try {
      const rows = await drizzleDb
        .select()
        .from(strategies)
        .where(and(eq(strategies.creatorInboxId, inboxId), inArray(strategies.status, statuses)))
        .orderBy(desc(strategies.createdAt))
        .limit(limit);
      const mapped = rows.map((r) => StrategyAdapter.mapDrizzleRow(r));
      if (!statuses.includes("paper") || mapped.length === 0) return mapped;

      // Paper PnL is intentionally excluded from realized_pnl_usd for live stats;
      // compute it on read for paper strategy lists.
      const paperIds = mapped.filter((r) => r.status === "paper").map((r) => r.id);
      if (paperIds.length === 0) return mapped;
      const paperPnlRows = await drizzleDb
        .select({
          strategyId: strategyTrades.strategyId,
          pnlUsd: sql<string>`COALESCE(SUM(${strategyTrades.pnlUsd}), 0)`,
        })
        .from(strategyTrades)
        .where(
          and(
            inArray(strategyTrades.strategyId, paperIds),
            isNotNull(strategyTrades.closedAt),
            eq(strategyTrades.isPaper, true),
          ),
        )
        .groupBy(strategyTrades.strategyId);
      const paperPnlById = new Map(paperPnlRows.map((r) => [String(r.strategyId), Number(r.pnlUsd ?? 0)]));
      return mapped.map((r) =>
        r.status === "paper" ? { ...r, realized_pnl_usd: paperPnlById.get(r.id) ?? 0 } : r,
      );
    } catch (error) {
      console.error("StrategyAdapter.listByCreatorStatuses error:", error);
      return [];
    }
  }

  static async countActiveByCreator(inboxId: string, excludeId?: string): Promise<number> {
    try {
      const res = await db.query(
        `SELECT COUNT(*)::int AS count FROM strategies
         WHERE creator_inbox_id = $1
           AND status IN ('testing', 'publishable', 'published')
           AND ($2::uuid IS NULL OR id != $2)`,
        [inboxId, excludeId ?? null],
      );
      return Number(res.rows[0]?.count ?? 0);
    } catch (error) {
      console.error("StrategyAdapter.countActiveByCreator error:", error);
      return 0;
    }
  }

  static async getActiveByCreator(inboxId: string, excludeId?: string): Promise<StrategyRow[]> {
    try {
      const res = await db.query(
        `SELECT * FROM strategies
         WHERE creator_inbox_id = $1
           AND status IN ('testing', 'publishable', 'published')
           AND ($2::uuid IS NULL OR id != $2)
         ORDER BY deployed_at DESC NULLS LAST, created_at DESC`,
        [inboxId, excludeId ?? null],
      );
      return res.rows.map((r: unknown) => StrategyAdapter.mapRow(r));
    } catch (error) {
      console.error("StrategyAdapter.getActiveByCreator error:", error);
      return [];
    }
  }

  static async listActiveForEval(): Promise<StrategyRow[]> {
    try {
      const rows = await drizzleDb
        .select()
        .from(strategies)
        .where(inArray(strategies.status, ["paper", "testing", "publishable", "published"]))
        .orderBy(asc(strategies.lastEvalAt), asc(strategies.createdAt))
        .limit(50);
      return rows.map((r) => StrategyAdapter.mapDrizzleRow(r));
    } catch (error) {
      console.error("StrategyAdapter.listActiveForEval error:", error);
      return [];
    }
  }

  static async listFeatured(limit = 10): Promise<StrategyRow[]> {
    try {
      const rows = await drizzleDb
        .select()
        .from(strategies)
        .where(
          and(
            eq(strategies.featured, true),
            inArray(strategies.status, ["publishable", "published"]),
          ),
        )
        .orderBy(desc(strategies.realizedPnlUsd), desc(strategies.tradeCount))
        .limit(limit);
      return rows.map((r) => StrategyAdapter.mapDrizzleRow(r));
    } catch (error) {
      console.error("StrategyAdapter.listFeatured error:", error);
      return [];
    }
  }

  static async listLeaderboard(limit = 20): Promise<StrategyRow[]> {
    try {
      const rows = await drizzleDb
        .select()
        .from(strategies)
        .where(inArray(strategies.status, ["publishable", "published"]))
        .orderBy(desc(strategies.realizedPnlUsd), desc(strategies.tradeCount))
        .limit(limit);
      return rows.map((r) => StrategyAdapter.mapDrizzleRow(r));
    } catch (error) {
      console.error("StrategyAdapter.listLeaderboard error:", error);
      return [];
    }
  }

  /** Map a Drizzle query result row to the public StrategyRow interface. */
  private static mapDrizzleRow(row: typeof strategies.$inferSelect): StrategyRow {
    return {
      id: String(row.id),
      name: row.name,
      creator_inbox_id: row.creatorInboxId,
      creator_wallet: row.creatorWallet ?? null,
      creator_basename: row.creatorBasename ?? null,
      prompt: row.prompt,
      config: clampToRails(
        typeof row.config === "string" ? JSON.parse(row.config as string) : (row.config as StrategyConfig),
      ),
      status: row.status as StrategyStatus,
      execution_wallet_name: row.executionWalletName ?? null,
      execution_wallet_address: row.executionWalletAddress ?? null,
      default_collateral_usdc: row.defaultCollateralUsdc != null ? Number(row.defaultCollateralUsdc) : null,
      featured: Boolean(row.featured),
      realized_pnl_usd: Number(row.realizedPnlUsd ?? 0),
      high_water_mark_usd: Number(row.highWaterMarkUsd ?? 0),
      trade_count: Number(row.tradeCount ?? 0),
      max_drawdown_pct: Number(row.maxDrawdownPct ?? 0),
      days_live: Number(row.daysLive ?? 0),
      deployed_at: row.deployedAt ?? null,
      last_eval_at: row.lastEvalAt ?? null,
      created_at: row.createdAt as Date,
      updated_at: row.updatedAt as Date,
    };
  }

  /** Map a raw pg query result row (snake_case) to the public StrategyRow interface. */
  private static mapRow(row: any): StrategyRow {
    return {
      id: row.id,
      name: row.name,
      creator_inbox_id: row.creator_inbox_id,
      creator_wallet: row.creator_wallet ?? null,
      creator_basename: row.creator_basename ?? null,
      prompt: row.prompt,
      config: clampToRails(
        typeof row.config === "string" ? JSON.parse(row.config) : row.config,
      ),
      status: row.status as StrategyStatus,
      execution_wallet_name: row.execution_wallet_name ?? null,
      execution_wallet_address: row.execution_wallet_address ?? null,
      default_collateral_usdc: row.default_collateral_usdc != null ? Number(row.default_collateral_usdc) : null,
      featured: Boolean(row.featured),
      realized_pnl_usd: Number(row.realized_pnl_usd ?? 0),
      high_water_mark_usd: Number(row.high_water_mark_usd ?? 0),
      trade_count: Number(row.trade_count ?? 0),
      max_drawdown_pct: Number(row.max_drawdown_pct ?? 0),
      days_live: Number(row.days_live ?? 0),
      deployed_at: row.deployed_at ?? null,
      last_eval_at: row.last_eval_at ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
