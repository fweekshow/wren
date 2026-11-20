ALTER TABLE "imessage_wallets" ADD COLUMN IF NOT EXISTS "cdp_user_id" text;--> statement-breakpoint
ALTER TABLE "imessage_wallets" ADD COLUMN IF NOT EXISTS "embedded_address" text;--> statement-breakpoint
ALTER TABLE "imessage_wallets" ADD COLUMN IF NOT EXISTS "delegation_id" text;--> statement-breakpoint
ALTER TABLE "imessage_wallets" ADD COLUMN IF NOT EXISTS "delegation_expires_at" timestamp with time zone;
