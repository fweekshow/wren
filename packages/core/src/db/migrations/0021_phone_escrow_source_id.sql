ALTER TABLE "imessage_phone_escrows" ADD COLUMN IF NOT EXISTS "source_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_imessage_phone_escrows_sender_source"
  ON "imessage_phone_escrows" ("sender_id", "source_id")
  WHERE "source_id" IS NOT NULL;
