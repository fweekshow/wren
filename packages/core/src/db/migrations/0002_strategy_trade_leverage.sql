-- Snapshot leverage on strategy trade rows so paper PnL stays stable even if
-- the strategy config is remixed after a position opens.
ALTER TABLE "strategy_trades"
  ADD COLUMN IF NOT EXISTS "leverage" numeric;
