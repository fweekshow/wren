CREATE TABLE IF NOT EXISTS "pending_flash_orders" (
  "order_id" text PRIMARY KEY NOT NULL,
  "sender_id" text NOT NULL,
  "funder_address" text NOT NULL,
  "label" text NOT NULL,
  "amount" text,
  "asset" text,
  "prepared" jsonb NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "fill_tx_hash" text,
  "activity_sid" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_flash_orders_open_idx"
  ON "pending_flash_orders" ("status", "expires_at");
