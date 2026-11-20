import {
  boolean,
  check,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const nsGroups = pgTable("ns_groups", {
  id: serial("id").primaryKey(),
  groupId: varchar("group_id", { length: 255 }).unique().notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  tags: text("tags").array(),
  metadata: jsonb("metadata"),
  instanceId: varchar("instance_id", { length: 50 }).default("basemate"),
  imageUrl: varchar("image_url", { length: 500 }),
  aiGeneratedTags: jsonb("ai_generated_tags"),
  isSuggestable: boolean("is_suggestable").default(false),
  totalMessages: integer("total_messages").default(0),
  lastMessageAt: timestamp("last_message_at"),
  totalMembers: integer("total_members").default(0),
  agentInGroup: boolean("agent_in_group").default(true),
  ownerBasename: varchar("owner_basename", { length: 255 }),
  inviteLink: varchar("invite_link", { length: 500 }),
  paidDiscovery: boolean("paid_discovery").default(false),
  paidDiscoveryExpiresAt: timestamp("paid_discovery_expires_at"),
  boostScore: integer("boost_score").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const boostPayments = pgTable("boost_payments", {
  id: serial("id").primaryKey(),
  txHash: varchar("tx_hash", { length: 66 }).unique().notNull(),
  groupId: varchar("group_id", { length: 255 }).notNull(),
  payerAddress: varchar("payer_address", { length: 42 }).notNull(),
  amountUsdc: numeric("amount_usdc", { precision: 18, scale: 6 }).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const groupPermissions = pgTable("group_permissions", {
  id: serial("id").primaryKey(),
  groupId: varchar("group_id", { length: 255 }).notNull(),
  userInboxId: varchar("user_inbox_id", { length: 255 }).notNull(),
  userWalletAddress: varchar("user_wallet_address", { length: 255 }),
  permissionType: varchar("permission_type", { length: 20 }).notNull().default("owner"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const trendingGroupOverrides = pgTable(
  "trending_group_overrides",
  {
    id: serial("id").primaryKey(),
    slotPosition: integer("slot_position").notNull(),
    groupId: varchar("group_id", { length: 255 }).notNull(),
    priority: integer("priority").default(0),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [check("slot_position_range", sql`${t.slotPosition} BETWEEN 1 AND 3`)],
);

export const auctionWinners = pgTable("auction_winners", {
  id: serial("id").primaryKey(),
  auctionId: integer("auction_id").notNull().unique(),
  winnerAddress: varchar("winner_address", { length: 42 }).notNull(),
  communityName: varchar("community_name", { length: 255 }).notNull(),
  communityDescription: text("community_description"),
  communityLink: varchar("community_link", { length: 500 }),
  winningBid: numeric("winning_bid", { precision: 20, scale: 6 }),
  groupId: varchar("group_id", { length: 255 }),
  startTime: timestamp("start_time").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  isActive: boolean("is_active").default(true),
  broadcastDmSent: boolean("broadcast_dm_sent").default(false),
  syncedAt: timestamp("synced_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
