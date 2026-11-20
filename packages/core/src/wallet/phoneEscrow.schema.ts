import { db } from "@/discovery/db.js";
import { logger } from "@/utils/logger.js";

const CLAIM_EXPIRY_COLUMNS = [
  "sender_refund_address",
  "deposit_confirmed_at",
  "claim_expires_at",
  "refund_tx_hash",
  "refunded_at",
  "source_id",
] as const;

/**
 * Ensure phone-escrow claim-expiry / refund columns exist.
 *
 * Migration 0019 adds these, but poller-only services never ran the old
 * createTable() path — apply the same idempotent ALTER the bot uses for
 * pending_pay so EscrowRefundPoller can't query a stale schema.
 */
export async function ensurePhoneEscrowClaimExpiryColumns(): Promise<void> {
  await db.query(`
    ALTER TABLE "imessage_phone_escrows"
      ADD COLUMN IF NOT EXISTS "sender_refund_address" text
  `);
  await db.query(`
    ALTER TABLE "imessage_phone_escrows"
      ADD COLUMN IF NOT EXISTS "deposit_confirmed_at" timestamp with time zone
  `);
  await db.query(`
    ALTER TABLE "imessage_phone_escrows"
      ADD COLUMN IF NOT EXISTS "claim_expires_at" timestamp with time zone
  `);
  await db.query(`
    ALTER TABLE "imessage_phone_escrows"
      ADD COLUMN IF NOT EXISTS "refund_tx_hash" text
  `);
  await db.query(`
    ALTER TABLE "imessage_phone_escrows"
      ADD COLUMN IF NOT EXISTS "refunded_at" timestamp with time zone
  `);
  await db.query(`
    ALTER TABLE "imessage_phone_escrows"
      ADD COLUMN IF NOT EXISTS "source_id" text
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS "idx_imessage_phone_escrows_status_claim_expires"
      ON "imessage_phone_escrows" ("status", "claim_expires_at")
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "idx_imessage_phone_escrows_sender_source"
      ON "imessage_phone_escrows" ("sender_id", "source_id")
      WHERE "source_id" IS NOT NULL
  `);

  const check = await db.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'imessage_phone_escrows'
        AND column_name = ANY($1::text[])`,
    [CLAIM_EXPIRY_COLUMNS as unknown as string[]],
  );
  const present = new Set(check.rows.map((row) => row.column_name));
  const missing = CLAIM_EXPIRY_COLUMNS.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(
      `imessage_phone_escrows missing columns after schema repair: ${missing.join(", ")}`,
    );
  }
  logger.info("✅ imessage_phone_escrows claim-expiry columns ensured");
}
