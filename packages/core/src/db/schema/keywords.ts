import {
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const keywords = pgTable("keywords", {
  id: serial("id").primaryKey(),
  keyword: text("keyword").notNull(),
  ownerWallet: varchar("owner_wallet", { length: 255 }).notNull(),
  targetGroupId: varchar("target_group_id", { length: 255 }).notNull(),
  targetGroupType: varchar("target_group_type", { length: 20 }).notNull(),
  targetGroupName: varchar("target_group_name", { length: 255 }),
  targetInviteLink: text("target_invite_link"),
  bidUsdc: numeric("bid_usdc", { precision: 18, scale: 6 }).notNull().default("0"),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  paymentId: text("payment_id"),
  keywordEmbedding: jsonb("keyword_embedding"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const keywordBudgets = pgTable("keyword_budgets", {
  id: serial("id").primaryKey(),
  keywordId: integer("keyword_id")
    .notNull()
    .references(() => keywords.id, { onDelete: "cascade" })
    .unique(),
  totalBudgetUsdc: numeric("total_budget_usdc", { precision: 18, scale: 6 }).notNull().default("0"),
  spentUsdc: numeric("spent_usdc", { precision: 18, scale: 6 }).notNull().default("0"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const keywordImpressions = pgTable("keyword_impressions", {
  id: serial("id").primaryKey(),
  keywordId: integer("keyword_id").references(() => keywords.id, { onDelete: "set null" }),
  platform: varchar("platform", { length: 20 }).notNull(),
  sourceGroupId: varchar("source_group_id", { length: 255 }),
  userId: varchar("user_id", { length: 255 }),
  matchedText: text("matched_text"),
  costUsdc: numeric("cost_usdc", { precision: 18, scale: 6 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
