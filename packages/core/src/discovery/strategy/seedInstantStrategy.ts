/**
 * Seed one live automated strategy that fires on the next runner tick.
 * Uses the real StrategyRunner → executeStrategySignal path (not manual perps).
 *
 * Usage (from repo root, DATABASE_URL set):
 *   bun packages/core/src/discovery/strategy/seedInstantStrategy.ts
 *   bun packages/core/src/discovery/strategy/seedInstantStrategy.ts --reset
 */
import "@/load-env.js";

if (process.env.NODE_ENV === "production" && !process.argv.includes("--i-know-what-im-doing")) {
  console.error(
    "ERROR: seedInstantStrategy is a dev/staging tool. Running it in production inserts live strategies with hardcoded wallet addresses.\n" +
    "Pass --i-know-what-im-doing to override (not recommended in production).",
  );
  process.exit(1);
}

import { clampToRails } from "@basemate/shared";

import { connectDb } from "@/discovery/db.js";
import { db } from "@/discovery/db.js";

const CREATOR_INBOX = "132ddfd29e29096151775be0f3a9f996e059c10dd952b16d3749e9320f5ba424";
const CREATOR_WALLET = "0x22209cfc1397832f32160239c902b10a624cab1a";
const WALLET_NAME = "cp-6760e41bee74448d0abba2c34b577a";
const WALLET_ADDRESS = "0xae52ed21a8c567e0e42f1801bed37c6f90236734";
const STRATEGY_NAME = "ETH Auto Test Long";

const INSTANT_CONFIG = clampToRails({
  enabledStrategies: ["superburst"],
  pairs: ["ETH-USD"],
  maxLeverage: 75,
  riskPerTradePct: 0.5,
  smokeTest: {
    side: "long",
    tpPercent: 5,
    slPercent: 3,
  },
});

async function main(): Promise<void> {
  const reset = process.argv.includes("--reset");
  await connectDb();

  const archived = await db.query(
    `UPDATE strategies SET status = 'archived', updated_at = NOW()
     WHERE creator_inbox_id = $1 AND status IN ('testing', 'published', 'publishable')
       AND name != $2
     RETURNING name`,
    [CREATOR_INBOX, STRATEGY_NAME],
  );
  if (archived.rowCount) {
    console.log(`Archived ${archived.rowCount} other live strateg(ies).`);
  }

  const existing = await db.query(
    `SELECT id, trade_count FROM strategies
     WHERE creator_inbox_id = $1 AND name = $2 AND status != 'archived'
     LIMIT 1`,
    [CREATOR_INBOX, STRATEGY_NAME],
  );

  if (existing.rows[0] && !reset) {
    const row = existing.rows[0];
    if (Number(row.trade_count) > 0) {
      console.log(
        `\nStrategy already fired once (trade_count=${row.trade_count}). Re-run with --reset to arm again:\n  bun packages/core/src/discovery/strategy/seedInstantStrategy.ts --reset\n`,
      );
      return;
    }
    console.log(`Instant strategy already armed: ${row.id}`);
    console.log("Restart dev server or wait ≤60s for the runner tick.");
    return;
  }

  if (existing.rows[0] && reset) {
    await db.query(`UPDATE strategies SET status = 'archived' WHERE id = $1`, [existing.rows[0].id]);
  }

  const res = await db.query(
    `INSERT INTO strategies (
       name, creator_inbox_id, creator_wallet, prompt, config, status,
       execution_wallet_name, execution_wallet_address, default_collateral_usdc,
       deployed_at, trade_count
     ) VALUES ($1, $2, $3, $4, $5, 'testing', $6, $7, $8, NOW(), 0)
     RETURNING id, name`,
    [
      STRATEGY_NAME,
      CREATOR_INBOX,
      CREATOR_WALLET,
      "automated test — instant ETH long on next runner tick, $2 @ 75x, +5% tp / -3% sl",
      JSON.stringify(INSTANT_CONFIG),
      WALLET_NAME,
      WALLET_ADDRESS,
      2,
    ],
  );

  const row = res.rows[0];
  console.log("\n✅ Instant automated strategy armed:");
  console.log(`   id:         ${row.id}`);
  console.log(`   name:       ${row.name}`);
  console.log(`   trade:      ETH long · $2 margin · 75x · tp +5% · sl -3%`);
  console.log(`   wallet:     ${WALLET_ADDRESS}`);
  console.log("\nNext steps:");
  console.log("  1. Fund Basemate wallet with ≥$2 USDC + a little ETH on Base");
  console.log("  2. Restart dev server (runner ticks immediately on start)");
  console.log("  3. Watch logs for: strategy exec … tx=…");
  console.log("  4. Say 'my strategies' — trade_count should become 1");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
