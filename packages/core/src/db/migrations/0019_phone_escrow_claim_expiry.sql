ALTER TABLE "imessage_phone_escrows" ADD COLUMN IF NOT EXISTS "sender_refund_address" text;--> statement-breakpoint
ALTER TABLE "imessage_phone_escrows" ADD COLUMN IF NOT EXISTS "deposit_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imessage_phone_escrows" ADD COLUMN IF NOT EXISTS "claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imessage_phone_escrows" ADD COLUMN IF NOT EXISTS "refund_tx_hash" text;--> statement-breakpoint
ALTER TABLE "imessage_phone_escrows" ADD COLUMN IF NOT EXISTS "refunded_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_imessage_phone_escrows_status_claim_expires"
  ON "imessage_phone_escrows" ("status", "claim_expires_at");
