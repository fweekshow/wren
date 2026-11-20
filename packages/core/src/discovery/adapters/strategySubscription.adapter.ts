import { and, eq, sql } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import { strategySubscriptions } from "@/db/schema/index.js";

export type StrategySubscriptionStatus = "active" | "paused" | "cancelled";

export interface StrategySubscriptionRow {
  id: string;
  strategy_id: string;
  follower_inbox_id: string;
  follower_wallet: string | null;
  copy_wallet_name: string;
  copy_wallet_address: string | null;
  allocation_usdc: number;
  status: StrategySubscriptionStatus;
  high_water_mark_usd: number;
  created_at: Date;
  updated_at: Date;
}

/** Followers deploy capital to a published strategy config (Phase 3 marketplace). */
export class StrategySubscriptionAdapter {
  /** @deprecated Tables are now managed via Drizzle migrations. */
  static async createTable(): Promise<void> {}

  static async upsert(input: {
    strategyId: string;
    followerInboxId: string;
    followerWallet?: string | null;
    copyWalletName: string;
    copyWalletAddress?: string | null;
    allocationUsdc: number;
  }): Promise<StrategySubscriptionRow | null> {
    try {
      const rows = await drizzleDb
        .insert(strategySubscriptions)
        .values({
          strategyId: input.strategyId,
          followerInboxId: input.followerInboxId,
          followerWallet: input.followerWallet ?? null,
          copyWalletName: input.copyWalletName,
          copyWalletAddress: input.copyWalletAddress ?? null,
          allocationUsdc: String(input.allocationUsdc),
        })
        .onConflictDoUpdate({
          target: [strategySubscriptions.strategyId, strategySubscriptions.followerInboxId],
          set: {
            followerWallet: input.followerWallet ?? null,
            copyWalletName: input.copyWalletName,
            copyWalletAddress: input.copyWalletAddress
              ? input.copyWalletAddress
              : sql`COALESCE(${strategySubscriptions.copyWalletAddress}, ${input.copyWalletAddress ?? null})`,
            allocationUsdc: String(input.allocationUsdc),
            status: "active",
            updatedAt: sql`NOW()`,
          },
        })
        .returning();
      return rows[0] ? StrategySubscriptionAdapter.mapRow(rows[0]) : null;
    } catch (error) {
      console.error("StrategySubscriptionAdapter.upsert error:", error);
      return null;
    }
  }

  static async listByFollower(inboxId: string): Promise<StrategySubscriptionRow[]> {
    const rows = await drizzleDb
      .select()
      .from(strategySubscriptions)
      .where(
        and(
          eq(strategySubscriptions.followerInboxId, inboxId),
          eq(strategySubscriptions.status, "active"),
        ),
      );
    return rows.map(StrategySubscriptionAdapter.mapRow);
  }

  static async listByStrategy(strategyId: string): Promise<StrategySubscriptionRow[]> {
    const rows = await drizzleDb
      .select()
      .from(strategySubscriptions)
      .where(
        and(
          eq(strategySubscriptions.strategyId, strategyId),
          eq(strategySubscriptions.status, "active"),
        ),
      );
    return rows.map(StrategySubscriptionAdapter.mapRow);
  }

  static async updateHighWaterMark(id: string, hwm: number): Promise<void> {
    await drizzleDb
      .update(strategySubscriptions)
      .set({ highWaterMarkUsd: String(hwm), updatedAt: sql`NOW()` })
      .where(eq(strategySubscriptions.id, id));
  }

  private static mapRow(row: typeof strategySubscriptions.$inferSelect): StrategySubscriptionRow {
    return {
      id: String(row.id),
      strategy_id: String(row.strategyId),
      follower_inbox_id: row.followerInboxId,
      follower_wallet: row.followerWallet ?? null,
      copy_wallet_name: row.copyWalletName,
      copy_wallet_address: row.copyWalletAddress ?? null,
      allocation_usdc: Number(row.allocationUsdc ?? 0),
      status: row.status as StrategySubscriptionStatus,
      high_water_mark_usd: Number(row.highWaterMarkUsd ?? 0),
      created_at: row.createdAt as Date,
      updated_at: row.updatedAt as Date,
    };
  }
}
