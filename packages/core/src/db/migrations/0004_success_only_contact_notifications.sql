ALTER TABLE "imessage_wallets"
  ADD COLUMN IF NOT EXISTS "display_name" text;
--> statement-breakpoint
ALTER TABLE "tx_confirmations"
  ADD COLUMN IF NOT EXISTS "recipient_phone" text,
  ADD COLUMN IF NOT EXISTS "transfer_amount" text,
  ADD COLUMN IF NOT EXISTS "transfer_asset" text;
