CREATE TABLE "offramp_sessions" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"capability_hash" text NOT NULL,
	"platform" text NOT NULL,
	"user_key" text NOT NULL,
	"source_address" text NOT NULL,
	"partner_user_ref" varchar(50) NOT NULL,
	"requested_amount" numeric(36, 6) NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"coinbase_transaction_id" text,
	"coinbase_status" text,
	"sell_amount" numeric(36, 6),
	"fiat_total" numeric(36, 2),
	"fiat_currency" varchar(12),
	"coinbase_fee" numeric(36, 2),
	"to_address" text,
	"base_mcp_request_id" text,
	"base_mcp_approval_url" text,
	"tx_confirmation_sid" text,
	"tx_hash" text,
	"launch_expires_at" timestamp with time zone NOT NULL,
	"transfer_expires_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "offramp_sessions_capability_hash_idx" ON "offramp_sessions" USING btree ("capability_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "offramp_sessions_partner_user_ref_idx" ON "offramp_sessions" USING btree ("partner_user_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "offramp_sessions_coinbase_transaction_id_idx" ON "offramp_sessions" USING btree ("coinbase_transaction_id");