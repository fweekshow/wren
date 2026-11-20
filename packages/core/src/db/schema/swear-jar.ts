import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type SwearJarRosterMember = {
  id: string;
  name?: string;
};

export const swearJars = pgTable(
  "swear_jars",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: text("conversation_id").notNull(),
    status: text("status").notNull().default("active"),
    potAddress: text("pot_address").notNull(),
    roster: jsonb("roster").$type<SwearJarRosterMember[]>().notNull().default([]),
    roundStartAt: timestamp("round_start_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    winnerSenderId: text("winner_sender_id"),
    winnerTxHash: text("winner_tx_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("swear_jars_conversation_status_idx").on(table.conversationId, table.status)],
);

export const swearJarFines = pgTable(
  "swear_jar_fines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jarId: uuid("jar_id")
      .notNull()
      .references(() => swearJars.id),
    sourceMessageId: text("source_message_id").notNull(),
    swearerSenderId: text("swearer_sender_id").notNull(),
    swearerName: text("swearer_name"),
    amountUsd: numeric("amount_usd", { precision: 36, scale: 2 }).notNull().default("1.00"),
    status: text("status").notNull().default("pending"),
    payTxHash: text("pay_tx_hash"),
    refundTxHash: text("refund_tx_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("swear_jar_fines_jar_message_idx").on(table.jarId, table.sourceMessageId),
  ],
);

export const swearJarActivity = pgTable(
  "swear_jar_activity",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jarId: uuid("jar_id")
      .notNull()
      .references(() => swearJars.id),
    senderId: text("sender_id").notNull(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    messageCount: integer("message_count").notNull().default(1),
  },
  (table) => [uniqueIndex("swear_jar_activity_jar_sender_idx").on(table.jarId, table.senderId)],
);
