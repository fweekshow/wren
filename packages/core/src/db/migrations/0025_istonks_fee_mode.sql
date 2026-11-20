ALTER TABLE "token_launch_log" ADD COLUMN IF NOT EXISTS "fee_mode" text;--> statement-breakpoint
ALTER TABLE "token_launch_log" ADD COLUMN IF NOT EXISTS "initializer" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_token_launch_log_initializer"
  ON "token_launch_log" ("initializer")
