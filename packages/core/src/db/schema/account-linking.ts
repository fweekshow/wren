import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const connectionTokens = pgTable("connection_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  platform: text("platform").notNull(),
  userKey: text("user_key").notNull(),
  walletAddress: text("wallet_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

export const accountLinks = pgTable("account_links", {
  id: uuid("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accountLinkMembers = pgTable(
  "account_link_members",
  {
    linkId: uuid("link_id")
      .notNull()
      .references(() => accountLinks.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    userKey: text("user_key").notNull(),
    walletAddress: text("wallet_address"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.platform, t.userKey] })],
);
