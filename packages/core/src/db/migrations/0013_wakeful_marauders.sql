ALTER TABLE "pending_pay_transactions" ADD COLUMN IF NOT EXISTS "conversation_id" text;--> statement-breakpoint
ALTER TABLE "pending_pay_transactions" ADD COLUMN IF NOT EXISTS "is_group" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_pay_transactions" ADD COLUMN IF NOT EXISTS "delivery_phone" text;--> statement-breakpoint
ALTER TABLE "pending_pay_transactions" ADD COLUMN IF NOT EXISTS "copy_trade_context" jsonb;