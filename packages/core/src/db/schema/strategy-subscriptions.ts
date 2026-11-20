import { numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { strategies } from "./strategies.js";

export const strategySubscriptions = pgTable("strategy_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  strategyId: uuid("strategy_id")
    .notNull()
    .references(() => strategies.id, { onDelete: "cascade" }),
  followerInboxId: text("follower_inbox_id").notNull(),
  followerWallet: text("follower_wallet"),
  copyWalletName: text("copy_wallet_name").notNull(),
  copyWalletAddress: text("copy_wallet_address"),
  allocationUsdc: numeric("allocation_usdc").notNull().default("0"),
  status: text("status").notNull().default("active"),
  highWaterMarkUsd: numeric("high_water_mark_usd").notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const strategyRewards = pgTable("strategy_rewards", {
  id: uuid("id").primaryKey().defaultRandom(),
  strategyId: uuid("strategy_id")
    .notNull()
    .references(() => strategies.id, { onDelete: "cascade" }),
  subscriptionId: uuid("subscription_id").references(() => strategySubscriptions.id, {
    onDelete: "set null",
  }),
  creatorWallet: text("creator_wallet").notNull(),
  followerWallet: text("follower_wallet"),
  profitUsd: numeric("profit_usd").notNull().default("0"),
  creatorShareUsd: numeric("creator_share_usd").notNull().default("0"),
  platformShareUsd: numeric("platform_share_usd").notNull().default("0"),
  settledAt: timestamp("settled_at", { withTimezone: true }).defaultNow(),
});
