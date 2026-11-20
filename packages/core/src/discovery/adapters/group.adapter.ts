import { eq, sql } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import { groups } from "@/db/schema/index.js";

interface GroupInsertParams {
  groupId: string;
  groupName?: string;
  groupType?: string;
  createdBy?: string;
  memberCount?: number;
  description?: string;
  originalGroupId?: string;
  totalMessages?: number;
  totalMentionedMessages?: number;
  totalLeaves?: number;
  metadata?: Record<string, unknown> | null;
}

export class GroupAdapter {
  /** @deprecated Tables are now managed via Drizzle migrations. */
  static async createTable(): Promise<void> {}

  static async insertGroupDetails(params: GroupInsertParams): Promise<void> {
    try {
      await drizzleDb
        .insert(groups)
        .values({
          groupId: params.groupId,
          groupName: params.groupName || params.groupId,
          groupType: params.groupType || "activity",
          createdBy: params.createdBy || null,
          memberCount: params.memberCount ?? 0,
          description: params.description || null,
          originalGroupId: params.originalGroupId || null,
          totalMessages: params.totalMessages ?? 0,
          totalMentionedMessages: params.totalMentionedMessages ?? 0,
          totalLeaves: params.totalLeaves ?? 0,
          metadata: params.metadata || {},
        })
        .onConflictDoNothing();
    } catch (error) {
      console.error("Error inserting group details:", error);
    }
  }

  static async checkGroupExists(groupId: string): Promise<boolean> {
    try {
      const row = await drizzleDb.query.groups.findFirst({
        columns: { id: true },
        where: (g, { eq }) => eq(g.groupId, groupId),
      });
      return row != null;
    } catch (error) {
      console.error("Error checking group existence:", error);
      return false;
    }
  }

  static async incrementGroupMemberJoin(groupId: string): Promise<void> {
    try {
      await drizzleDb
        .update(groups)
        .set({
          memberCount: sql`${groups.memberCount} + 1`,
          lastActivityAt: sql`NOW()`,
        })
        .where(eq(groups.groupId, groupId));
    } catch (error) {
      console.error("Error incrementing member join:", error);
    }
  }

  static async incrementGroupMemberLeave(groupId: string): Promise<void> {
    try {
      await drizzleDb
        .update(groups)
        .set({
          memberCount: sql`GREATEST(${groups.memberCount} - 1, 0)`,
          totalLeaves: sql`${groups.totalLeaves} + 1`,
          lastActivityAt: sql`NOW()`,
        })
        .where(eq(groups.groupId, groupId));
    } catch (error) {
      console.error("Error incrementing member leave:", error);
    }
  }

  static async incrementGroupMessage(groupId: string): Promise<void> {
    try {
      await drizzleDb
        .update(groups)
        .set({
          totalMessages: sql`${groups.totalMessages} + 1`,
          lastActivityAt: sql`NOW()`,
        })
        .where(eq(groups.groupId, groupId));
    } catch (error) {
      console.error("Error incrementing group message:", error);
    }
  }

  static async incrementGroupMentionedMessage(groupId: string): Promise<void> {
    try {
      await drizzleDb
        .update(groups)
        .set({
          totalMentionedMessages: sql`${groups.totalMentionedMessages} + 1`,
          lastActivityAt: sql`NOW()`,
        })
        .where(eq(groups.groupId, groupId));
    } catch (error) {
      console.error("Error incrementing mentioned message:", error);
    }
  }

  static async getTotalMembersCount(groupId: string): Promise<number> {
    try {
      const row = await drizzleDb.query.groups.findFirst({
        columns: { memberCount: true },
        where: (g, { eq }) => eq(g.groupId, groupId),
      });
      if (!row) {
        throw new Error(`Group with ID "${groupId}" does not exist.`);
      }
      return row.memberCount ?? 0;
    } catch (error) {
      console.error("Error fetching total member count:", error);
      throw error;
    }
  }
}
