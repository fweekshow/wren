ALTER TABLE "token_launch_log" ADD COLUMN IF NOT EXISTS "pool_id" text;--> statement-breakpoint
ALTER TABLE "token_launch_log" ADD COLUMN IF NOT EXISTS "pair_address" text;--> statement-breakpoint
ALTER TABLE "token_launch_log" ADD COLUMN IF NOT EXISTS "pair_symbol" text;--> statement-breakpoint
ALTER TABLE "token_launch_log" ADD COLUMN IF NOT EXISTS "tx_hash" text;--> statement-breakpoint
ALTER TABLE "token_launch_log" ADD COLUMN IF NOT EXISTS "beneficiary_json" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_token_launch_log_wallet_created"
  ON "token_launch_log" ("wallet_address", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_token_launch_log_token_address"
  ON "token_launch_log" ("token_address")
  WHERE "token_address" IS NOT NULL;
