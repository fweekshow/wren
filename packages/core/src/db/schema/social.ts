import {
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { imessageWallets } from "./wallets.js";

export const imessageContacts = pgTable("imessage_contacts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  contactOwner: text("contact_owner")
    .notNull()
    .references(() => imessageWallets.senderId),
  contact: text("contact").references(() => imessageWallets.senderId),
  contactPhone: text("contact_phone"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const copyStrategies = pgTable("copy_strategies", {
  id: serial("id").primaryKey(),
  platform: text("platform").notNull(),
  userKey: text("user_key").notNull(),
  followerWallet: text("follower_wallet"),
  leaderWallet: text("leader_wallet").notNull(),
  copyWalletName: text("copy_wallet_name").notNull(),
  copyWalletAddress: text("copy_wallet_address").notNull(),
  allocationUsd: numeric("allocation_usd").notNull().default("0"),
  maxTradeUsd: numeric("max_trade_usd").notNull().default("0"),
  maxSlippageBps: integer("max_slippage_bps").notNull().default(200),
  allowedTokens: text("allowed_tokens"),
  status: text("status").notNull().default("active"),
  dmTarget: text("dm_target"),
  realizedPnlUsd: numeric("realized_pnl_usd").notNull().default("0"),
  copyMode: text("copy_mode").notNull().default("tokens"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});
