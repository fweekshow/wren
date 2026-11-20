import { db } from "@/discovery/db.js";

export interface MemberGrowthRow {
  group_id: string;
  name: string | null;
  baseline_count: number;
  current_count: number;
  delta: number;
  latest_date: string;
  baseline_date: string | null;
}

export interface MemberGrowthResult {
  days: number;
  cutoffDate: string;
  totalNetNewMembers: number;
  totalNewMembers: number;
  totalLostMembers: number;
  groupsTracked: number;
  groups: MemberGrowthRow[];
}

/**
 * Daily snapshots of per-group member counts for groups Basemate is in.
 */
export class GroupMemberSnapshotAdapter {
  /** @deprecated Tables are now managed via Drizzle migrations. */
  static async createTable(): Promise<void> {}

  /**
   * Upsert today's member-count snapshot for many groups at once.
   * Uses raw SQL for the `unnest` array spread pattern.
   */
  static async recordSnapshotsBulk(
    entries: Array<{ groupId: string; memberCount: number }>,
  ): Promise<number> {
    if (entries.length === 0) return 0;
    const groupIds = entries.map((e) => e.groupId);
    const counts = entries.map((e) => Math.max(0, Math.trunc(e.memberCount)));
    const client = await db.connect();
    try {
      const res = await client.query(
        `INSERT INTO group_member_snapshots (group_id, member_count)
         SELECT * FROM unnest($1::varchar[], $2::int[])
         ON CONFLICT (group_id, snapshot_date)
         DO UPDATE SET member_count = EXCLUDED.member_count, captured_at = NOW()`,
        [groupIds, counts],
      );
      return res.rowCount || 0;
    } finally {
      client.release();
    }
  }

  static async recordSnapshot(groupId: string, memberCount: number): Promise<void> {
    await this.recordSnapshotsBulk([{ groupId, memberCount }]);
  }

  /**
   * Uses a complex multi-CTE query (DISTINCT ON, LEFT JOIN across 4 tables).
   * Kept as raw SQL because Drizzle's query builder does not yet support
   * DISTINCT ON or CTEs in SELECT statements.
   */
  static async getNewMembersSince(days: number): Promise<MemberGrowthResult> {
    const safeDays = Math.max(1, Math.trunc(days));
    const client = await db.connect();
    try {
      const { rows } = await client.query(
        `WITH latest AS (
           SELECT DISTINCT ON (group_id)
             group_id, member_count AS current_count, snapshot_date AS latest_date
           FROM group_member_snapshots
           ORDER BY group_id, snapshot_date DESC
         ),
         baseline AS (
           SELECT DISTINCT ON (group_id)
             group_id, member_count AS baseline_count, snapshot_date AS baseline_date
           FROM group_member_snapshots
           WHERE snapshot_date <= (CURRENT_DATE - ($1::int))
           ORDER BY group_id, snapshot_date DESC
         ),
         earliest AS (
           SELECT DISTINCT ON (group_id)
             group_id, member_count AS baseline_count, snapshot_date AS baseline_date
           FROM group_member_snapshots
           ORDER BY group_id, snapshot_date ASC
         )
         SELECT
           l.group_id,
           g.name,
           COALESCE(b.baseline_count, e.baseline_count) AS baseline_count,
           l.current_count,
           l.current_count - COALESCE(b.baseline_count, e.baseline_count) AS delta,
           to_char(l.latest_date, 'YYYY-MM-DD') AS latest_date,
           to_char(COALESCE(b.baseline_date, e.baseline_date), 'YYYY-MM-DD') AS baseline_date
         FROM latest l
         LEFT JOIN baseline b ON b.group_id = l.group_id
         LEFT JOIN earliest e ON e.group_id = l.group_id
         LEFT JOIN ns_groups g ON g.group_id = l.group_id
         ORDER BY delta DESC`,
        [safeDays],
      );

      const groups: MemberGrowthRow[] = rows.map((r) => ({
        group_id: r.group_id,
        name: r.name ?? null,
        baseline_count: Number(r.baseline_count) || 0,
        current_count: Number(r.current_count) || 0,
        delta: Number(r.delta) || 0,
        latest_date: r.latest_date,
        baseline_date: r.baseline_date ?? null,
      }));

      const totalNetNewMembers = groups.reduce((s, g) => s + g.delta, 0);
      const totalNewMembers = groups.reduce((s, g) => s + Math.max(0, g.delta), 0);
      const totalLostMembers = groups.reduce((s, g) => s + Math.max(0, -g.delta), 0);

      const cutoff = await client.query(
        `SELECT to_char(CURRENT_DATE - ($1::int), 'YYYY-MM-DD') AS cutoff`,
        [safeDays],
      );

      return {
        days: safeDays,
        cutoffDate: cutoff.rows[0]?.cutoff ?? "",
        totalNetNewMembers,
        totalNewMembers,
        totalLostMembers,
        groupsTracked: groups.length,
        groups,
      };
    } finally {
      client.release();
    }
  }
}
