import { randomBytes } from "node:crypto";

import { and, eq, lt, sql } from "drizzle-orm";
import type { WalletCall } from "@basemate/shared";

import { drizzleDb } from "@/db/client.js";
import { pendingPayTransactions } from "@/db/schema/index.js";
import type { CopyTradeCtxPayload } from "@/discovery/ai/types.js";
import type { FlashPreparedOrder } from "@/discovery/flash/types.js";

export type PendingPayRow = typeof pendingPayTransactions.$inferSelect;
export type PendingPayStatus = "pending" | "signed" | "confirmed" | "failed" | "expired";
export type PendingPayExecutionKind = "calls" | "flash";

const TTL_MS = 30 * 60 * 1000;
const TOKEN_RE = /^[a-f0-9]{32}$/i;

export type WalletKind = "embedded";

export interface CreatePendingPayInput {
  senderId: string;
  fromAddress: string;
  chainId: string;
  calls?: WalletCall[];
  label?: string | null;
  recipientDisplay?: string | null;
  amount?: string | null;
  tokenSymbol?: string | null;
  transferMemo?: string | null;
  /** The embedded-wallet confirmation lane. */
  walletKind?: WalletKind | null;
  executionKind?: PendingPayExecutionKind;
  /** Required when executionKind is flash. */
  flashPrepared?: FlashPreparedOrder | null;
  conversationId?: string | null;
  isGroup?: boolean;
  deliveryPhone?: string | null;
  copyTradeContext?: CopyTradeCtxPayload | null;
  /** Override default 30m pending-pay TTL (dashboard sends use 24h). */
  expiresAtMs?: number;
}

/**
 * Store a transaction awaiting signature on the self-hosted Basemate Pay page.
 * The returned token locates the row, but embedded-wallet execution additionally
 * requires an authenticated app session belonging to the stored sender.
 */
export class PendingPayAdapter {
  static async create(
    input: CreatePendingPayInput,
  ): Promise<{ token: string; row: PendingPayRow }> {
    const executionKind = input.executionKind ?? "calls";
    if (executionKind === "flash" && !input.flashPrepared) {
      throw new Error("flash pending pay requires flashPrepared");
    }
    const token = randomBytes(16).toString("hex");
    const [row] = await drizzleDb
      .insert(pendingPayTransactions)
      .values({
        token,
        senderId: input.senderId,
        fromAddress: input.fromAddress.toLowerCase(),
        chainId: input.chainId,
        calls: input.calls ?? [],
        label: input.label ?? null,
        recipientDisplay: input.recipientDisplay ?? null,
        amount: input.amount ?? null,
        tokenSymbol: input.tokenSymbol ?? null,
        transferMemo: input.transferMemo ?? null,
        walletKind: input.walletKind ?? "embedded",
        executionKind,
        flashPrepared: input.flashPrepared ?? null,
        conversationId: input.conversationId ?? null,
        isGroup: input.isGroup ?? false,
        deliveryPhone: input.deliveryPhone ?? null,
        copyTradeContext: input.copyTradeContext ?? null,
        expiresAt: new Date(Date.now() + (input.expiresAtMs ?? TTL_MS)),
      })
      .returning();
    if (!row) throw new Error("failed to create pending pay transaction");
    return { token, row };
  }

  static async getByToken(token: string): Promise<PendingPayRow | null> {
    if (!TOKEN_RE.test(token)) return null;
    const row = await drizzleDb.query.pendingPayTransactions.findFirst({
      where: (t, { eq }) => eq(t.token, token),
    });
    if (!row) return null;
    if (row.status === "pending" && row.expiresAt < new Date()) {
      await this.setStatus(token, "expired");
      return { ...row, status: "expired" };
    }
    return row;
  }

  static async markSigned(token: string, txHash: string): Promise<PendingPayRow | null> {
    const [row] = await drizzleDb
      .update(pendingPayTransactions)
      .set({ status: "signed", txHash, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(
        and(
          eq(pendingPayTransactions.token, token),
          eq(pendingPayTransactions.status, "pending"),
        ),
      )
      .returning();
    return row ?? null;
  }

  /** Signed transactions with a hash that haven't been confirmed on-chain yet. */
  static async listSignedUnconfirmed(limit = 50): Promise<PendingPayRow[]> {
    return drizzleDb
      .select()
      .from(pendingPayTransactions)
      .where(
        and(
          eq(pendingPayTransactions.status, "signed"),
          sql`${pendingPayTransactions.txHash} IS NOT NULL`,
        ),
      )
      .limit(limit);
  }

  /**
   * Mark an embedded-wallet confirm as executed. The embedded lane signs
   * server-side in one step (there is no separate on-chain receipt poll for the
   * sender), so move straight to `confirmed` with the userOp/tx hash. Only wins
   * from `pending` so a double-tap can't execute twice.
   */
  static async markEmbeddedConfirmed(
    token: string,
    hash: string | null,
  ): Promise<boolean> {
    const rows = await drizzleDb
      .update(pendingPayTransactions)
      .set({ status: "confirmed", txHash: hash, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(
        and(eq(pendingPayTransactions.token, token), eq(pendingPayTransactions.status, "pending")),
      )
      .returning({ token: pendingPayTransactions.token });
    return rows.length > 0;
  }

  /** Win the signed→confirmed transition so the sender DM fires exactly once. */
  static async markConfirmed(token: string): Promise<boolean> {
    const rows = await drizzleDb
      .update(pendingPayTransactions)
      .set({ status: "confirmed", updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(
        and(eq(pendingPayTransactions.token, token), eq(pendingPayTransactions.status, "signed")),
      )
      .returning({ token: pendingPayTransactions.token });
    return rows.length > 0;
  }

  /** Win the signed→failed transition so the sender DM fires exactly once. */
  static async markFailedOnchain(token: string): Promise<boolean> {
    const rows = await drizzleDb
      .update(pendingPayTransactions)
      .set({ status: "failed", updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(
        and(eq(pendingPayTransactions.token, token), eq(pendingPayTransactions.status, "signed")),
      )
      .returning({ token: pendingPayTransactions.token });
    return rows.length > 0;
  }

  static async setStatus(token: string, status: PendingPayStatus): Promise<void> {
    await drizzleDb
      .update(pendingPayTransactions)
      .set({ status, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(pendingPayTransactions.token, token));
  }

  static async expireStale(): Promise<number> {
    const result = await drizzleDb
      .update(pendingPayTransactions)
      .set({ status: "expired", updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(
        and(
          eq(pendingPayTransactions.status, "pending"),
          lt(pendingPayTransactions.expiresAt, new Date()),
        ),
      );
    return (result as unknown as { rowCount?: number }).rowCount ?? 0;
  }
}
