import {
  bigserial,
  index,
  jsonb,
  numeric,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
// NOTE: conversation_memory uses pgvector's VECTOR type. Drizzle does not have a
// built-in column type for it yet — we use a custom SQL type via `customType`.
import { customType } from "drizzle-orm/pg-core";

const vector = customType<{ data: number[]; driverData: string }>({
  dataType(config) {
    return `vector(${(config as { dimensions?: number }).dimensions ?? 1536})`;
  },
  toDriver(value: number[]) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string) {
    return value
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map(Number);
  },
});

export const conversationMemory = pgTable("conversation_memory", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  inboxId: text("inbox_id").notNull(),
  conversationId: text("conversation_id"),
  kind: text("kind").notNull(),
  content: text("content").notNull(),
  contentHash: text("content_hash").notNull(),
  embedding: vector("embedding", { dimensions: 1536 }).notNull(),
  importance: real("importance").notNull().default(0.5),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

export const userMemory = pgTable("user_memory", {
  inboxId: text("inbox_id").primaryKey(),
  preferredEarnVenues: text("preferred_earn_venues").array().notNull().default([]),
  lastTradePair: text("last_trade_pair"),
  lastEarnAsset: text("last_earn_asset"),
  notable: text("notable"),
  tradeCount: numeric("trade_count").notNull().default("0"),
  earnCount: numeric("earn_count").notNull().default("0"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const perpProfiles = pgTable("perp_profiles", {
  inboxId: text("inbox_id").primaryKey(),
  riskTier: text("risk_tier").notNull(),
  defaultCollateralUsdc: text("default_collateral_usdc").notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const pendingRecommendations = pgTable("pending_recommendations", {
  id: numeric("id").primaryKey(),
  senderInboxId: text("sender_inbox_id").notNull(),
  senderWalletAddress: text("sender_wallet_address"),
  sourceGroupId: text("source_group_id").notNull(),
  targetGroupId: text("target_group_id").notNull(),
  targetGroupName: text("target_group_name").notNull(),
  targetGroupImageUrl: text("target_group_image_url"),
  score: numeric("score").notNull(),
  reasoning: text("reasoning"),
  detectedInterests: text("detected_interests").array(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow(),
  sentAt: timestamp("sent_at"),
});

// Full conversation transcript — written after every user + assistant turn.
// Replaces the ephemeral in-process / Redis-only history for durability.
// The (conversation_id, created_at) index powers the bootstrap query.
export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: serial("id").primaryKey(),
    inboxId: text("inbox_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    platform: text("platform").notNull(), // "imessage" | "xmtp" | "whatsapp"
    role: text("role").notNull(),          // "user" | "assistant"
    content: text("content").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("conv_messages_conv_id_idx").on(t.conversationId, t.createdAt)],
);
