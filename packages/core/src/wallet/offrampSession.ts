import { createHash, randomBytes } from "node:crypto";

import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import { offrampSessions } from "@/db/schema/index.js";

export type OfframpPlatform = "imessage" | "whatsapp";
export type OfframpSessionStatus =
  | "draft"
  | "launched"
  | "transaction_ready"
  | "approval_creating"
  | "approval_pending"
  | "transfer_submitted"
  | "processing"
  | "success"
  | "failed"
  | "expired"
  | "manual_review";

export type OfframpSessionRow = typeof offrampSessions.$inferSelect;

const DRAFT_TTL_MS = 30 * 60 * 1000;
const TRANSFER_TTL_MS = 30 * 60 * 1000;
const ACTIVE_STATUSES: OfframpSessionStatus[] = [
  "launched",
  "transaction_ready",
  "approval_creating",
  "approval_pending",
  "transfer_submitted",
  "processing",
];
const SUPERSEDED_STATUSES: OfframpSessionStatus[] = [
  "draft",
  "launched",
  "transaction_ready",
  "approval_creating",
  "approval_pending",
];

function capabilityHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sessionId(): string {
  return randomBytes(16).toString("hex");
}

function capabilityToken(): string {
  return randomBytes(24).toString("base64url");
}

function partnerUserRef(id: string): string {
  return `bm-${id}`.slice(0, 50);
}

export class OfframpSessionAdapter {
  static async create(input: {
    platform: OfframpPlatform;
    userKey: string;
    sourceAddress: string;
    requestedAmount: string;
  }): Promise<{ token: string; session: OfframpSessionRow }> {
    const id = sessionId();
    const token = capabilityToken();
    const session = await drizzleDb.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(offrampSessions)
        .set({
          status: "expired",
          notifiedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(offrampSessions.platform, input.platform),
            eq(offrampSessions.userKey, input.userKey),
            inArray(offrampSessions.status, SUPERSEDED_STATUSES),
          ),
        );

      const [created] = await tx
        .insert(offrampSessions)
        .values({
          id,
          capabilityHash: capabilityHash(token),
          platform: input.platform,
          userKey: input.userKey,
          sourceAddress: input.sourceAddress.toLowerCase(),
          partnerUserRef: partnerUserRef(id),
          requestedAmount: input.requestedAmount,
          launchExpiresAt: new Date(now.getTime() + DRAFT_TTL_MS),
        })
        .returning();
      return created;
    });
    if (!session) throw new Error("failed to create offramp session");
    return { token, session };
  }

  static async getByCapability(token: string): Promise<OfframpSessionRow | null> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
    const row = await drizzleDb.query.offrampSessions.findFirst({
      where: (table, { eq }) => eq(table.capabilityHash, capabilityHash(token)),
    });
    if (!row) return null;
    if (row.launchExpiresAt < new Date() && row.status === "draft") {
      await this.setStatus(row.id, "expired");
      return { ...row, status: "expired" };
    }
    return row;
  }

  static async getById(id: string): Promise<OfframpSessionRow | null> {
    return (
      (await drizzleDb.query.offrampSessions.findFirst({
        where: (table, { eq }) => eq(table.id, id),
      })) ?? null
    );
  }

  static async markLaunched(id: string): Promise<OfframpSessionRow | null> {
    const [row] = await drizzleDb
      .update(offrampSessions)
      .set({
        status: "launched",
        transferExpiresAt: new Date(Date.now() + TRANSFER_TTL_MS),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(and(eq(offrampSessions.id, id), inArray(offrampSessions.status, ["draft", "launched"])))
      .returning();
    return row ?? null;
  }

  static async recordCoinbaseTransaction(
    id: string,
    transaction: {
      transactionId: string;
      status: string;
      sellAmount: string;
      fiatTotal?: string | null;
      fiatCurrency?: string | null;
      coinbaseFee?: string | null;
      toAddress: string;
      txHash?: string | null;
      localStatus?: OfframpSessionStatus;
    },
  ): Promise<OfframpSessionRow | null> {
    const [row] = await drizzleDb
      .update(offrampSessions)
      .set({
        status:
          transaction.status === "TRANSACTION_STATUS_SUCCESS"
            ? "success"
            : (transaction.localStatus ?? "transaction_ready"),
        coinbaseTransactionId: transaction.transactionId,
        coinbaseStatus: transaction.status,
        sellAmount: transaction.sellAmount,
        fiatTotal: transaction.fiatTotal ?? null,
        fiatCurrency: transaction.fiatCurrency ?? null,
        coinbaseFee: transaction.coinbaseFee ?? null,
        toAddress: transaction.toAddress.toLowerCase(),
        txHash: transaction.txHash ?? null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(offrampSessions.id, id),
          inArray(offrampSessions.status, [
            "launched",
            "transaction_ready",
            "approval_pending",
            "transfer_submitted",
            "processing",
          ]),
        ),
      )
      .returning();
    return row ?? null;
  }

  static async claimApproval(id: string): Promise<OfframpSessionRow | null> {
    const [row] = await drizzleDb
      .update(offrampSessions)
      .set({ status: "approval_creating", updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(offrampSessions.id, id), eq(offrampSessions.status, "transaction_ready")))
      .returning();
    return row ?? null;
  }

  static async releaseApprovalClaim(id: string): Promise<void> {
    await drizzleDb
      .update(offrampSessions)
      .set({ status: "transaction_ready", updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(offrampSessions.id, id), eq(offrampSessions.status, "approval_creating")));
  }

  static async updateTransferStatus(
    id: string,
    input: { status: "transfer_submitted" | "failed"; txHash?: string | null },
  ): Promise<void> {
    await drizzleDb
      .update(offrampSessions)
      .set({
        status: input.status,
        ...(input.txHash ? { txHash: input.txHash } : {}),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(offrampSessions.id, id));
  }

  static async updateCoinbaseStatus(
    id: string,
    coinbaseStatus: string,
    status: "processing" | "success" | "failed" | "expired",
    txHash?: string | null,
  ): Promise<void> {
    await drizzleDb
      .update(offrampSessions)
      .set({
        coinbaseStatus,
        status,
        ...(txHash ? { txHash } : {}),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(offrampSessions.id, id));
  }

  static async setStatus(id: string, status: OfframpSessionStatus): Promise<void> {
    await drizzleDb
      .update(offrampSessions)
      .set({ status, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(offrampSessions.id, id));
  }

  static async listActive(platform?: OfframpPlatform, limit = 50): Promise<OfframpSessionRow[]> {
    const conditions = [
      inArray(offrampSessions.status, ACTIVE_STATUSES),
      ...(platform ? [eq(offrampSessions.platform, platform)] : []),
    ];
    return drizzleDb
      .select()
      .from(offrampSessions)
      .where(and(...conditions))
      .orderBy(asc(offrampSessions.updatedAt))
      .limit(limit);
  }

  static async listTerminalUnnotified(
    platform: OfframpPlatform,
    limit = 50,
  ): Promise<OfframpSessionRow[]> {
    return drizzleDb
      .select()
      .from(offrampSessions)
      .where(
        and(
          eq(offrampSessions.platform, platform),
          inArray(offrampSessions.status, ["success", "failed", "expired", "manual_review"]),
          isNull(offrampSessions.notifiedAt),
        ),
      )
      .orderBy(asc(offrampSessions.updatedAt))
      .limit(limit);
  }

  static async markNotified(id: string): Promise<boolean> {
    const rows = await drizzleDb
      .update(offrampSessions)
      .set({ notifiedAt: sql`CURRENT_TIMESTAMP`, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(offrampSessions.id, id), isNull(offrampSessions.notifiedAt)))
      .returning({ id: offrampSessions.id });
    return rows.length > 0;
  }

  static async expireStale(): Promise<number> {
    const now = new Date();
    const result = await drizzleDb
      .update(offrampSessions)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          inArray(offrampSessions.status, ACTIVE_STATUSES),
          lt(offrampSessions.transferExpiresAt, now),
        ),
      );
    return (result as unknown as { rowCount?: number }).rowCount ?? 0;
  }
}
