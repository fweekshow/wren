import { randomBytes } from "node:crypto";

import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import { txConfirmations } from "@/db/schema/index.js";

export type TxConfirmationStatus =
  | "pending" // link sent, user hasn't reported a signed tx yet
  | "submitted" // browser reported a tx hash; awaiting on-chain receipt
  | "confirmed" // receipt succeeded, user notified
  | "failed" // receipt reverted, user notified
  | "expired"; // never signed within the TTL

export type RecipientNotificationStatus =
  | "pending"
  | "processing"
  | "provider_accepted"
  | "retryable_failed"
  | "failed";

export type RecipientClaimStatus = "pending" | "processing" | "sent";

export interface TxConfirmationRow {
  sid: string;
  sender_id: string;
  from_address: string;
  chain_id: string;
  label: string | null;
  status: TxConfirmationStatus;
  tx_hash: string | null;
  mcp_request_id: string | null;
  approval_url: string | null;
  recipient_phone: string | null;
  transfer_amount: string | null;
  transfer_asset: string | null;
  transfer_memo: string | null;
  recipient_notification_status: RecipientNotificationStatus | null;
  recipient_notification_attempts: number;
  recipient_notification_next_attempt_at: Date | null;
  recipient_notification_last_error: string | null;
  recipient_notification_accepted_at: Date | null;
  recipient_claim_status?: RecipientClaimStatus | null;
  recipient_claim_processing_at?: Date | null;
  recipient_claim_sent_at?: Date | null;
  created_at: Date;
  submitted_at: Date | null;
  resolved_at: Date | null;
  expires_at: Date;
}

export interface CreateTxConfirmationInput {
  senderId: string;
  fromAddress: string;
  chainId: string;
  label?: string | null;
  ttlMs?: number;
}

export interface CreateMcpTxConfirmationInput extends CreateTxConfirmationInput {
  mcpRequestId: string;
  approvalUrl: string;
  recipientPhone?: string | null;
  transferAmount?: string | null;
  transferAsset?: string | null;
  transferMemo?: string | null;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * Tracks transactions a user signs in the browser `/sign` page so a poller can
 * confirm them on-chain and message the user back in iMessage.
 */
export class TxConfirmationAdapter {
  /** @deprecated Tables are now managed via Drizzle migrations. */
  static async createTable(): Promise<void> {}

  static async create(input: CreateTxConfirmationInput): Promise<string> {
    const sid = randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS));
    await drizzleDb.insert(txConfirmations).values({
      sid,
      senderId: input.senderId,
      fromAddress: input.fromAddress,
      chainId: input.chainId,
      label: input.label ?? null,
      expiresAt,
    });
    return sid;
  }

  static async createMcpApproval(input: CreateMcpTxConfirmationInput): Promise<string> {
    const sid = randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS));
    // A bundle send packs its summary into transferAmount and leaves asset
    // empty, so only phone + amount are required to schedule the notification.
    const hasRecipientNotification = Boolean(input.recipientPhone && input.transferAmount);
    await drizzleDb.insert(txConfirmations).values({
      sid,
      senderId: input.senderId,
      fromAddress: input.fromAddress,
      chainId: input.chainId,
      label: input.label ?? null,
      expiresAt,
      mcpRequestId: input.mcpRequestId,
      approvalUrl: input.approvalUrl,
      recipientPhone: input.recipientPhone ?? null,
      transferAmount: input.transferAmount ?? null,
      transferAsset: input.transferAsset ?? null,
      transferMemo: input.transferMemo ?? null,
      recipientNotificationStatus: hasRecipientNotification ? "pending" : null,
      recipientNotificationNextAttemptAt: hasRecipientNotification ? new Date() : null,
    });
    return sid;
  }

  /**
   * Record an already-confirmed transfer purely so the recipient-notification
   * lifecycle fires. Used by the embedded-wallet (delegated signing) path, which
   * executes and confirms server-side in one step — there is no `/sign` receipt
   * to poll, so we insert the row directly in `confirmed` state with the
   * recipient notification scheduled. The existing TxConfirmationPoller then
   * texts the recipient (with retries/dedup) via buildRecipientTransferNotification.
   */
  static async createConfirmedRecipientNotification(input: {
    senderId: string;
    fromAddress: string;
    chainId: string;
    label?: string | null;
    txHash?: string | null;
    recipientPhone: string;
    transferAmount: string;
    transferAsset?: string;
    transferMemo?: string;
    ttlMs?: number;
  }): Promise<string | null> {
    if (!input.recipientPhone || !input.transferAmount) {
      return null;
    }
    const sid = randomBytes(16).toString("hex");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS));
    await drizzleDb.insert(txConfirmations).values({
      sid,
      senderId: input.senderId,
      fromAddress: input.fromAddress,
      chainId: input.chainId,
      label: input.label ?? null,
      status: "confirmed",
      txHash: input.txHash ?? null,
      recipientPhone: input.recipientPhone,
      transferAmount: input.transferAmount,
      transferAsset: input.transferAsset ?? null,
      transferMemo: input.transferMemo ?? null,
      recipientNotificationStatus: "pending",
      recipientNotificationNextAttemptAt: now,
      submittedAt: now,
      resolvedAt: now,
      expiresAt,
    });
    return sid;
  }

  /**
   * Record any embedded-wallet execution as a confirmed row so it appears in the
   * dashboard activity feed. Schedules the recipient notification only when the
   * transfer names a recipient (contact send / escrow); swaps, buys, deposits,
   * etc. are logged as activity without a notification.
   */
  static async recordConfirmedActivity(input: {
    senderId: string;
    fromAddress: string;
    chainId: string;
    label?: string | null;
    txHash?: string | null;
    recipientPhone?: string | null;
    transferAmount?: string | null;
    transferAsset?: string | null;
    transferMemo?: string | null;
    ttlMs?: number;
  }): Promise<string> {
    const sid = randomBytes(16).toString("hex");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS));
    const notify = Boolean(input.recipientPhone && input.transferAmount);
    await drizzleDb.insert(txConfirmations).values({
      sid,
      senderId: input.senderId,
      fromAddress: input.fromAddress,
      chainId: input.chainId,
      label: input.label ?? null,
      status: "confirmed",
      txHash: input.txHash ?? null,
      recipientPhone: input.recipientPhone ?? null,
      transferAmount: input.transferAmount ?? null,
      transferAsset: input.transferAsset ?? null,
      transferMemo: input.transferMemo ?? null,
      recipientNotificationStatus: notify ? "pending" : null,
      recipientNotificationNextAttemptAt: notify ? now : null,
      submittedAt: now,
      resolvedAt: now,
      expiresAt,
    });
    return sid;
  }

  static async markSubmitted(sid: string, txHash: string): Promise<boolean> {
    const result = await drizzleDb
      .update(txConfirmations)
      .set({ status: "submitted", txHash, submittedAt: sql`CURRENT_TIMESTAMP` })
      .where(
        and(
          eq(txConfirmations.sid, sid),
          inArray(txConfirmations.status, ["pending", "submitted"]),
        ),
      )
      .returning({ sid: txConfirmations.sid });
    return result.length > 0;
  }

  static async listActionable(limit = 50): Promise<TxConfirmationRow[]> {
    const rows = await drizzleDb
      .select()
      .from(txConfirmations)
      .where(and(eq(txConfirmations.status, "submitted"), isNotNull(txConfirmations.txHash)))
      .orderBy(asc(txConfirmations.submittedAt))
      .limit(limit);
    return rows.map(TxConfirmationAdapter.mapRow);
  }

  /** A user's recent transactions, newest first — powers the dashboard activity feed. */
  static async listBySenderId(senderId: string, limit = 100): Promise<TxConfirmationRow[]> {
    const rows = await drizzleDb
      .select()
      .from(txConfirmations)
      .where(eq(txConfirmations.senderId, senderId))
      .orderBy(desc(txConfirmations.createdAt))
      .limit(limit);
    return rows.map(TxConfirmationAdapter.mapRow);
  }

  static async listMcpPending(limit = 50): Promise<TxConfirmationRow[]> {
    const rows = await drizzleDb
      .select()
      .from(txConfirmations)
      .where(and(eq(txConfirmations.status, "pending"), isNotNull(txConfirmations.mcpRequestId)))
      .orderBy(asc(txConfirmations.createdAt))
      .limit(limit);
    return rows.map(TxConfirmationAdapter.mapRow);
  }

  static async listRecipientNotificationActionable(
    limit = 50,
    now = new Date(),
  ): Promise<TxConfirmationRow[]> {
    const rows = await drizzleDb
      .select()
      .from(txConfirmations)
      .where(
        and(
          eq(txConfirmations.status, "confirmed"),
          inArray(txConfirmations.recipientNotificationStatus, [
            "pending",
            "processing",
            "retryable_failed",
          ]),
          or(
            isNull(txConfirmations.recipientNotificationNextAttemptAt),
            lte(txConfirmations.recipientNotificationNextAttemptAt, now),
          ),
        ),
      )
      .orderBy(
        asc(txConfirmations.recipientNotificationNextAttemptAt),
        asc(txConfirmations.createdAt),
      )
      .limit(limit);
    return rows.map(TxConfirmationAdapter.mapRow);
  }

  static async claimRecipientNotification(
    sid: string,
    now = new Date(),
    leaseMs = 5 * 60_000,
  ): Promise<TxConfirmationRow | null> {
    const rows = await drizzleDb
      .update(txConfirmations)
      .set({
        recipientNotificationStatus: "processing",
        recipientNotificationAttempts: sql`${txConfirmations.recipientNotificationAttempts} + 1`,
        recipientNotificationNextAttemptAt: new Date(now.getTime() + leaseMs),
        recipientNotificationLastError: null,
      })
      .where(
        and(
          eq(txConfirmations.sid, sid),
          eq(txConfirmations.status, "confirmed"),
          inArray(txConfirmations.recipientNotificationStatus, [
            "pending",
            "processing",
            "retryable_failed",
          ]),
          or(
            isNull(txConfirmations.recipientNotificationNextAttemptAt),
            lte(txConfirmations.recipientNotificationNextAttemptAt, now),
          ),
        ),
      )
      .returning();
    return rows[0] ? TxConfirmationAdapter.mapRow(rows[0]) : null;
  }

  static async markRecipientNotificationAccepted(
    sid: string,
    requiresClaim = false,
  ): Promise<boolean> {
    const result = await drizzleDb
      .update(txConfirmations)
      .set({
        recipientNotificationStatus: "provider_accepted",
        recipientNotificationNextAttemptAt: null,
        recipientNotificationLastError: null,
        recipientNotificationAcceptedAt: new Date(),
        recipientClaimStatus: requiresClaim ? "pending" : null,
        recipientClaimProcessingAt: null,
      })
      .where(
        and(
          eq(txConfirmations.sid, sid),
          eq(txConfirmations.recipientNotificationStatus, "processing"),
        ),
      )
      .returning({ sid: txConfirmations.sid });
    return result.length > 0;
  }

  /**
   * Atomically claims every deferred transfer for a recipient as one batch.
   * A stale processing lease is reclaimable so a process crash cannot strand
   * funds without a future claim prompt.
   */
  static async claimPendingRecipientClaims(
    recipientPhone: string,
    now = new Date(),
    leaseMs = 5 * 60_000,
  ): Promise<TxConfirmationRow[]> {
    const staleBefore = new Date(now.getTime() - leaseMs);
    const rows = await drizzleDb
      .update(txConfirmations)
      .set({
        recipientClaimStatus: "processing",
        recipientClaimProcessingAt: now,
      })
      .where(
        and(
          eq(txConfirmations.status, "confirmed"),
          eq(txConfirmations.recipientPhone, recipientPhone),
          or(
            eq(txConfirmations.recipientClaimStatus, "pending"),
            and(
              eq(txConfirmations.recipientClaimStatus, "processing"),
              or(
                isNull(txConfirmations.recipientClaimProcessingAt),
                lte(txConfirmations.recipientClaimProcessingAt, staleBefore),
              ),
            ),
          ),
        ),
      )
      .returning();
    return rows.map(TxConfirmationAdapter.mapRow);
  }

  static async markRecipientClaimsSent(sids: string[]): Promise<number> {
    if (sids.length === 0) return 0;
    const rows = await drizzleDb
      .update(txConfirmations)
      .set({
        recipientClaimStatus: "sent",
        recipientClaimProcessingAt: null,
        recipientClaimSentAt: new Date(),
      })
      .where(
        and(
          inArray(txConfirmations.sid, sids),
          eq(txConfirmations.recipientClaimStatus, "processing"),
        ),
      )
      .returning({ sid: txConfirmations.sid });
    return rows.length;
  }

  static async releaseRecipientClaims(sids: string[]): Promise<number> {
    if (sids.length === 0) return 0;
    const rows = await drizzleDb
      .update(txConfirmations)
      .set({
        recipientClaimStatus: "pending",
        recipientClaimProcessingAt: null,
      })
      .where(
        and(
          inArray(txConfirmations.sid, sids),
          eq(txConfirmations.recipientClaimStatus, "processing"),
        ),
      )
      .returning({ sid: txConfirmations.sid });
    return rows.length;
  }

  static async markRecipientNotificationFailed(
    sid: string,
    error: string,
    nextAttemptAt: Date | null,
  ): Promise<boolean> {
    const result = await drizzleDb
      .update(txConfirmations)
      .set({
        recipientNotificationStatus: nextAttemptAt ? "retryable_failed" : "failed",
        recipientNotificationNextAttemptAt: nextAttemptAt,
        recipientNotificationLastError: error.slice(0, 2_000),
      })
      .where(
        and(
          eq(txConfirmations.sid, sid),
          eq(txConfirmations.recipientNotificationStatus, "processing"),
        ),
      )
      .returning({ sid: txConfirmations.sid });
    return result.length > 0;
  }

  private static async resolve(sid: string, status: "confirmed" | "failed"): Promise<boolean> {
    const result = await drizzleDb
      .update(txConfirmations)
      .set({ status, resolvedAt: sql`CURRENT_TIMESTAMP` })
      .where(
        and(
          eq(txConfirmations.sid, sid),
          inArray(txConfirmations.status, ["pending", "submitted"]),
        ),
      )
      .returning({ sid: txConfirmations.sid });
    return result.length > 0;
  }

  static markConfirmed(sid: string): Promise<boolean> {
    return this.resolve(sid, "confirmed");
  }

  static async markMcpCompleted(sid: string, txHash?: string): Promise<boolean> {
    const result = await drizzleDb
      .update(txConfirmations)
      .set({
        status: "confirmed",
        txHash: txHash ? txHash : sql`COALESCE(${txConfirmations.txHash}, ${txHash ?? null})`,
        submittedAt: txHash
          ? sql`COALESCE(${txConfirmations.submittedAt}, CURRENT_TIMESTAMP)`
          : sql`${txConfirmations.submittedAt}`,
        resolvedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(txConfirmations.sid, sid),
          inArray(txConfirmations.status, ["pending", "submitted"]),
        ),
      )
      .returning({ sid: txConfirmations.sid });
    return result.length > 0;
  }

  static markFailed(sid: string): Promise<boolean> {
    return this.resolve(sid, "failed");
  }

  /**
   * Mark all rows that have passed their `expires_at` timestamp and are still
   * in a non-terminal state as `failed`. Returns the number of rows expired.
   * Called by pollers to prevent stale pending rows from accumulating.
   */
  static async expireStale(): Promise<number> {
    const result = await drizzleDb
      .update(txConfirmations)
      .set({ status: "failed", resolvedAt: new Date() })
      .where(
        and(
          inArray(txConfirmations.status, ["pending", "submitted"]),
          lt(txConfirmations.expiresAt, new Date()),
        ),
      );
    return (result as unknown as { rowCount?: number }).rowCount ?? 0;
  }

  static async getBySid(sid: string): Promise<TxConfirmationRow | null> {
    const row = await drizzleDb.query.txConfirmations.findFirst({
      where: (t, { eq }) => eq(t.sid, sid),
    });
    return row ? TxConfirmationAdapter.mapRow(row) : null;
  }

  private static mapRow(row: typeof txConfirmations.$inferSelect): TxConfirmationRow {
    return {
      sid: row.sid,
      sender_id: row.senderId,
      from_address: row.fromAddress,
      chain_id: row.chainId,
      label: row.label ?? null,
      status: row.status as TxConfirmationStatus,
      tx_hash: row.txHash ?? null,
      mcp_request_id: row.mcpRequestId ?? null,
      approval_url: row.approvalUrl ?? null,
      recipient_phone: row.recipientPhone ?? null,
      transfer_amount: row.transferAmount ?? null,
      transfer_asset: row.transferAsset ?? null,
      transfer_memo: row.transferMemo ?? null,
      recipient_notification_status:
        (row.recipientNotificationStatus as RecipientNotificationStatus | null) ?? null,
      recipient_notification_attempts: row.recipientNotificationAttempts,
      recipient_notification_next_attempt_at: row.recipientNotificationNextAttemptAt ?? null,
      recipient_notification_last_error: row.recipientNotificationLastError ?? null,
      recipient_notification_accepted_at: row.recipientNotificationAcceptedAt ?? null,
      recipient_claim_status: (row.recipientClaimStatus as RecipientClaimStatus | null) ?? null,
      recipient_claim_processing_at: row.recipientClaimProcessingAt ?? null,
      recipient_claim_sent_at: row.recipientClaimSentAt ?? null,
      created_at: row.createdAt as Date,
      submitted_at: row.submittedAt ?? null,
      resolved_at: row.resolvedAt ?? null,
      expires_at: row.expiresAt as Date,
    };
  }
}
