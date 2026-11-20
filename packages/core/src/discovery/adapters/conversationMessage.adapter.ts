/**
 * conversationMessage.adapter.ts
 *
 * Durable write-through for the full AI conversation transcript.
 * Every user+assistant turn is written here fire-and-forget so that
 * the DiscoveryAI cold-start bootstrap can recover history even after
 * the Redis TTL expires (>24h gap between sessions).
 *
 * Methods:
 *   insert(row)          — append a single message row (non-throwing)
 *   getRecent(convId, n) — fetch the last n rows for a conversation, oldest-first
 */

import { asc, desc, eq } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import { conversationMessages } from "@/db/schema/index.js";

export interface ConversationMessageRow {
  inboxId: string;
  conversationId: string;
  platform: string;
  role: "user" | "assistant";
  content: string;
}

export class ConversationMessageAdapter {
  /**
   * Write a single message row.  Intentionally swallows errors so a DB hiccup
   * never blocks the main AI response path.
   */
  static async insert(row: ConversationMessageRow): Promise<void> {
    try {
      await drizzleDb.insert(conversationMessages).values(row);
    } catch (err: unknown) {
      // Non-fatal — history write failures are tolerable on the hot path
      console.warn(
        "⚠️ [ConversationMessageAdapter] insert failed:",
        (err as Error)?.message || err,
      );
    }
  }

  /**
   * Return the most-recent `limit` messages for a conversation, in chronological
   * order (oldest first) so they slot directly into the OpenAI messages array.
   * Returns [] on any error.
   */
  static async getRecent(
    conversationId: string,
    limit = 12,
  ): Promise<{ role: "user" | "assistant"; content: string }[]> {
    try {
      // Subquery pattern: grab the latest `limit` rows by created_at DESC,
      // then re-order ASC for the caller.
      const rows = await drizzleDb
        .select({
          role: conversationMessages.role,
          content: conversationMessages.content,
          createdAt: conversationMessages.createdAt,
        })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, conversationId))
        .orderBy(desc(conversationMessages.createdAt))
        .limit(limit);

      return rows
        .reverse()
        .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
    } catch (err: unknown) {
      console.warn(
        "⚠️ [ConversationMessageAdapter] getRecent failed:",
        (err as Error)?.message || err,
      );
      return [];
    }
  }
}
