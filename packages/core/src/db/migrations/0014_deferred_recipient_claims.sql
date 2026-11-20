ALTER TABLE "tx_confirmations"
  ADD COLUMN IF NOT EXISTS "recipient_claim_status" text,
  ADD COLUMN IF NOT EXISTS "recipient_claim_processing_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "recipient_claim_sent_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tx_confirmations_recipient_claim_pending_idx"
  ON "tx_confirmations" ("recipient_phone", "recipient_claim_processing_at", "created_at")
  WHERE "status" = 'confirmed'
    AND "recipient_claim_status" IN ('pending', 'processing');
