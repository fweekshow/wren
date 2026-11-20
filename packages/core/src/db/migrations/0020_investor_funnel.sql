CREATE TABLE IF NOT EXISTS "investor_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"firm" text NOT NULL,
	"website" text,
	"linkedin" text,
	"telegram" text,
	"email" text,
	"twitter" text,
	"focus" text,
	"check_size" text,
	"stages" text,
	"location" text,
	"tier" text DEFAULT 'tier2' NOT NULL,
	"stage" text DEFAULT 'identified' NOT NULL,
	"meeting_date" timestamp with time zone,
	"notes" text,
	"added_by" text,
	"seeded" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_investor_contacts_stage" ON "investor_contacts" ("stage");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_investor_contacts_tier" ON "investor_contacts" ("tier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_investor_contacts_meeting_date" ON "investor_contacts" ("meeting_date");
