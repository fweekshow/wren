ALTER TABLE "pending_pay_transactions" ADD COLUMN IF NOT EXISTS "execution_kind" text DEFAULT 'calls' NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_pay_transactions" ADD COLUMN IF NOT EXISTS "flash_prepared" jsonb;
