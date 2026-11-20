import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import { copyStrategies } from "@/db/schema/index.js";
import { db } from "@/discovery/db.js";

import type { CopyPlatform, StrategyStatus } from "../types.js";

/** What trade types a copy strategy mirrors from the leader. */
export type CopyMode = "tokens" | "perps" | "both";

/**
 * Copy Strategy Manager persistence. One strategy = one follower copying one
 * leader, with its own dedicated CDP server wallet and independent state.
 * (Copying multiple leaders / weighted portfolios is future work.)
 */
export interface CopyStrategyRow {
  id: number;
  platform: CopyPlatform;
  /** Platform-scoped follower identity (xmtp inbox id / tg user id / imessage sender). */
  user_key: string;
  /** Follower's own wallet — where funds are returned on withdrawal. */
  follower_wallet: string | null;
  leader_wallet: string;
  /** CDP account name for the dedicated isolated copy wallet. */
  copy_wallet_name: string;
  /** Address of the copy wallet. */
  copy_wallet_address: string;
  /** Funds the follower committed (USDC), used as the proportional-sizing base. */
  allocation_usd: string;
  /** Hard cap on any single copied trade (USD). */
  max_trade_usd: string;
  max_slippage_bps: number;
  /** Optional JSON array of token addresses; null = all tokens allowed. */
  allowed_tokens: string | null;
  /** Which leader activity to mirror: token swaps, Avantis perps, or both. */
  copy_mode: CopyMode;
  status: StrategyStatus;
  /** Delivery target JSON for notifications (platform-specific). */
  dm_target: string | null;
  realized_pnl_usd: string;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

export interface CreateStrategyInput {
  platform: CopyPlatform;
  userKey: string;
  followerWallet?: string | null;
  leaderWallet: string;
  copyWalletName: string;
  copyWalletAddress: string;
  allocationUsd?: number;
  maxTradeUsd?: number;
  maxSlippageBps?: number;
  allowedTokens?: string[] | null;
  copyMode?: CopyMode;
  dmTarget?: Record<string, unknown> | null;
}

export class CopyStrategyAdapter {
  /** @deprecated Tables are now managed via Drizzle migrations. */
  static async createTable(): Promise<void> {}

  static async create(input: CreateStrategyInput): Promise<CopyStrategyRow> {
    const rows = await drizzleDb
      .insert(copyStrategies)
      .values({
        platform: input.platform,
        userKey: input.userKey,
        followerWallet: input.followerWallet ? input.followerWallet.toLowerCase() : null,
        leaderWallet: input.leaderWallet.toLowerCase(),
        copyWalletName: input.copyWalletName,
        copyWalletAddress: input.copyWalletAddress.toLowerCase(),
        allocationUsd: String(input.allocationUsd ?? 0),
        maxTradeUsd: String(input.maxTradeUsd ?? 0),
        maxSlippageBps: input.maxSlippageBps ?? 200,
        allowedTokens: input.allowedTokens
          ? JSON.stringify(input.allowedTokens.map((t) => t.toLowerCase()))
          : null,
        copyMode: input.copyMode ?? "tokens",
        dmTarget: input.dmTarget ? JSON.stringify(input.dmTarget) : null,
        status: "active",
      })
      .returning();
    return CopyStrategyAdapter.mapRow(rows[0]!);
  }

  static async getById(id: number): Promise<CopyStrategyRow | null> {
    const row = await drizzleDb.query.copyStrategies.findFirst({
      where: (c, { eq }) => eq(c.id, id),
    });
    return row ? CopyStrategyAdapter.mapRow(row) : null;
  }

  static async getActiveFor(
    platform: CopyPlatform,
    userKey: string,
    leaderWallet: string,
  ): Promise<CopyStrategyRow | null> {
    const row = await drizzleDb.query.copyStrategies.findFirst({
      where: (c, { and, eq, inArray }) =>
        and(
          eq(c.platform, platform),
          eq(c.userKey, userKey),
          eq(c.leaderWallet, leaderWallet.toLowerCase()),
          inArray(c.status, ["active", "paused"]),
        ),
    });
    return row ? CopyStrategyAdapter.mapRow(row) : null;
  }

  static async getActiveForUser(
    platform: CopyPlatform,
    userKey: string,
  ): Promise<CopyStrategyRow | null> {
    const row = await drizzleDb.query.copyStrategies.findFirst({
      where: (c, { and, eq, inArray }) =>
        and(eq(c.platform, platform), eq(c.userKey, userKey), inArray(c.status, ["active", "paused"])),
      orderBy: (c, { desc }) => [desc(c.createdAt)],
    });
    return row ? CopyStrategyAdapter.mapRow(row) : null;
  }

  /** Active strategies following a given leader — the Copy Engine fan-out set. */
  static async listActiveByLeader(leaderWallet: string): Promise<CopyStrategyRow[]> {
    const rows = await drizzleDb
      .select()
      .from(copyStrategies)
      .where(and(eq(copyStrategies.leaderWallet, leaderWallet.toLowerCase()), eq(copyStrategies.status, "active")));
    return rows.map(CopyStrategyAdapter.mapRow);
  }

  /**
   * Most recent strategy for a user regardless of status (active, paused, or
   * archived). Used to reuse the user's existing copy wallet.
   */
  static async getAnyForUser(
    platform: CopyPlatform,
    userKey: string,
  ): Promise<CopyStrategyRow | null> {
    const row = await drizzleDb.query.copyStrategies.findFirst({
      where: (c, { and, eq }) => and(eq(c.platform, platform), eq(c.userKey, userKey)),
      orderBy: (c, { desc }) => [desc(c.createdAt)],
    });
    return row ? CopyStrategyAdapter.mapRow(row) : null;
  }

  static async listForUser(platform: CopyPlatform, userKey: string): Promise<CopyStrategyRow[]> {
    const rows = await drizzleDb
      .select()
      .from(copyStrategies)
      .where(
        and(
          eq(copyStrategies.platform, platform),
          eq(copyStrategies.userKey, userKey),
          inArray(copyStrategies.status, ["active", "paused"]),
        ),
      )
      .orderBy(desc(copyStrategies.createdAt));
    return rows.map(CopyStrategyAdapter.mapRow);
  }

  static async listAllForUser(platform: CopyPlatform, userKey: string): Promise<CopyStrategyRow[]> {
    const rows = await drizzleDb
      .select()
      .from(copyStrategies)
      .where(and(eq(copyStrategies.platform, platform), eq(copyStrategies.userKey, userKey)))
      .orderBy(desc(copyStrategies.createdAt));
    return rows.map(CopyStrategyAdapter.mapRow);
  }

  static async setStatus(id: number, status: StrategyStatus): Promise<void> {
    await drizzleDb
      .update(copyStrategies)
      .set({
        status,
        archivedAt: status === "archived" ? sql`CURRENT_TIMESTAMP` : sql`${copyStrategies.archivedAt}`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(copyStrategies.id, id));
  }

  static async updateAllocation(id: number, allocationUsd: number): Promise<void> {
    await drizzleDb
      .update(copyStrategies)
      .set({ allocationUsd: String(allocationUsd), updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(copyStrategies.id, id));
  }

  static async updateCopyMode(id: number, copyMode: CopyMode): Promise<void> {
    await drizzleDb
      .update(copyStrategies)
      .set({ copyMode, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(copyStrategies.id, id));
  }

  static async addRealizedPnl(id: number, pnlUsd: number): Promise<void> {
    await drizzleDb
      .update(copyStrategies)
      .set({
        realizedPnlUsd: sql`${copyStrategies.realizedPnlUsd} + ${String(pnlUsd)}`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(copyStrategies.id, id));
  }

  /** Distinct leader wallets that currently have active followers. */
  static async listActiveLeaderWallets(): Promise<string[]> {
    const res = await db.query<{ leader_wallet: string }>(
      `SELECT DISTINCT leader_wallet FROM copy_strategies WHERE status = 'active'`,
    );
    return res.rows.map((r) => r.leader_wallet);
  }

  static parseAllowedTokens(row: CopyStrategyRow): string[] | null {
    if (!row.allowed_tokens) return null;
    try {
      return JSON.parse(row.allowed_tokens) as string[];
    } catch {
      return null;
    }
  }

  private static mapRow(row: typeof copyStrategies.$inferSelect): CopyStrategyRow {
    return {
      id: row.id,
      platform: row.platform as CopyPlatform,
      user_key: row.userKey,
      follower_wallet: row.followerWallet ?? null,
      leader_wallet: row.leaderWallet,
      copy_wallet_name: row.copyWalletName,
      copy_wallet_address: row.copyWalletAddress,
      allocation_usd: String(row.allocationUsd ?? 0),
      max_trade_usd: String(row.maxTradeUsd ?? 0),
      max_slippage_bps: row.maxSlippageBps ?? 200,
      allowed_tokens: row.allowedTokens ?? null,
      copy_mode: (row.copyMode ?? "tokens") as CopyMode,
      status: row.status as StrategyStatus,
      dm_target: row.dmTarget ?? null,
      realized_pnl_usd: String(row.realizedPnlUsd ?? 0),
      created_at: row.createdAt as Date,
      updated_at: row.updatedAt as Date,
      archived_at: row.archivedAt ?? null,
    };
  }
}
