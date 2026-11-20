import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { StrategyConfig } from "@basemate/shared";

export const strategies = pgTable("strategies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  creatorInboxId: text("creator_inbox_id").notNull(),
  creatorWallet: text("creator_wallet"),
  creatorBasename: text("creator_basename"),
  prompt: text("prompt").notNull(),
  config: jsonb("config").$type<StrategyConfig>().notNull(),
  status: text("status").notNull().default("draft"),
  executionWalletName: text("execution_wallet_name"),
  executionWalletAddress: text("execution_wallet_address"),
  defaultCollateralUsdc: numeric("default_collateral_usdc"),
  featured: boolean("featured").notNull().default(false),
  realizedPnlUsd: numeric("realized_pnl_usd").notNull().default("0"),
  highWaterMarkUsd: numeric("high_water_mark_usd").notNull().default("0"),
  tradeCount: integer("trade_count").notNull().default(0),
  maxDrawdownPct: numeric("max_drawdown_pct").notNull().default("0"),
  daysLive: integer("days_live").notNull().default(0),
  wikiDirty: boolean("wiki_dirty").notNull().default(false),
  deployedAt: timestamp("deployed_at", { withTimezone: true }),
  lastEvalAt: timestamp("last_eval_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const strategyTrades = pgTable("strategy_trades", {
  id: uuid("id").primaryKey().defaultRandom(),
  strategyId: uuid("strategy_id")
    .notNull()
    .references(() => strategies.id, { onDelete: "cascade" }),
  pair: text("pair").notNull(),
  side: text("side").notNull(),
  mode: text("mode").notNull(),
  txHash: text("tx_hash"),
  collateralUsdc: numeric("collateral_usdc").notNull().default("0"),
  leverage: numeric("leverage"),
  pnlUsd: numeric("pnl_usd").notNull().default("0"),
  tradeIndex: integer("trade_index"),
  pairIndex: integer("pair_index"),
  openPrice: numeric("open_price"),
  walletAddress: text("wallet_address"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  lastUnrealizedUsd: numeric("last_unrealized_usd"),
  isPaper: boolean("is_paper").notNull().default(false),
  exitReason: text("exit_reason"),
  closePrice: numeric("close_price"),
  entryRegime: text("entry_regime"),
  durationS: integer("duration_s"),
  maxFavorableMovePct: numeric("max_favorable_move_pct"),
  maxAdverseMovePct: numeric("max_adverse_move_pct"),
  pnlReconciled: boolean("pnl_reconciled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const strategyMarkBuffers = pgTable("strategy_mark_buffers", {
  pair: text("pair").primaryKey(),
  samples: jsonb("samples").$type<number[]>().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const strategyFeeSettlements = pgTable("strategy_fee_settlements", {
  id: uuid("id").primaryKey().defaultRandom(),
  strategyId: uuid("strategy_id")
    .notNull()
    .references(() => strategies.id, { onDelete: "cascade" }),
  feeUsd: numeric("fee_usd").notNull().default("0"),
  profitIncrementUsd: numeric("profit_increment_usd").notNull().default("0"),
  hwmAfter: numeric("hwm_after").notNull().default("0"),
  txHash: text("tx_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const strategyWikiHistory = pgTable("strategy_wiki_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  strategyId: uuid("strategy_id")
    .notNull()
    .references(() => strategies.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  compiledAt: timestamp("compiled_at", { withTimezone: true }).notNull().defaultNow(),
});

export const platformBrainHistory = pgTable("platform_brain_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  content: text("content").notNull(),
  strategyCount: integer("strategy_count").notNull().default(0),
  tradeCount: integer("trade_count").notNull().default(0),
  compiledAt: timestamp("compiled_at", { withTimezone: true }).notNull().defaultNow(),
});
