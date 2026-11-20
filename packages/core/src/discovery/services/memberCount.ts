import { db } from "@/discovery/db.js";
import { ActivityAdapter } from "@/discovery/adapters/activity.adapter.js";
import { GroupMemberSnapshotAdapter } from "@/discovery/adapters/groupMemberSnapshot.adapter.js";

export interface MemberCountUpdate {
  groupId: string;
  previous: number;
  current: number;
  delta: number;
  /** true when the distinct-chatter floor was higher than the raw members() read */
  flooredUp: boolean;
}

/**
 * Single source of truth for refreshing a group's member count.
 *
 * Given a freshly-read live member count (from `conversation.members()`), this:
 *  1. Floors the value at the number of DISTINCT people we've actually seen chat
 *     in the last 7d, so XMTP membership-sync lag can't under-report
 *     (the "2 members but 6 people are clearly chatting" bug).
 *  2. Writes the floored count to `ns_groups.total_members`.
 *  3. Records the change as an accurate join/leave delta in
 *     `group_activity_hourly` (delta = new - previous, not "+1 per event").
 *  4. Upserts today's `group_member_snapshots` row so growth/new-member
 *     tracking stays correct.
 *
 * Both the per-group join event (`onGroupUpdate`) and the daily `syncAll`
 * reconciler call this, so they can never double-count: prev is read from the
 * stored total, so if the event path already bumped the count, the daily pass
 * sees delta=0.
 */
export async function reconcileMemberCount(
  groupId: string,
  rawMemberCount: number,
): Promise<MemberCountUpdate> {
  const rawCount = Math.max(0, Math.trunc(rawMemberCount));
  const floor = await ActivityAdapter.getRecentDistinctChatterCount(groupId).catch(() => 0);
  const current = Math.max(rawCount, floor);

  const client = await db.connect();
  let previous = 0;
  try {
    const sel = await client.query(
      `SELECT COALESCE(total_members, 0) AS c FROM ns_groups WHERE group_id = $1`,
      [groupId],
    );

    // Group not indexed yet — let the onGroup handler create the row first.
    if (sel.rowCount === 0) {
      return { groupId, previous: 0, current: rawCount, delta: 0, flooredUp: false };
    }

    previous = Number(sel.rows[0]?.c) || 0;

    if (current !== previous) {
      await client.query(
        `UPDATE ns_groups SET total_members = $2, updated_at = CURRENT_TIMESTAMP WHERE group_id = $1`,
        [groupId, current],
      );
    }
  } finally {
    client.release();
  }

  const delta = current - previous;
  if (delta > 0) {
    await ActivityAdapter.addMemberJoins(groupId, delta).catch(() => {});
  } else if (delta < 0) {
    await ActivityAdapter.addMemberLeaves(groupId, -delta).catch(() => {});
  }

  // Always snapshot today's count (latest read wins) for growth tracking.
  await GroupMemberSnapshotAdapter.recordSnapshot(groupId, current).catch(() => {});

  return { groupId, previous, current, delta, flooredUp: floor > rawCount };
}
