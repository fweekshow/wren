ALTER TABLE "imessage_phone_escrows" ADD COLUMN "token_symbol" text DEFAULT 'USDC' NOT NULL;
--> statement-breakpoint
ALTER TABLE "imessage_phone_escrows" ADD COLUMN "token_decimals" integer DEFAULT 6 NOT NULL;
