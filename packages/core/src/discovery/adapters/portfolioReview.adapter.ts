import { and, asc, desc, eq, isNull, lte, or, sql } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import { db } from "@/discovery/db.js";
import {
  portfolioReviewDeliveryAttempts,
  portfolioReviewJobs,
  portfolioReviewSnapshots,
  portfolioReviewSubscriptions,
} from "@/db/schema/index.js";

export type PortfolioReviewPlatform = "xmtp" | "telegram" | "imessage" | "whatsapp";

export interface PortfolioReviewSubscriptionRow {
  id: number;
  platform: PortfolioReviewPlatform;
  user_key: string;
  wallet_address: string;
  dm_target: string | null;
  local_time: string;
  timezone: string;
  enabled: boolean;
  next_run_at: Date;
  last_sent_at: Date | null;
  processing_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PortfolioReviewSnapshotRow {
  id: number;
  subscription_id: number;
  captured_at: Date;
  total_value_usd: string;
  holdings_json: string;
  avantis_json: string | null;
  sentiment_json: string | null;
  wallet_address: string | null;
  created_at: Date;
}

export type PortfolioReviewJobStatus = "queued" | "processing" | "sent" | "failed";

export interface PortfolioReviewJobRow {
  id: number;
  subscription_id: number;
  platform: PortfolioReviewPlatform;
  run_at: Date;
  status: PortfolioReviewJobStatus;
  attempts: number;
  locked_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertPortfolioReviewInput {
  platform: PortfolioReviewPlatform;
  userKey: string;
  walletAddress: string;
  dmTarget: Record<string, unknown> | null;
  localTime: string;
  timezone: string;
  nextRunAt: Date;
}

export interface InsertSnapshotInput {
  subscriptionId: number;
  totalValueUsd: number;
  holdings: unknown;
  avantis: unknown;
  sentiment: unknown;
  walletAddress?: string | null;
}

export class PortfolioReviewAdapter {
  /** @deprecated Tables are now managed via Drizzle migrations. */
  static async createTable(): Promise<void> {}

  static async upsertSubscription(
    input: UpsertPortfolioReviewInput,
  ): Promise<PortfolioReviewSubscriptionRow> {
    const rows = await drizzleDb
      .insert(portfolioReviewSubscriptions)
      .values({
        platform: input.platform,
        userKey: input.userKey,
        walletAddress: input.walletAddress.toLowerCase(),
        dmTarget: input.dmTarget ? JSON.stringify(input.dmTarget) : null,
        localTime: input.localTime,
        timezone: input.timezone,
        enabled: true,
        nextRunAt: input.nextRunAt,
        processingAt: null,
        lastError: null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .onConflictDoUpdate({
        target: [portfolioReviewSubscriptions.platform, portfolioReviewSubscriptions.userKey],
        set: {
          walletAddress: input.walletAddress.toLowerCase(),
          dmTarget: input.dmTarget ? JSON.stringify(input.dmTarget) : null,
          localTime: input.localTime,
          timezone: input.timezone,
          enabled: true,
          nextRunAt: input.nextRunAt,
          processingAt: null,
          lastError: null,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        },
      })
      .returning();
    return PortfolioReviewAdapter.mapSubRow(rows[0]!);
  }

  static async getSubscription(
    platform: PortfolioReviewPlatform,
    userKey: string,
  ): Promise<PortfolioReviewSubscriptionRow | null> {
    const row = await drizzleDb.query.portfolioReviewSubscriptions.findFirst({
      where: (s, { and, eq }) => and(eq(s.platform, platform), eq(s.userKey, userKey)),
    });
    return row ? PortfolioReviewAdapter.mapSubRow(row) : null;
  }

  static async getSubscriptionById(id: number): Promise<PortfolioReviewSubscriptionRow | null> {
    const row = await drizzleDb.query.portfolioReviewSubscriptions.findFirst({
      where: (s, { eq }) => eq(s.id, id),
    });
    return row ? PortfolioReviewAdapter.mapSubRow(row) : null;
  }

  static async disableSubscription(
    platform: PortfolioReviewPlatform,
    userKey: string,
  ): Promise<boolean> {
    const result = await drizzleDb
      .update(portfolioReviewSubscriptions)
      .set({ enabled: false, processingAt: null, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(
        and(
          eq(portfolioReviewSubscriptions.platform, platform),
          eq(portfolioReviewSubscriptions.userKey, userKey),
          eq(portfolioReviewSubscriptions.enabled, true),
        ),
      )
      .returning({ id: portfolioReviewSubscriptions.id });
    return result.length > 0;
  }

  /**
   * SELECT + UPDATE CTE for distributed lock claim — must stay raw SQL for
   * atomicity (Drizzle doesn't support CTEs in UPDATE).
   */
  static async listDueAndClaim(
    platform: PortfolioReviewPlatform,
    limit = 50,
    now = new Date(),
  ): Promise<PortfolioReviewSubscriptionRow[]> {
    const result = await db.query<PortfolioReviewSubscriptionRow>(
      `WITH due AS (
         SELECT id
         FROM portfolio_review_subscriptions
         WHERE platform = $1
           AND enabled = true
           AND next_run_at <= $2
           AND (processing_at IS NULL OR processing_at < $2::timestamptz - INTERVAL '15 minutes')
         ORDER BY next_run_at ASC, id ASC
         LIMIT $3
       )
       UPDATE portfolio_review_subscriptions s
       SET processing_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       FROM due
       WHERE s.id = due.id
       RETURNING s.*`,
      [platform, now, limit],
    );
    return result.rows;
  }

  static async enqueueDueReviews(
    platform: PortfolioReviewPlatform,
    limit = 50,
    now = new Date(),
  ): Promise<PortfolioReviewJobRow[]> {
    const result = await db.query<PortfolioReviewJobRow>(
      `WITH due AS (
         SELECT id, platform, next_run_at
         FROM portfolio_review_subscriptions
         WHERE platform = $1
           AND enabled = true
           AND next_run_at <= $2
         ORDER BY next_run_at ASC, id ASC
         LIMIT $3
       )
       INSERT INTO portfolio_review_jobs (subscription_id, platform, run_at)
       SELECT id, platform, next_run_at FROM due
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [platform, now, limit],
    );
    return result.rows;
  }

  static async claimQueuedJob(
    platform: PortfolioReviewPlatform,
    now = new Date(),
  ): Promise<PortfolioReviewJobRow | null> {
    const result = await db.query<PortfolioReviewJobRow>(
      `WITH next_job AS (
         SELECT id
         FROM portfolio_review_jobs
         WHERE platform = $1
           AND (
             status = 'queued'
             OR (status = 'processing' AND locked_at < $2::timestamptz - INTERVAL '15 minutes')
           )
           AND run_at <= $2
         ORDER BY run_at ASC, id ASC
         LIMIT 1
       )
       UPDATE portfolio_review_jobs j
       SET status = 'processing',
           attempts = attempts + 1,
           locked_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       FROM next_job
       WHERE j.id = next_job.id
       RETURNING j.*`,
      [platform, now],
    );
    return result.rows[0] ?? null;
  }

  static async insertSnapshot(input: InsertSnapshotInput): Promise<PortfolioReviewSnapshotRow> {
    const rows = await drizzleDb
      .insert(portfolioReviewSnapshots)
      .values({
        subscriptionId: input.subscriptionId,
        totalValueUsd: String(input.totalValueUsd),
        holdingsJson: JSON.stringify(input.holdings),
        avantisJson: input.avantis == null ? null : JSON.stringify(input.avantis),
        sentimentJson: input.sentiment == null ? null : JSON.stringify(input.sentiment),
        walletAddress: input.walletAddress ? input.walletAddress.toLowerCase() : null,
      })
      .returning();
    return PortfolioReviewAdapter.mapSnapshotRow(rows[0]!);
  }

  static async findNearestSnapshotBefore(
    subscriptionId: number,
    before: Date,
    walletAddress?: string | null,
  ): Promise<PortfolioReviewSnapshotRow | null> {
    const walletClause = walletAddress
      ? `AND wallet_address = $3`
      : `AND wallet_address IS NULL`;
    const params: unknown[] = walletAddress
      ? [subscriptionId, before, walletAddress.toLowerCase()]
      : [subscriptionId, before];
    const result = await db.query<PortfolioReviewSnapshotRow>(
      `SELECT * FROM portfolio_review_snapshots
       WHERE subscription_id = $1 AND captured_at <= $2 ${walletClause}
       ORDER BY captured_at DESC
       LIMIT 1`,
      params,
    );
    return result.rows[0] ?? null;
  }

  static async findOldestSnapshot(
    subscriptionId: number,
    walletAddress?: string | null,
  ): Promise<PortfolioReviewSnapshotRow | null> {
    const walletClause = walletAddress
      ? `AND wallet_address = $2`
      : `AND wallet_address IS NULL`;
    const params: unknown[] = walletAddress
      ? [subscriptionId, walletAddress.toLowerCase()]
      : [subscriptionId];
    const result = await db.query<PortfolioReviewSnapshotRow>(
      `SELECT * FROM portfolio_review_snapshots
       WHERE subscription_id = $1 ${walletClause}
       ORDER BY captured_at ASC
       LIMIT 1`,
      params,
    );
    return result.rows[0] ?? null;
  }

  static async markDelivered(
    subscriptionId: number,
    nextRunAt: Date,
    platform: PortfolioReviewPlatform,
  ): Promise<void> {
    await drizzleDb
      .update(portfolioReviewSubscriptions)
      .set({
        lastSentAt: sql`CURRENT_TIMESTAMP`,
        nextRunAt,
        processingAt: null,
        lastError: null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(portfolioReviewSubscriptions.id, subscriptionId));
    await this.recordDeliveryAttempt(subscriptionId, platform, true);
  }

  static async markJobDelivered(
    jobId: number,
    subscriptionId: number,
    nextRunAt: Date,
    platform: PortfolioReviewPlatform,
  ): Promise<void> {
    await drizzleDb
      .update(portfolioReviewJobs)
      .set({ status: "sent", lockedAt: null, lastError: null, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(portfolioReviewJobs.id, jobId));
    await this.markDelivered(subscriptionId, nextRunAt, platform);
  }

  static async markFailed(
    subscriptionId: number,
    platform: PortfolioReviewPlatform,
    error: string,
  ): Promise<void> {
    await drizzleDb
      .update(portfolioReviewSubscriptions)
      .set({
        processingAt: null,
        lastError: error.slice(0, 2000),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(portfolioReviewSubscriptions.id, subscriptionId));
    await this.recordDeliveryAttempt(subscriptionId, platform, false, error);
  }

  static async markJobFailed(
    job: PortfolioReviewJobRow,
    platform: PortfolioReviewPlatform,
    error: string,
    maxAttempts = 3,
  ): Promise<void> {
    const terminal = job.attempts >= maxAttempts;
    await drizzleDb
      .update(portfolioReviewJobs)
      .set({
        status: terminal ? "failed" : "queued",
        lockedAt: null,
        lastError: error.slice(0, 2000),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(portfolioReviewJobs.id, job.id));
    if (terminal) {
      await this.markFailed(job.subscription_id, platform, error);
    }
  }

  private static async recordDeliveryAttempt(
    subscriptionId: number,
    platform: PortfolioReviewPlatform,
    success: boolean,
    error?: string,
  ): Promise<void> {
    await drizzleDb.insert(portfolioReviewDeliveryAttempts).values({
      subscriptionId,
      platform,
      success,
      errorMessage: error ? error.slice(0, 2000) : null,
    });
  }

  private static mapSubRow(
    row: typeof portfolioReviewSubscriptions.$inferSelect,
  ): PortfolioReviewSubscriptionRow {
    return {
      id: row.id,
      platform: row.platform as PortfolioReviewPlatform,
      user_key: row.userKey,
      wallet_address: row.walletAddress,
      dm_target: row.dmTarget ?? null,
      local_time: row.localTime,
      timezone: row.timezone,
      enabled: Boolean(row.enabled),
      next_run_at: row.nextRunAt as Date,
      last_sent_at: row.lastSentAt ?? null,
      processing_at: row.processingAt ?? null,
      last_error: row.lastError ?? null,
      created_at: row.createdAt as Date,
      updated_at: row.updatedAt as Date,
    };
  }

  private static mapSnapshotRow(
    row: typeof portfolioReviewSnapshots.$inferSelect,
  ): PortfolioReviewSnapshotRow {
    return {
      id: row.id,
      subscription_id: row.subscriptionId,
      captured_at: row.capturedAt as Date,
      total_value_usd: String(row.totalValueUsd),
      holdings_json: row.holdingsJson,
      avantis_json: row.avantisJson ?? null,
      sentiment_json: row.sentimentJson ?? null,
      wallet_address: row.walletAddress ?? null,
      created_at: row.createdAt as Date,
    };
  }
}
