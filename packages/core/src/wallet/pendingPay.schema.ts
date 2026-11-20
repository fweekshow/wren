import { db } from "@/discovery/db.js";
import { logger } from "@/utils/logger.js";

/**
 * Ensure pending-pay delivery/copy-trade columns exist.
 *
 * Drizzle journal timestamps can skip 0013 on older environments, so the bot
 * applies this idempotent ALTER on the same pool it queries with.
 */
export async function ensurePendingPayDeliveryColumns(): Promise<void> {
  // Separate statements: clearer errors, and safer across Postgres versions.
  await db.query(`
    ALTER TABLE "pending_pay_transactions"
      ADD COLUMN IF NOT EXISTS "conversation_id" text
  `);
  await db.query(`
    ALTER TABLE "pending_pay_transactions"
      ADD COLUMN IF NOT EXISTS "is_group" boolean DEFAULT false NOT NULL
  `);
  await db.query(`
    ALTER TABLE "pending_pay_transactions"
      ADD COLUMN IF NOT EXISTS "delivery_phone" text
  `);
  await db.query(`
    ALTER TABLE "pending_pay_transactions"
      ADD COLUMN IF NOT EXISTS "copy_trade_context" jsonb
  `);

  const check = await db.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'pending_pay_transactions'
        AND column_name = ANY($1::text[])`,
    [["conversation_id", "is_group", "delivery_phone", "copy_trade_context"]],
  );
  const present = new Set(check.rows.map((row) => row.column_name));
  const missing = ["conversation_id", "is_group", "delivery_phone", "copy_trade_context"].filter(
    (name) => !present.has(name),
  );
  if (missing.length > 0) {
    throw new Error(
      `pending_pay_transactions missing columns after schema repair: ${missing.join(", ")}`,
    );
  }
  logger.info("✅ pending_pay_transactions delivery columns ensured");
}
