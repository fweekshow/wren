/**
 * One-time refund audit for the profit-fee double-charge bug (Jun 24 2026).
 *
 * The bug: high_water_mark_usd started at 0 for ALL strategies when the profit
 * fee shipped. If setHighWaterMark silently failed, each 60s tick charged 10%
 * of the FULL realized PnL instead of just the increment, draining the wallet.
 *
 * This script:
 *  1. Queries strategy_fee_settlements to find total charged per strategy.
 *  2. Computes the CORRECT one-time fee (10% of current realized PnL once).
 *  3. Prints the over-charge (excess) per execution wallet that needs refunding.
 *
 * Run: bun run packages/core/src/discovery/strategy/refund-overcharged-fees.ts
 */

import "@/load-env.js";
import { connectDb, db } from "@/discovery/db.js";

await connectDb();

const res = await db.query(`
  SELECT
    s.id,
    s.name,
    s.execution_wallet_address,
    s.realized_pnl_usd,
    s.high_water_mark_usd,
    COALESCE(
      (SELECT SUM(fee_usd) FROM strategy_fee_settlements WHERE strategy_id = s.id),
      0
    ) AS total_charged_usd
  FROM strategies s
  WHERE s.execution_wallet_address IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM strategy_fee_settlements sfs WHERE sfs.strategy_id = s.id
    )
  ORDER BY total_charged_usd DESC
`);

const FEE_BPS = 0.10; // 10%
const FEE_WALLET = process.env.VIBE_TRADING_FEE_WALLET ?? "(not set)";

console.log(`\nFee wallet: ${FEE_WALLET}\n`);
console.log("=".repeat(80));

let totalOvercharge = 0;

for (const row of res.rows) {
  const totalCharged = Number(row.total_charged_usd);
  const realizedPnl = Number(row.realized_pnl_usd);

  // Correct fee is 10% of whatever the current realized PnL is — charged once.
  const correctFee = Math.max(0, realizedPnl * FEE_BPS);
  const overcharge = Math.max(0, totalCharged - correctFee);

  console.log(`Strategy: ${row.name} (${row.id.slice(0, 8)})`);
  console.log(`  Execution wallet:  ${row.execution_wallet_address}`);
  console.log(`  Realized PnL:      $${realizedPnl.toFixed(4)}`);
  console.log(`  Correct fee (10%): $${correctFee.toFixed(4)}`);
  console.log(`  Total charged:     $${totalCharged.toFixed(4)}`);
  console.log(`  OVERCHARGE:        $${overcharge.toFixed(4)} ← send back from fee wallet`);

  if (overcharge > 0) {
    totalOvercharge += overcharge;
    console.log(
      `  → send ${overcharge.toFixed(6)} USDC from ${FEE_WALLET} to ${row.execution_wallet_address}`,
    );
  } else {
    console.log("  → no refund needed");
  }
  console.log();
}

console.log("=".repeat(80));
console.log(`TOTAL REFUND NEEDED: $${totalOvercharge.toFixed(4)} USDC`);
console.log();
if (totalOvercharge > 0) {
  console.log(
    "Send the amounts above from the fee wallet to the respective execution wallets.",
  );
  console.log("After refunding, the HWM migration in strategy.adapter.ts will prevent this");
  console.log("from happening again on the next deploy.");
}

process.exit(0);
