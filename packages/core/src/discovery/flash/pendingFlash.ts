import { and, eq, gt, sql } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import { pendingFlashOrders } from "@/db/schema/index.js";

import {
  flashActivityAmountAsset,
  flashFillTxHash,
  formatFlashActivityLabel,
  isFlashOrderFilled,
  isFlashOrderTerminalFail,
  recordFlashFillActivity,
} from "./activity.js";
import { flashGetOrder } from "./client.js";
import type { FlashOrderDetail, FlashPreparedOrder } from "./types.js";

export type PendingFlashRow = typeof pendingFlashOrders.$inferSelect;

/** Limit / TWAP can rest for a while; expire watches after 7 days. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class PendingFlashAdapter {
  static async track(args: {
    orderId: string;
    senderId: string;
    prepared: FlashPreparedOrder;
  }): Promise<PendingFlashRow> {
    const { amount, asset } = flashActivityAmountAsset(args.prepared);
    const label = formatFlashActivityLabel(args.prepared);
    const [row] = await drizzleDb
      .insert(pendingFlashOrders)
      .values({
        orderId: args.orderId,
        senderId: args.senderId,
        funderAddress: args.prepared.funderAddress.toLowerCase(),
        label,
        amount,
        asset,
        prepared: args.prepared,
        status: "open",
        expiresAt: new Date(Date.now() + TTL_MS),
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    const existing = await drizzleDb.query.pendingFlashOrders.findFirst({
      where: (t, { eq: e }) => e(t.orderId, args.orderId),
    });
    if (!existing) throw new Error("failed to track pending flash order");
    return existing;
  }

  static async listOpen(limit = 50): Promise<PendingFlashRow[]> {
    const now = new Date();
    return drizzleDb
      .select()
      .from(pendingFlashOrders)
      .where(
        and(eq(pendingFlashOrders.status, "open"), gt(pendingFlashOrders.expiresAt, now)),
      )
      .limit(limit);
  }

  /** Win the open→filled transition; returns false if already resolved. */
  static async markFilled(orderId: string, fillTxHash: string | null): Promise<boolean> {
    const [row] = await drizzleDb
      .update(pendingFlashOrders)
      .set({
        status: "filled",
        fillTxHash,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(eq(pendingFlashOrders.orderId, orderId), eq(pendingFlashOrders.status, "open")),
      )
      .returning({ orderId: pendingFlashOrders.orderId });
    return Boolean(row);
  }

  static async markTerminal(
    orderId: string,
    status: "cancelled" | "failed" | "expired",
  ): Promise<boolean> {
    const [row] = await drizzleDb
      .update(pendingFlashOrders)
      .set({ status, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(
        and(eq(pendingFlashOrders.orderId, orderId), eq(pendingFlashOrders.status, "open")),
      )
      .returning({ orderId: pendingFlashOrders.orderId });
    return Boolean(row);
  }

  static async setActivitySid(orderId: string, activitySid: string): Promise<void> {
    await drizzleDb
      .update(pendingFlashOrders)
      .set({ activitySid, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(pendingFlashOrders.orderId, orderId));
  }

  static async expireStale(): Promise<number> {
    const now = new Date();
    const rows = await drizzleDb
      .update(pendingFlashOrders)
      .set({ status: "expired", updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(
        and(
          eq(pendingFlashOrders.status, "open"),
          sql`${pendingFlashOrders.expiresAt} <= ${now}`,
        ),
      )
      .returning({ orderId: pendingFlashOrders.orderId });
    return rows.length;
  }
}

/**
 * Win open→filled, then write Activity once. Safe under concurrent pollers.
 */
export async function resolveFlashFillOnce(args: {
  orderId: string;
  senderId: string;
  prepared: FlashPreparedOrder;
  detail?: FlashOrderDetail | null;
}): Promise<{ recorded: boolean; txHash: string | null }> {
  let detail = args.detail ?? null;
  if (!detail) {
    try {
      detail = await flashGetOrder({
        orderId: args.orderId,
        funderAddress: args.prepared.funderAddress,
      });
    } catch {
      return { recorded: false, txHash: null };
    }
  }

  if (isFlashOrderTerminalFail(detail.status)) {
    const status = detail.status === "ORDER_STATUS_CANCELLED" ? "cancelled" : "failed";
    await PendingFlashAdapter.markTerminal(args.orderId, status);
    return { recorded: false, txHash: null };
  }

  if (!isFlashOrderFilled(detail.status)) {
    return { recorded: false, txHash: null };
  }

  const txHash = flashFillTxHash(detail);
  const won = await PendingFlashAdapter.markFilled(args.orderId, txHash);
  if (!won) return { recorded: false, txHash };

  const { sid } = await recordFlashFillActivity({
    senderId: args.senderId,
    prepared: args.prepared,
    orderId: args.orderId,
    detail,
  });
  if (sid) await PendingFlashAdapter.setActivitySid(args.orderId, sid);
  return { recorded: Boolean(sid), txHash };
}
