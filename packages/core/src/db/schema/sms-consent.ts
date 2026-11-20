import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** US SMS program consent, keyed by ContactsAdapter.normalizeHandle. */
export const smsConsents = pgTable("sms_consents", {
  phone: text("phone").primaryKey(),
  /** pending | opted_in | opted_out */
  status: text("status").notNull(),
  optedInAt: timestamp("opted_in_at", { withTimezone: true }),
  optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
