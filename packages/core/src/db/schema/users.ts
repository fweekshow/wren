import { boolean, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  inboxId: text("inbox_id").unique().notNull(),
  walletAddress: text("wallet_address"),
  totalMessages: integer("total_messages").default(0),
  remindersCreated: integer("reminders_created").default(0),
  firstSeenAt: timestamp("first_seen_at").defaultNow(),
  lastMessageAt: timestamp("last_message_at").defaultNow(),
  actionClicks: jsonb("action_clicks").$type<Record<string, number>>().default({}),
  lastProactiveDmAt: timestamp("last_proactive_dm_at"),
  recommendedGroupIds: jsonb("recommended_group_ids").$type<string[]>().default([]),
  lastButtonClickAt: timestamp("last_button_click_at"),
});

export const buttonClickEvents = pgTable("button_click_events", {
  id: serial("id").primaryKey(),
  inboxId: text("inbox_id").notNull(),
  actionKey: text("action_key").notNull(),
  clickedAt: timestamp("clicked_at").notNull().defaultNow(),
});

export const inboundMessageEvents = pgTable("inbound_message_events", {
  id: serial("id").primaryKey(),
  inboxId: text("inbox_id").notNull(),
  isGroup: boolean("is_group").notNull().default(false),
  engaged: boolean("engaged").notNull().default(true),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
});
