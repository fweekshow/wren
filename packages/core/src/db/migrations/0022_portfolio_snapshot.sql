ALTER TABLE "imessage_wallets" ADD COLUMN IF NOT EXISTS "portfolio_snapshot" jsonb;
ALTER TABLE "imessage_wallets" ADD COLUMN IF NOT EXISTS "portfolio_snapshot_at" timestamp with time zone;
