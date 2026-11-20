import { and, desc, eq } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import { db } from "@/discovery/db.js";
import { pendingRecommendations } from "@/db/schema/index.js";

export interface PendingRecommendation {
  id: number;
  sender_inbox_id: string;
  sender_wallet_address: string | null;
  source_group_id: string;
  target_group_id: string;
  target_group_name: string;
  target_group_image_url: string | null;
  score: number;
  reasoning: string | null;
  detected_interests: string[];
  status: "pending" | "sent" | "failed";
  created_at: Date;
  sent_at: Date | null;
}

export class RecommendationAdapter {
  /** @deprecated Tables are now managed via Drizzle migrations. */
  static async createTable(): Promise<void> {}

  static async insert(rec: {
    senderInboxId: string;
    senderWalletAddress: string | null;
    sourceGroupId: string;
    targetGroupId: string;
    targetGroupName: string;
    targetGroupImageUrl: string | null;
    score: number;
    reasoning: string | null;
    detectedInterests: string[];
  }): Promise<boolean> {
    const client = await db.connect();
    try {
      const result = await client.query(
        `INSERT INTO pending_recommendations
          (sender_inbox_id, sender_wallet_address, source_group_id, target_group_id,
           target_group_name, target_group_image_url, score, reasoning, detected_interests)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (sender_inbox_id, target_group_id) DO NOTHING`,
        [
          rec.senderInboxId,
          rec.senderWalletAddress,
          rec.sourceGroupId,
          rec.targetGroupId,
          rec.targetGroupName,
          rec.targetGroupImageUrl,
          rec.score,
          rec.reasoning,
          rec.detectedInterests,
        ],
      );
      return (result.rowCount ?? 0) > 0;
    } finally {
      client.release();
    }
  }

  /** Uses raw SQL for the correlated EXISTS subquery against ns_groups. */
  static async getNextPending(): Promise<PendingRecommendation | null> {
    const client = await db.connect();
    try {
      const result = await client.query<PendingRecommendation>(
        `SELECT pr.* FROM pending_recommendations pr
          WHERE pr.status = 'pending'
            AND EXISTS (
              SELECT 1 FROM ns_groups g
              WHERE g.group_id = pr.target_group_id AND g.agent_in_group = true
            )
          ORDER BY pr.score DESC
          LIMIT 1`,
      );
      return result.rows[0] ?? null;
    } finally {
      client.release();
    }
  }

  /** Uses raw SQL for the NOT EXISTS correlated subquery against ns_groups. */
  static async failPendingForUnreachableGroups(): Promise<number> {
    const client = await db.connect();
    try {
      const result = await client.query(
        `UPDATE pending_recommendations pr
         SET status = 'failed'
         WHERE pr.status = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM ns_groups g
             WHERE g.group_id = pr.target_group_id AND g.agent_in_group = true
           )`,
      );
      return result.rowCount ?? 0;
    } finally {
      client.release();
    }
  }

  static async markSent(id: number): Promise<void> {
    await drizzleDb
      .update(pendingRecommendations)
      .set({ status: "sent", sentAt: new Date() })
      .where(eq(pendingRecommendations.id, String(id)));
  }

  static async markFailed(id: number): Promise<void> {
    await drizzleDb
      .update(pendingRecommendations)
      .set({ status: "failed" })
      .where(eq(pendingRecommendations.id, String(id)));
  }

  static async getUserInterests(inboxId: string): Promise<string[]> {
    const rows = await drizzleDb
      .select({ reasoning: pendingRecommendations.reasoning })
      .from(pendingRecommendations)
      .where(
        and(
          eq(pendingRecommendations.senderInboxId, inboxId),
          eq(pendingRecommendations.status, "sent"),
        ),
      )
      .orderBy(desc(pendingRecommendations.createdAt))
      .limit(20);

    const interests = new Set<string>();
    for (const row of rows) {
      const parts = row.reasoning?.split(":");
      if (parts && parts.length >= 2 && parts[1]) interests.add(parts[1].trim());
    }
    return [...interests];
  }
}
