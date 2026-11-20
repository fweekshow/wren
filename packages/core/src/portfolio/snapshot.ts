import { eq } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import { imessageWallets } from "@/db/schema/index.js";
import { db } from "@/discovery/db.js";
import { logger } from "@/utils/logger.js";

import type { ImessagePortfolioPayload } from "./types.js";

let ensured = false;

export async function ensurePortfolioSnapshotColumns(): Promise<void> {
  if (ensured) return;
  await db.query(`
    ALTER TABLE "imessage_wallets"
      ADD COLUMN IF NOT EXISTS "portfolio_snapshot" jsonb
  `);
  await db.query(`
    ALTER TABLE "imessage_wallets"
      ADD COLUMN IF NOT EXISTS "portfolio_snapshot_at" timestamp with time zone
  `);
  ensured = true;
}

export async function getPortfolioSnapshot(
  senderId: string,
): Promise<{ payload: ImessagePortfolioPayload; at: Date } | null> {
  await ensurePortfolioSnapshotColumns();
  const row = await drizzleDb.query.imessageWallets.findFirst({
    columns: { portfolioSnapshot: true, portfolioSnapshotAt: true },
    where: (w, { eq: equals }) => equals(w.senderId, senderId),
  });
  const payload = row?.portfolioSnapshot as ImessagePortfolioPayload | null;
  if (!payload || !row?.portfolioSnapshotAt) return null;
  return { payload, at: row.portfolioSnapshotAt };
}

export async function savePortfolioSnapshot(
  senderId: string,
  payload: ImessagePortfolioPayload,
): Promise<void> {
  await ensurePortfolioSnapshotColumns();
  await drizzleDb
    .update(imessageWallets)
    .set({
      portfolioSnapshot: payload,
      portfolioSnapshotAt: new Date(),
    })
    .where(eq(imessageWallets.senderId, senderId));
}

export async function invalidatePortfolioSnapshot(senderId: string): Promise<void> {
  try {
    await ensurePortfolioSnapshotColumns();
    await drizzleDb
      .update(imessageWallets)
      .set({ portfolioSnapshotAt: null })
      .where(eq(imessageWallets.senderId, senderId));
  } catch (err) {
    logger.warn({ err, senderId }, "could not invalidate portfolio snapshot");
  }
}
