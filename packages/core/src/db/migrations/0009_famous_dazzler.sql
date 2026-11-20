CREATE TABLE IF NOT EXISTS "pending_pay_transactions" (
	"token" varchar(32) PRIMARY KEY NOT NULL,
	"sender_id" text NOT NULL,
	"from_address" text NOT NULL,
	"chain_id" text NOT NULL,
	"calls" jsonb NOT NULL,
	"label" text,
	"recipient_display" text,
	"amount" text,
	"token_symbol" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "imessage_wallets" ADD COLUMN IF NOT EXISTS "pay_mode" text;
