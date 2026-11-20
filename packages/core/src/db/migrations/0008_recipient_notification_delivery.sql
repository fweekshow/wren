ALTER TABLE "tx_confirmations"
  ADD COLUMN IF NOT EXISTS "recipient_notification_status" text,
  ADD COLUMN IF NOT EXISTS "recipient_notification_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "recipient_notification_next_attempt_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "recipient_notification_last_error" text,
  ADD COLUMN IF NOT EXISTS "recipient_notification_accepted_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tx_confirmations_recipient_notification_pending_idx"
  ON "tx_confirmations" ("recipient_notification_next_attempt_at", "created_at")
  WHERE "status" = 'confirmed'
    AND "recipient_notification_status" IN ('pending', 'processing', 'retryable_failed');
