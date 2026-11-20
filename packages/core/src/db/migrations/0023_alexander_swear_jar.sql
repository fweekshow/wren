ALTER TABLE "imessage_wallets" ADD COLUMN IF NOT EXISTS "swear_jar_opt_in" boolean DEFAULT false;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "swear_jars" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "pot_address" text NOT NULL,
  "roster" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "round_start_at" timestamp with time zone DEFAULT now() NOT NULL,
  "settled_at" timestamp with time zone,
  "winner_sender_id" text,
  "winner_tx_hash" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "swear_jars_conversation_status_idx" ON "swear_jars" ("conversation_id", "status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "swear_jar_fines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "jar_id" uuid NOT NULL,
  "source_message_id" text NOT NULL,
  "swearer_sender_id" text NOT NULL,
  "swearer_name" text,
  "amount_usd" numeric(36, 2) DEFAULT '1.00' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "pay_tx_hash" text,
  "refund_tx_hash" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "swear_jar_fines_jar_message_idx" ON "swear_jar_fines" ("jar_id", "source_message_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "swear_jar_activity" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "jar_id" uuid NOT NULL,
  "sender_id" text NOT NULL,
  "last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
  "message_count" integer DEFAULT 1 NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "swear_jar_fines" ADD CONSTRAINT "swear_jar_fines_jar_id_swear_jars_id_fk" FOREIGN KEY ("jar_id") REFERENCES "public"."swear_jars"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "swear_jar_activity" ADD CONSTRAINT "swear_jar_activity_jar_id_swear_jars_id_fk" FOREIGN KEY ("jar_id") REFERENCES "public"."swear_jars"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "swear_jar_activity_jar_sender_idx" ON "swear_jar_activity" ("jar_id", "sender_id");
