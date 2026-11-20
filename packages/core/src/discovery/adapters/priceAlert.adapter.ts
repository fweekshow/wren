import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import { priceAlerts } from "@/db/schema/index.js";

export type AlertPlatform = "xmtp" | "telegram" | "imessage" | "whatsapp";
export type AlertMetric = "price_usd" | "market_cap_usd";
export type AlertDirection = "above" | "below";
export type AlertStatus = "pending" | "triggered" | "cancelled" | "failed";
export type AlertTokenSource = "coingecko" | "dexscreener";

/**
 * A single row in `price_alerts`. `dm_target` is a JSON blob whose shape is
 * platform-specific (e.g. `{ walletAddress }` for XMTP, `{ userId }` for
 * Telegram, `{ spaceId }` for iMessage) — the platform delivery adapter knows
 * how to read it.
 */
export interface PriceAlertRow {
  id: number;
  platform: AlertPlatform;
  user_key: string;
  dm_target: string | null;
  source_conversation_id: string | null;
  source_is_group: boolean;
  token_source: AlertTokenSource;
  token_id: string | null;
  token_address: string | null;
  chain_id: string | null;
  symbol: string;
  name: string | null;
  metric: AlertMetric;
  target_value: string;
  direction: AlertDirection;
  current_value_at_create: string | null;
  status: AlertStatus;
  created_at: Date;
  triggered_at: Date | null;
  last_checked_at: Date | null;
}

export interface InsertPriceAlertInput {
  platform: AlertPlatform;
  userKey: string;
  dmTarget: Record<string, unknown> | null;
  sourceConversationId: string | null;
  sourceIsGroup: boolean;
  tokenSource: AlertTokenSource;
  tokenId: string | null;
  tokenAddress: string | null;
  chainId: string | null;
  symbol: string;
  name: string | null;
  metric: AlertMetric;
  targetValue: number;
  direction: AlertDirection;
  currentValueAtCreate: number | null;
}

export class PriceAlertAdapter {
  /** @deprecated Tables are now managed via Drizzle migrations. */
  static async createTable(): Promise<void> {}

  static async insert(input: InsertPriceAlertInput): Promise<PriceAlertRow> {
    const rows = await drizzleDb
      .insert(priceAlerts)
      .values({
        platform: input.platform,
        userKey: input.userKey,
        dmTarget: input.dmTarget ? JSON.stringify(input.dmTarget) : null,
        sourceConversationId: input.sourceConversationId,
        sourceIsGroup: input.sourceIsGroup,
        tokenSource: input.tokenSource,
        tokenId: input.tokenId,
        tokenAddress: input.tokenAddress,
        chainId: input.chainId,
        symbol: input.symbol,
        name: input.name,
        metric: input.metric,
        targetValue: String(input.targetValue),
        direction: input.direction,
        currentValueAtCreate: input.currentValueAtCreate != null
          ? String(input.currentValueAtCreate)
          : null,
      })
      .returning();
    return PriceAlertAdapter.mapRow(rows[0]!);
  }

  /**
   * All alerts still waiting to fire. Drains the full set in id-ordered batches
   * (cursor pagination) so there is no hard cap on how many alerts are checked.
   */
  static async listPending(
    opts: { platform?: AlertPlatform; batchSize?: number } = {},
  ): Promise<PriceAlertRow[]> {
    const batchSize = Math.max(1, opts.batchSize ?? 500);
    const out: PriceAlertRow[] = [];
    let cursor = 0;

    for (;;) {
      const condition = opts.platform
        ? and(eq(priceAlerts.status, "pending"), gt(priceAlerts.id, cursor), eq(priceAlerts.platform, opts.platform))
        : and(eq(priceAlerts.status, "pending"), gt(priceAlerts.id, cursor));

      const rows = await drizzleDb
        .select()
        .from(priceAlerts)
        .where(condition)
        .orderBy(asc(priceAlerts.id))
        .limit(batchSize);

      out.push(...rows.map(PriceAlertAdapter.mapRow));
      if (rows.length < batchSize) break;
      cursor = rows[rows.length - 1]!.id;
    }
    return out;
  }

  static async listActiveForUser(
    platform: AlertPlatform,
    userKey: string,
  ): Promise<PriceAlertRow[]> {
    const rows = await drizzleDb
      .select()
      .from(priceAlerts)
      .where(
        and(
          eq(priceAlerts.platform, platform),
          eq(priceAlerts.userKey, userKey),
          eq(priceAlerts.status, "pending"),
        ),
      )
      .orderBy(asc(priceAlerts.createdAt));
    return rows.map(PriceAlertAdapter.mapRow);
  }

  static async markTriggered(id: number): Promise<void> {
    await drizzleDb
      .update(priceAlerts)
      .set({
        status: "triggered",
        triggeredAt: sql`CURRENT_TIMESTAMP`,
        lastCheckedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(priceAlerts.id, id));
  }

  static async markFailed(id: number): Promise<void> {
    await drizzleDb
      .update(priceAlerts)
      .set({ status: "failed", lastCheckedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(priceAlerts.id, id));
  }

  static async touchChecked(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await drizzleDb
      .update(priceAlerts)
      .set({ lastCheckedAt: sql`CURRENT_TIMESTAMP` })
      .where(inArray(priceAlerts.id, ids));
  }

  /** Cancel one pending alert owned by the user, or all if no id is given. */
  static async cancelForUser(
    platform: AlertPlatform,
    userKey: string,
    id?: number,
  ): Promise<number> {
    const condition = id
      ? and(
          eq(priceAlerts.platform, platform),
          eq(priceAlerts.userKey, userKey),
          eq(priceAlerts.id, id),
          eq(priceAlerts.status, "pending"),
        )
      : and(
          eq(priceAlerts.platform, platform),
          eq(priceAlerts.userKey, userKey),
          eq(priceAlerts.status, "pending"),
        );

    const result = await drizzleDb
      .update(priceAlerts)
      .set({ status: "cancelled" })
      .where(condition)
      .returning({ id: priceAlerts.id });

    return result.length;
  }

  private static mapRow(row: typeof priceAlerts.$inferSelect): PriceAlertRow {
    return {
      id: row.id,
      platform: row.platform as AlertPlatform,
      user_key: row.userKey,
      dm_target: row.dmTarget ?? null,
      source_conversation_id: row.sourceConversationId ?? null,
      source_is_group: Boolean(row.sourceIsGroup),
      token_source: row.tokenSource as AlertTokenSource,
      token_id: row.tokenId ?? null,
      token_address: row.tokenAddress ?? null,
      chain_id: row.chainId ?? null,
      symbol: row.symbol,
      name: row.name ?? null,
      metric: row.metric as AlertMetric,
      target_value: String(row.targetValue),
      direction: row.direction as AlertDirection,
      current_value_at_create: row.currentValueAtCreate != null ? String(row.currentValueAtCreate) : null,
      status: row.status as AlertStatus,
      created_at: row.createdAt as Date,
      triggered_at: row.triggeredAt ?? null,
      last_checked_at: row.lastCheckedAt ?? null,
    };
  }
}
