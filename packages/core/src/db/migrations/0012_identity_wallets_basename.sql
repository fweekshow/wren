-- Fold basemate_user_profiles into imessage_wallets: basename lives on wallets;
-- receive-address resolution uses embedded_address / base_app_address only.
ALTER TABLE "imessage_wallets" ADD COLUMN IF NOT EXISTS "basename" text;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'basemate_user_profiles'
  ) THEN
    UPDATE "imessage_wallets" AS w
    SET "basename" = p."basename"
    FROM "basemate_user_profiles" AS p
    WHERE w."sender_id" = p."sender_id"
      AND p."basename" IS NOT NULL
      AND (w."basename" IS NULL OR w."basename" = '');
  END IF;
END $$;--> statement-breakpoint
DROP TABLE IF EXISTS "basemate_user_profiles";
