import { eq, inArray, isNotNull, sql } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import {
  buttonClickEvents,
  inboundMessageEvents,
  users,
} from "@/db/schema/index.js";
import { logger } from "@/utils/logger.js";

interface UserInsertParams {
  inboxId: string;
  walletAddress?: string;
  isGroup?: boolean;
}

/** Collapse ephemeral inline-action IDs into stable analytics keys. */
export function normalizeButtonActionKey(actionId: string): string {
  if (/^yes-\d+$/.test(actionId)) return "yes";
  if (/^no-\d+$/.test(actionId)) return "no";
  if (/^confirm-\d+$/.test(actionId)) return "confirm";
  if (/^selection-\d+$/.test(actionId)) return "selection";
  if (actionId.startsWith("join_") && actionId.endsWith("_group")) return "join_group";
  return actionId;
}

export class UserAdapter {
  /** @deprecated Tables are now managed via Drizzle migrations. */
  static async createTable(): Promise<void> {}

  /** @deprecated Use recordButtonClick — upserts the user and sets last_button_click_at. */
  static async incrementActionClick(inboxId: string, actionKey: string): Promise<void> {
    await this.recordButtonClick(inboxId, actionKey);
  }

  /**
   * Record an inline-action button tap: per-user lifetime counts, last-click
   * timestamp (for daily unique-user metrics), and append-only event log.
   */
  static async recordButtonClick(inboxId: string, actionId: string): Promise<void> {
    const actionKey = normalizeButtonActionKey(actionId);
    try {
      // JSONB merge requires raw SQL for the increment-by-key pattern.
      await drizzleDb
        .insert(users)
        .values({
          inboxId,
          actionClicks: { [actionKey]: 1 },
          lastButtonClickAt: new Date(),
        })
        .onConflictDoUpdate({
          target: users.inboxId,
          set: {
            actionClicks: sql`COALESCE(${users.actionClicks}, '{}'::jsonb) || jsonb_build_object(${actionKey}::text, COALESCE((${users.actionClicks}->>${actionKey})::int, 0) + 1)`,
            lastButtonClickAt: sql`NOW()`,
          },
        });

      await drizzleDb.insert(buttonClickEvents).values({ inboxId, actionKey });
    } catch (error) {
      logger.error({ err: error }, "Error recording button click");
    }
  }

  static async incrementRemindersCreated(inboxId: string): Promise<void> {
    try {
      await drizzleDb
        .update(users)
        .set({ remindersCreated: sql`${users.remindersCreated} + 1` })
        .where(eq(users.inboxId, inboxId));
    } catch (error) {
      logger.error({ err: error }, "Error incrementing reminders created");
    }
  }

  static async getWalletAddress(inboxId: string): Promise<string | null> {
    try {
      const row = await drizzleDb.query.users.findFirst({
        columns: { walletAddress: true },
        where: (u, { eq, and, isNotNull }) => and(eq(u.inboxId, inboxId), isNotNull(u.walletAddress)),
      });
      const addr = row?.walletAddress;
      return typeof addr === "string" ? addr.toLowerCase() : null;
    } catch (error) {
      logger.error({ err: error }, "Error fetching user wallet");
      return null;
    }
  }

  static async getWalletAddressesByInboxIds(
    inboxIds: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (inboxIds.length === 0) return map;
    try {
      const rows = await drizzleDb.query.users.findMany({
        columns: { inboxId: true, walletAddress: true },
        where: (u, { and, inArray, isNotNull }) =>
          and(inArray(u.inboxId, inboxIds), isNotNull(u.walletAddress)),
      });
      for (const row of rows) {
        const addr = row.walletAddress;
        if (typeof addr === "string" && /^0x[a-fA-F0-9]{40}$/.test(addr)) {
          map.set(row.inboxId, addr.toLowerCase());
        }
      }
    } catch (error) {
      logger.error({ err: error }, "Error fetching user wallets");
    }
    return map;
  }

  static async recordInboundMessage(
    inboxId: string,
    opts?: { isGroup?: boolean; engaged?: boolean },
  ): Promise<void> {
    const isGroup = opts?.isGroup ?? false;
    const engaged = opts?.engaged ?? true;
    try {
      await drizzleDb.insert(inboundMessageEvents).values({ inboxId, isGroup, engaged });
    } catch (error) {
      logger.error({ err: error }, "Error recording inbound message event");
    }
  }

  static async incrementMessageCount(params: UserInsertParams): Promise<void> {
    const { inboxId, walletAddress, isGroup = false } = params;
    try {
      await drizzleDb
        .insert(users)
        .values({ inboxId, walletAddress: walletAddress ?? null, totalMessages: 1 })
        .onConflictDoUpdate({
          target: users.inboxId,
          set: {
            totalMessages: sql`${users.totalMessages} + 1`,
            lastMessageAt: sql`NOW()`,
          },
        });
      await this.recordInboundMessage(inboxId, { isGroup, engaged: true });
    } catch (error) {
      logger.error({ err: error }, "Error incrementing message count");
    }
  }

  /** Check if we can send a proactive DM to this user (max 1 per 24 h). */
  static async canSendProactiveDM(inboxId: string): Promise<boolean> {
    try {
      const row = await drizzleDb.query.users.findFirst({
        columns: { lastProactiveDmAt: true },
        where: (u, { eq }) => eq(u.inboxId, inboxId),
      });
      if (!row) return true;
      const lastDm = row.lastProactiveDmAt;
      if (!lastDm) return true;
      const hoursSince = (Date.now() - new Date(lastDm).getTime()) / (1000 * 60 * 60);
      return hoursSince >= 24;
    } catch (error) {
      logger.error({ err: error }, "Error checking proactive DM eligibility");
      return false;
    }
  }

  /** Check if a specific group has already been recommended to this user (lifetime dedup). */
  static async hasGroupBeenRecommended(inboxId: string, groupId: string): Promise<boolean> {
    try {
      const row = await drizzleDb.query.users.findFirst({
        columns: { recommendedGroupIds: true },
        where: (u, { eq }) => eq(u.inboxId, inboxId),
      });
      if (!row) return false;
      const ids = (row.recommendedGroupIds as string[]) ?? [];
      return ids.includes(groupId);
    } catch (error) {
      logger.error({ err: error }, "Error checking recommended groups");
      return true;
    }
  }

  /** Get the set of group IDs already recommended to a user (for pre-filtering). */
  static async getRecommendedGroupIds(inboxId: string): Promise<string[]> {
    try {
      const row = await drizzleDb.query.users.findFirst({
        columns: { recommendedGroupIds: true },
        where: (u, { eq }) => eq(u.inboxId, inboxId),
      });
      return (row?.recommendedGroupIds as string[]) ?? [];
    } catch (error) {
      logger.error({ err: error }, "Error getting recommended group IDs");
      return [];
    }
  }

  /** Record that a proactive DM was sent: update timestamp and append group ID. */
  static async recordProactiveRecommendation(inboxId: string, groupId: string): Promise<void> {
    try {
      await drizzleDb
        .update(users)
        .set({
          lastProactiveDmAt: sql`NOW()`,
          recommendedGroupIds: sql`COALESCE(${users.recommendedGroupIds}, '[]'::jsonb) || to_jsonb(${groupId}::text)`,
        })
        .where(eq(users.inboxId, inboxId));
    } catch (error) {
      logger.error({ err: error }, "Error recording proactive recommendation");
    }
  }
}
