import { sql } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import { db } from "@/discovery/db.js";
import { groupActivityHourly } from "@/db/schema/index.js";

export interface HourlyActivity {
  id: number;
  group_id: string;
  hour_bucket: Date;
  message_count: number;
  member_joins: number;
  member_leaves: number;
  active_user_ids: string[];
  unique_active_users: number;
  created_at: Date;
  updated_at: Date;
}

export class ActivityAdapter {
  /** @deprecated Tables are now managed via Drizzle migrations. */
  static async createTable(): Promise<void> {}

  static getCurrentHourBucket(): Date {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    return now;
  }

  /**
   * Increment message count for current hour.
   * Uses raw SQL for the ARRAY conditional logic which Drizzle doesn't support natively.
   */
  static async incrementMessage(groupId: string, userInboxId: string): Promise<void> {
    const hourBucket = this.getCurrentHourBucket();
    const client = await db.connect();
    try {
      await client.query(
        `INSERT INTO group_activity_hourly (
          group_id, hour_bucket, message_count, active_user_ids, unique_active_users
        ) VALUES ($1, $2, 1, ARRAY[$3], 1)
        ON CONFLICT (group_id, hour_bucket)
        DO UPDATE SET
          message_count = group_activity_hourly.message_count + 1,
          active_user_ids = CASE
            WHEN $3 = ANY(group_activity_hourly.active_user_ids)
            THEN group_activity_hourly.active_user_ids
            ELSE array_append(group_activity_hourly.active_user_ids, $3)
          END,
          unique_active_users = CASE
            WHEN $3 = ANY(group_activity_hourly.active_user_ids)
            THEN group_activity_hourly.unique_active_users
            ELSE group_activity_hourly.unique_active_users + 1
          END,
          updated_at = NOW()`,
        [groupId, hourBucket, userInboxId],
      );
    } finally {
      client.release();
    }
  }

  static async incrementMemberJoin(groupId: string): Promise<void> {
    const hourBucket = this.getCurrentHourBucket();
    await drizzleDb
      .insert(groupActivityHourly)
      .values({ groupId, hourBucket, memberJoins: 1 })
      .onConflictDoUpdate({
        target: [groupActivityHourly.groupId, groupActivityHourly.hourBucket],
        set: {
          memberJoins: sql`${groupActivityHourly.memberJoins} + 1`,
          updatedAt: sql`NOW()`,
        },
      });
  }

  static async incrementMemberLeave(groupId: string): Promise<void> {
    const hourBucket = this.getCurrentHourBucket();
    await drizzleDb
      .insert(groupActivityHourly)
      .values({ groupId, hourBucket, memberLeaves: 1 })
      .onConflictDoUpdate({
        target: [groupActivityHourly.groupId, groupActivityHourly.hourBucket],
        set: {
          memberLeaves: sql`${groupActivityHourly.memberLeaves} + 1`,
          updatedAt: sql`NOW()`,
        },
      });
  }

  static async addMemberJoins(groupId: string, count: number): Promise<void> {
    const n = Math.trunc(count);
    if (n <= 0) return;
    const hourBucket = this.getCurrentHourBucket();
    await drizzleDb
      .insert(groupActivityHourly)
      .values({ groupId, hourBucket, memberJoins: n })
      .onConflictDoUpdate({
        target: [groupActivityHourly.groupId, groupActivityHourly.hourBucket],
        set: {
          memberJoins: sql`${groupActivityHourly.memberJoins} + ${n}`,
          updatedAt: sql`NOW()`,
        },
      });
  }

  static async addMemberLeaves(groupId: string, count: number): Promise<void> {
    const n = Math.trunc(count);
    if (n <= 0) return;
    const hourBucket = this.getCurrentHourBucket();
    await drizzleDb
      .insert(groupActivityHourly)
      .values({ groupId, hourBucket, memberLeaves: n })
      .onConflictDoUpdate({
        target: [groupActivityHourly.groupId, groupActivityHourly.hourBucket],
        set: {
          memberLeaves: sql`${groupActivityHourly.memberLeaves} + ${n}`,
          updatedAt: sql`NOW()`,
        },
      });
  }

  /** Uses raw SQL because it relies on `unnest` + `LATERAL` which Drizzle's query builder doesn't support. */
  static async getRecentDistinctChatterCount(groupId: string, days = 7): Promise<number> {
    const windowDays = Math.min(7, Math.max(1, Math.trunc(days)));
    const client = await db.connect();
    try {
      const result = await client.query(
        `SELECT COUNT(DISTINCT uid) AS c
         FROM group_activity_hourly gah,
         LATERAL unnest(COALESCE(gah.active_user_ids, ARRAY[]::text[])) AS uid
         WHERE gah.group_id = $1
           AND gah.hour_bucket >= NOW() - ($2::int * INTERVAL '1 day')`,
        [groupId, windowDays],
      );
      return Number(result.rows[0]?.c) || 0;
    } finally {
      client.release();
    }
  }

  static async get6HourActivity(groupId: string): Promise<HourlyActivity[]> {
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const client = await db.connect();
    try {
      const result = await client.query<HourlyActivity>(
        `SELECT * FROM group_activity_hourly
          WHERE group_id = $1 AND hour_bucket >= $2
          ORDER BY hour_bucket ASC`,
        [groupId, sixHoursAgo],
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  static async getAll6HourActivity(): Promise<Map<string, HourlyActivity[]>> {
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const client = await db.connect();
    try {
      const result = await client.query<HourlyActivity>(
        `SELECT * FROM group_activity_hourly
          WHERE hour_bucket >= $1
          ORDER BY group_id, hour_bucket ASC`,
        [sixHoursAgo],
      );
      const activityMap = new Map<string, HourlyActivity[]>();
      for (const row of result.rows) {
        if (!activityMap.has(row.group_id)) activityMap.set(row.group_id, []);
        activityMap.get(row.group_id)!.push(row);
      }
      return activityMap;
    } finally {
      client.release();
    }
  }

  static async cleanupOldData(): Promise<number> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const client = await db.connect();
    try {
      const result = await client.query(
        `DELETE FROM group_activity_hourly WHERE hour_bucket < $1`,
        [sevenDaysAgo],
      );
      const deletedCount = result.rowCount || 0;
      if (deletedCount > 0) console.log(`Deleted ${deletedCount} old activity rows`);
      return deletedCount;
    } finally {
      client.release();
    }
  }
}
