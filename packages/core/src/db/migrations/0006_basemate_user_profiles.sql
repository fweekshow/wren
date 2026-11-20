-- Create the Basemate user registry table
CREATE TABLE "basemate_user_profiles" (
	"sender_id" text PRIMARY KEY NOT NULL,
	"wallet_address" text,
	"basename" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "basemate_user_profiles" ADD CONSTRAINT "basemate_user_profiles_sender_id_imessage_wallets_sender_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."imessage_wallets"("sender_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "basemate_user_profiles_wallet_idx" ON "basemate_user_profiles" USING btree ("wallet_address");
--> statement-breakpoint
-- Backfill existing users from imessage_wallets so no one needs to re-register
INSERT INTO "basemate_user_profiles" ("sender_id", "wallet_address", "joined_at", "last_active_at")
SELECT "sender_id", "base_app_address", now(), now()
FROM "imessage_wallets"
ON CONFLICT DO NOTHING;
