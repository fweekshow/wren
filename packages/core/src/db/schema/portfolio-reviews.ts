import {
  boolean,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const portfolioReviewSubscriptions = pgTable("portfolio_review_subscriptions", {
  id: serial("id").primaryKey(),
  platform: text("platform").notNull(),
  userKey: text("user_key").notNull(),
  walletAddress: text("wallet_address").notNull(),
  dmTarget: text("dm_target"),
  localTime: text("local_time").notNull(),
  timezone: text("timezone").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  processingAt: timestamp("processing_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const portfolioReviewSnapshots = pgTable("portfolio_review_snapshots", {
  id: serial("id").primaryKey(),
  subscriptionId: integer("subscription_id")
    .notNull()
    .references(() => portfolioReviewSubscriptions.id, { onDelete: "cascade" }),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  totalValueUsd: numeric("total_value_usd").notNull(),
  holdingsJson: text("holdings_json").notNull(),
  avantisJson: text("avantis_json"),
  sentimentJson: text("sentiment_json"),
  walletAddress: text("wallet_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const portfolioReviewDeliveryAttempts = pgTable("portfolio_review_delivery_attempts", {
  id: serial("id").primaryKey(),
  subscriptionId: integer("subscription_id")
    .notNull()
    .references(() => portfolioReviewSubscriptions.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  success: boolean("success").notNull(),
  errorMessage: text("error_message"),
});

export const portfolioReviewJobs = pgTable("portfolio_review_jobs", {
  id: serial("id").primaryKey(),
  subscriptionId: integer("subscription_id")
    .notNull()
    .references(() => portfolioReviewSubscriptions.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  runAt: timestamp("run_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
