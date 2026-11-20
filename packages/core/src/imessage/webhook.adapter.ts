import { db } from "@/discovery/db.js";

export type WebhookDeliveryStatus = "pending" | "processing" | "done" | "failed";

export interface WebhookDeliveryRow {
  id: number;
  dedupe_key: string;
  webhook_id: string;
  message_id: string;
  space_id: string;
  sender_id: string;
  payload: unknown;
  status: WebhookDeliveryStatus;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Persistent store for Spectrum webhook deliveries.
 *
 * Responsibilities:
 *  - Deduplicate incoming deliveries via a unique `dedupe_key` so retries
 *    from Spectrum's worker never process the same message twice.
 *  - Provide a reliable background processing queue: the webhook route
 *    ACKs immediately and the processor drains rows asynchronously.
 *  - Track attempts and last error for observability.
 *  - Recover rows stuck in `processing` after a crash.
 */
export class WebhookDeliveryAdapter {
  static async createTable(): Promise<void> {
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS imessage_webhook_deliveries (
          id         SERIAL PRIMARY KEY,
          dedupe_key TEXT    NOT NULL UNIQUE,
          webhook_id TEXT    NOT NULL,
          message_id TEXT    NOT NULL,
          space_id   TEXT    NOT NULL,
          sender_id  TEXT    NOT NULL,
          payload    JSONB   NOT NULL,
          status     TEXT    NOT NULL DEFAULT 'pending',
          attempts   INT     NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      // Fast lookup for the processor: pending/failed rows ordered by age.
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_imessage_wh_status_created
          ON imessage_webhook_deliveries (status, created_at)
          WHERE status IN ('pending', 'failed')
      `);
      console.log("imessage_webhook_deliveries table created or already exists.");
    } catch (err) {
      console.error("Error creating imessage_webhook_deliveries table:", err);
    }
  }

  /**
   * Insert a new delivery row if the dedupe key has not been seen before.
   * Uses INSERT … ON CONFLICT DO NOTHING so duplicate deliveries from
   * Spectrum's retry worker are silently dropped.
   *
   * Returns `true` if the row was inserted (novel delivery), `false` if it
   * was a duplicate.
   *
   * On a novel insertion the method also fires `NOTIFY imessage_webhook` so
   * any processor that is LISTENing wakes up immediately instead of waiting
   * for the next polling interval.
   */
  static async insertIfNew(args: {
    dedupeKey: string;
    webhookId: string;
    messageId: string;
    spaceId: string;
    senderId: string;
    payload: unknown;
  }): Promise<boolean> {
    const result = await db.query(
      `INSERT INTO imessage_webhook_deliveries
         (dedupe_key, webhook_id, message_id, space_id, sender_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [
        args.dedupeKey,
        args.webhookId,
        args.messageId,
        args.spaceId,
        args.senderId,
        JSON.stringify(args.payload),
      ],
    );
    const inserted = (result.rowCount ?? 0) > 0;
    if (inserted) {
      // Fire-and-forget: wake any LISTEN-based processor immediately.
      // Errors are non-fatal — the processor will still poll at PROCESSOR_POLL_MS.
      db.query("NOTIFY imessage_webhook").catch(() => {});
    }
    return inserted;
  }

  /**
   * Atomically claim up to `limit` pending deliveries for processing.
   *
   * Ordering guarantee (single- and multi-instance):
   *  - `DISTINCT ON (d.space_id)` ordered by `created_at ASC` picks the
   *    OLDEST pending row for each space — so messages within a conversation
   *    are always dispatched in arrival order.
   *  - `NOT EXISTS (… WHERE status = 'processing')` prevents a second row for
   *    the same space from being claimed while an earlier row is still being
   *    processed. Combined with the above, this enforces strict per-space
   *    serialisation at the DB level, making the in-memory `spaceChains` Map
   *    redundant and safe to remove.
   *  - `FOR UPDATE SKIP LOCKED` prevents concurrent worker instances from
   *    double-claiming any single row.
   */
  static async claimPending(limit = 10): Promise<WebhookDeliveryRow[]> {
    // DISTINCT ON and FOR UPDATE SKIP LOCKED cannot be combined directly in
    // PostgreSQL. Use a CTE: inner query picks one pending row per space_id,
    // outer query locks those specific rows before updating.
    const result = await db.query<WebhookDeliveryRow>(
      `WITH candidates AS (
          SELECT DISTINCT ON (d.space_id) d.id
            FROM imessage_webhook_deliveries d
           WHERE (
                   d.status = 'pending'
                   OR (
                     d.status = 'failed'
                     AND d.updated_at < NOW() - interval '3 seconds'
                   )
                 )
             AND d.attempts < 5
             AND NOT EXISTS (
               SELECT 1 FROM imessage_webhook_deliveries
                WHERE space_id = d.space_id
                  AND status = 'processing'
             )
           ORDER BY d.space_id, d.created_at ASC
           LIMIT $1
       ),
       locked AS (
          SELECT id FROM imessage_webhook_deliveries
           WHERE id IN (SELECT id FROM candidates)
             FOR UPDATE SKIP LOCKED
       )
       UPDATE imessage_webhook_deliveries
          SET status = 'processing',
              attempts = attempts + 1,
              updated_at = NOW()
        WHERE id IN (SELECT id FROM locked)
        RETURNING *`,
      [limit],
    );
    return result.rows;
  }

  static async markDone(id: number): Promise<void> {
    await db.query(
      `UPDATE imessage_webhook_deliveries
          SET status = 'done', updated_at = NOW()
        WHERE id = $1`,
      [id],
    );
  }

  static async markFailed(id: number, error: string): Promise<void> {
    await db.query(
      `UPDATE imessage_webhook_deliveries
          SET status = 'failed',
              last_error = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [id, error.slice(0, 1000)],
    );
  }

  /**
   * Recover rows that were claimed for processing but never completed —
   * likely because the process crashed while handling them. Resets them to
   * `pending` so they will be retried on the next poll cycle.
   *
   * Safe to run periodically. Default ~2 min aligns with handler timeout.
   */
  static async recoverStuck(olderThanMs = 120_000): Promise<number> {
    const result = await db.query(
      `UPDATE imessage_webhook_deliveries
          SET status = 'pending', updated_at = NOW()
        WHERE status = 'processing'
          AND updated_at < NOW() - ($1::bigint * interval '1 millisecond')
        RETURNING id`,
      [olderThanMs],
    );
    return result.rowCount ?? 0;
  }
}
