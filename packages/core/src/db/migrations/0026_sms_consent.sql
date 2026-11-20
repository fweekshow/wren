CREATE TABLE IF NOT EXISTS "sms_consents" (
  "phone" text PRIMARY KEY NOT NULL,
  "status" text NOT NULL,
  "opted_in_at" timestamp with time zone,
  "opted_out_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
