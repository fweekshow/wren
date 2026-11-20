import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Investor funnel — tracks VC contacts from cold identification through term sheet.
 *
 * Stage flow:
 *   identified → researching → outreach_sent → meeting_scheduled
 *   → meeting_done → follow_up → term_sheet | passed | on_hold
 */
export const investorContacts = pgTable("investor_contacts", {
  id: serial("id").primaryKey(),

  // Contact info
  name: text("name").notNull(),
  firm: text("firm").notNull(),
  website: text("website"),
  linkedin: text("linkedin"),
  telegram: text("telegram"),
  email: text("email"),
  twitter: text("twitter"),

  // Investment profile
  focus: text("focus"),       // e.g. "DeFi, AI, Consumer Crypto"
  checkSize: text("check_size"), // e.g. "$500k–$5M"
  stages: text("stages"),     // e.g. "Seed, Series A"
  location: text("location"), // e.g. "Singapore"

  // Funnel
  tier: text("tier").notNull().default("tier2"), // "tier1" | "tier2" | "tier3"
  stage: text("stage").notNull().default("identified"),
  meetingDate: timestamp("meeting_date", { withTimezone: true }),
  notes: text("notes"),

  // Meta
  addedBy: text("added_by"),
  seeded: integer("seeded").notNull().default(0), // 1 = pre-loaded SG list
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type InvestorContact = typeof investorContacts.$inferSelect;
export type NewInvestorContact = typeof investorContacts.$inferInsert;
