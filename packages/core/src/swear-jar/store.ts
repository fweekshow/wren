import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import {
  swearJarActivity,
  swearJarFines,
  swearJars,
  type SwearJarRosterMember,
} from "@/db/schema/swear-jar.js";

export type SwearJarRow = typeof swearJars.$inferSelect;
export type SwearJarFineRow = typeof swearJarFines.$inferSelect;

const armedCache = new Set<string>();
let armedCacheLoaded = false;

export async function refreshArmedCache(): Promise<void> {
  const rows = await drizzleDb
    .select({ conversationId: swearJars.conversationId })
    .from(swearJars)
    .where(eq(swearJars.status, "active"));
  armedCache.clear();
  for (const row of rows) armedCache.add(row.conversationId);
  armedCacheLoaded = true;
}

export async function isJarArmed(conversationId: string): Promise<boolean> {
  if (!armedCacheLoaded) await refreshArmedCache();
  return armedCache.has(conversationId);
}

export async function getActiveJar(conversationId: string): Promise<SwearJarRow | null> {
  const row = await drizzleDb.query.swearJars.findFirst({
    where: (j, { and: a, eq: e }) => a(e(j.conversationId, conversationId), e(j.status, "active")),
  });
  return row ?? null;
}

export async function armJar(args: {
  conversationId: string;
  potAddress: string;
  roster: SwearJarRosterMember[];
}): Promise<SwearJarRow> {
  const existing = await getActiveJar(args.conversationId);
  if (existing) return existing;

  const [row] = await drizzleDb
    .insert(swearJars)
    .values({
      conversationId: args.conversationId,
      potAddress: args.potAddress,
      roster: args.roster,
      status: "active",
    })
    .returning();
  armedCache.add(args.conversationId);
  armedCacheLoaded = true;
  return row!;
}

export async function disarmJar(conversationId: string): Promise<SwearJarRow | null> {
  const active = await getActiveJar(conversationId);
  if (!active) return null;
  const [row] = await drizzleDb
    .update(swearJars)
    .set({ status: "settled", settledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(swearJars.id, active.id), eq(swearJars.status, "active")))
    .returning();
  armedCache.delete(conversationId);
  return row ?? null;
}

export async function upsertRosterMember(
  jarId: string,
  member: SwearJarRosterMember,
): Promise<void> {
  const jar = await drizzleDb.query.swearJars.findFirst({
    where: (j, { eq: e }) => e(j.id, jarId),
  });
  if (!jar) return;
  const roster = [...((jar.roster ?? []) as SwearJarRosterMember[])];
  const idx = roster.findIndex((m) => m.id.toLowerCase() === member.id.toLowerCase());
  if (idx >= 0) {
    roster[idx] = { ...roster[idx], name: member.name ?? roster[idx]?.name };
  } else {
    roster.push(member);
  }
  await drizzleDb
    .update(swearJars)
    .set({ roster, updatedAt: new Date() })
    .where(eq(swearJars.id, jarId));
}

export async function touchActivity(jarId: string, senderId: string): Promise<void> {
  await drizzleDb
    .insert(swearJarActivity)
    .values({ jarId, senderId, lastMessageAt: new Date(), messageCount: 1 })
    .onConflictDoUpdate({
      target: [swearJarActivity.jarId, swearJarActivity.senderId],
      set: {
        lastMessageAt: new Date(),
        messageCount: sql`${swearJarActivity.messageCount} + 1`,
      },
    });
}

/** Insert fine row; returns null if this source message was already recorded. */
export async function insertFine(args: {
  jarId: string;
  sourceMessageId: string;
  swearerSenderId: string;
  swearerName?: string;
}): Promise<SwearJarFineRow | null> {
  try {
    const [row] = await drizzleDb
      .insert(swearJarFines)
      .values({
        jarId: args.jarId,
        sourceMessageId: args.sourceMessageId,
        swearerSenderId: args.swearerSenderId,
        swearerName: args.swearerName ?? null,
        status: "pending",
      })
      .returning();
    return row ?? null;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (msg.includes("swear_jar_fines_jar_message_idx") || msg.includes("unique")) {
      return null;
    }
    throw err;
  }
}

export async function claimFineForPay(fineId: string): Promise<SwearJarFineRow | null> {
  const [row] = await drizzleDb
    .update(swearJarFines)
    .set({ status: "paying", updatedAt: new Date() })
    .where(and(eq(swearJarFines.id, fineId), eq(swearJarFines.status, "pending")))
    .returning();
  return row ?? null;
}

export async function markFinePaid(fineId: string, txHash: string): Promise<void> {
  await drizzleDb
    .update(swearJarFines)
    .set({ status: "paid", payTxHash: txHash, updatedAt: new Date() })
    .where(eq(swearJarFines.id, fineId));
}

export async function markFinePending(fineId: string): Promise<void> {
  await drizzleDb
    .update(swearJarFines)
    .set({ status: "pending", updatedAt: new Date() })
    .where(eq(swearJarFines.id, fineId));
}

export async function getLatestPaidFineForSwearer(
  jarId: string,
  swearerSenderId: string,
): Promise<SwearJarFineRow | null> {
  const row = await drizzleDb.query.swearJarFines.findFirst({
    where: (f, { and: a, eq: e }) =>
      a(e(f.jarId, jarId), e(f.swearerSenderId, swearerSenderId), e(f.status, "paid")),
    orderBy: (f, { desc: d }) => d(f.createdAt),
  });
  return row ?? null;
}

/** Paid fines for Activity feed backfill (when tx_confirmations was never written). */
export async function listPaidFinesForSender(
  swearerSenderId: string,
  limit = 50,
): Promise<SwearJarFineRow[]> {
  return drizzleDb.query.swearJarFines.findMany({
    where: (f, { and: a, eq: e, isNotNull }) =>
      a(e(f.swearerSenderId, swearerSenderId), e(f.status, "paid"), isNotNull(f.payTxHash)),
    orderBy: (f, { desc: d }) => d(f.createdAt),
    limit,
  });
}

export async function claimFineForRefund(fineId: string): Promise<SwearJarFineRow | null> {
  const [row] = await drizzleDb
    .update(swearJarFines)
    .set({ status: "dismissed", updatedAt: new Date() })
    .where(and(eq(swearJarFines.id, fineId), eq(swearJarFines.status, "paid")))
    .returning();
  return row ?? null;
}

export async function markFineRefunded(fineId: string, txHash: string): Promise<void> {
  await drizzleDb
    .update(swearJarFines)
    .set({ refundTxHash: txHash, updatedAt: new Date() })
    .where(eq(swearJarFines.id, fineId));
}

export async function restoreFinePaid(fineId: string): Promise<void> {
  await drizzleDb
    .update(swearJarFines)
    .set({ status: "paid", updatedAt: new Date() })
    .where(eq(swearJarFines.id, fineId));
}

export async function countPaidFines(jarId: string): Promise<number> {
  const rows = await drizzleDb
    .select({ id: swearJarFines.id })
    .from(swearJarFines)
    .where(and(eq(swearJarFines.jarId, jarId), eq(swearJarFines.status, "paid")));
  return rows.length;
}

export async function countPendingIous(jarId: string, swearerSenderId: string): Promise<number> {
  const rows = await drizzleDb
    .select({ id: swearJarFines.id })
    .from(swearJarFines)
    .where(
      and(
        eq(swearJarFines.jarId, jarId),
        eq(swearJarFines.swearerSenderId, swearerSenderId),
        inArray(swearJarFines.status, ["pending", "paying"]),
      ),
    );
  return rows.length;
}

export async function dismissPendingIous(jarId: string, swearerSenderId: string): Promise<number> {
  const rows = await drizzleDb
    .update(swearJarFines)
    .set({ status: "dismissed", updatedAt: new Date() })
    .where(
      and(
        eq(swearJarFines.jarId, jarId),
        eq(swearJarFines.swearerSenderId, swearerSenderId),
        inArray(swearJarFines.status, ["pending", "paying"]),
      ),
    )
    .returning({ id: swearJarFines.id });
  return rows.length;
}

export type StandingsRow = {
  senderId: string;
  name?: string;
  swearCount: number;
  /** Unpaid pending/paying swears still on the board. */
  unpaidCount: number;
  eligible: boolean;
};

export async function getStandings(jar: SwearJarRow): Promise<StandingsRow[]> {
  const roster = (jar.roster ?? []) as SwearJarRosterMember[];
  const fines = await drizzleDb
    .select()
    .from(swearJarFines)
    .where(and(eq(swearJarFines.jarId, jar.id), inArray(swearJarFines.status, ["paid", "pending", "paying"])));
  const activity = await drizzleDb
    .select()
    .from(swearJarActivity)
    .where(eq(swearJarActivity.jarId, jar.id));

  const swearBy = new Map<string, number>();
  const unpaidBy = new Map<string, number>();
  for (const f of fines) {
    swearBy.set(f.swearerSenderId, (swearBy.get(f.swearerSenderId) ?? 0) + 1);
    if (f.status === "pending" || f.status === "paying") {
      unpaidBy.set(f.swearerSenderId, (unpaidBy.get(f.swearerSenderId) ?? 0) + 1);
    }
  }
  const activeIds = new Set(activity.map((a) => a.senderId));
  for (const f of fines) {
    activeIds.add(f.swearerSenderId);
  }

  return roster.map((m) => ({
    senderId: m.id,
    name: m.name,
    swearCount: swearBy.get(m.id) ?? 0,
    unpaidCount: unpaidBy.get(m.id) ?? 0,
    eligible: activeIds.has(m.id),
  }));
}

export async function claimJarForSettle(jarId: string): Promise<SwearJarRow | null> {
  const [row] = await drizzleDb
    .update(swearJars)
    .set({ status: "settling", updatedAt: new Date() })
    .where(and(eq(swearJars.id, jarId), eq(swearJars.status, "active")))
    .returning();
  if (row) armedCache.delete(row.conversationId);
  return row ?? null;
}

export async function markJarSettled(args: {
  jarId: string;
  winnerSenderId: string | null;
  winnerTxHash: string | null;
  status?: "settled" | "awaiting_claim";
}): Promise<void> {
  await drizzleDb
    .update(swearJars)
    .set({
      status: args.status ?? "settled",
      winnerSenderId: args.winnerSenderId,
      winnerTxHash: args.winnerTxHash,
      settledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(swearJars.id, args.jarId));
}

export async function restoreJarActive(jarId: string, conversationId: string): Promise<void> {
  await drizzleDb
    .update(swearJars)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(swearJars.id, jarId));
  armedCache.add(conversationId);
}

export function pickWinner(standings: StandingsRow[]): StandingsRow | null {
  const eligible = standings.filter((s) => s.eligible);
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    if (a.swearCount !== b.swearCount) return a.swearCount - b.swearCount;
    return a.senderId.localeCompare(b.senderId);
  });
  return eligible[0] ?? null;
}

export function biggestSinner(standings: StandingsRow[]): StandingsRow | null {
  const withSwears = standings.filter((s) => s.swearCount > 0);
  if (withSwears.length === 0) return null;
  withSwears.sort((a, b) => {
    if (a.swearCount !== b.swearCount) return b.swearCount - a.swearCount;
    return a.senderId.localeCompare(b.senderId);
  });
  return withSwears[0] ?? null;
}

export async function getRecentFineAt(
  jarId: string,
  swearerSenderId: string,
): Promise<SwearJarFineRow | null> {
  return (
    (await drizzleDb.query.swearJarFines.findFirst({
      where: (f, { and: a, eq: e }) =>
        a(e(f.jarId, jarId), e(f.swearerSenderId, swearerSenderId)),
      orderBy: (f, { desc: d }) => d(f.createdAt),
    })) ?? null
  );
}

// silence unused import warnings for helpers used only by callers
void asc;
void desc;
