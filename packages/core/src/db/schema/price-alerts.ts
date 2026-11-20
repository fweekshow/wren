import { boolean, numeric, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const priceAlerts = pgTable("price_alerts", {
  id: serial("id").primaryKey(),
  platform: text("platform").notNull(),
  userKey: text("user_key").notNull(),
  dmTarget: text("dm_target"),
  sourceConversationId: text("source_conversation_id"),
  sourceIsGroup: boolean("source_is_group").notNull().default(false),
  tokenSource: text("token_source").notNull(),
  tokenId: text("token_id"),
  tokenAddress: text("token_address"),
  chainId: text("chain_id"),
  symbol: text("symbol").notNull(),
  name: text("name"),
  metric: text("metric").notNull().default("price_usd"),
  targetValue: numeric("target_value").notNull(),
  direction: text("direction").notNull(),
  currentValueAtCreate: numeric("current_value_at_create"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  triggeredAt: timestamp("triggered_at", { withTimezone: true }),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
});
