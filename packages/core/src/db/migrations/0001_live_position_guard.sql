-- Enforce at most one open (non-paper) live position per strategy + pair.
-- Only active when closed_at IS NULL, so historical closed trades are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "strategy_trades_live_open_pair_uniq"
  ON "strategy_trades" ("strategy_id", "pair")
  WHERE "closed_at" IS NULL AND "is_paper" = false;
