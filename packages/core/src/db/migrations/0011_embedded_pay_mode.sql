ALTER TABLE "imessage_wallets" ADD COLUMN IF NOT EXISTS "embedded_pay_mode" text;--> statement-breakpoint
ALTER TABLE "imessage_wallets" ADD COLUMN IF NOT EXISTS "auto_send_limit_usd" numeric(36, 2);--> statement-breakpoint
ALTER TABLE "pending_pay_transactions" ADD COLUMN IF NOT EXISTS "wallet_kind" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_imessage_wallets_embedded_address" ON "imessage_wallets" ("embedded_address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_imessage_wallets_cdp_user_id" ON "imessage_wallets" ("cdp_user_id");
