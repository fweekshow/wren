/**
 * Dry-run strategy signal evaluation against synthetic price paths and live mark.
 *
 * Usage (from repo root, with DATABASE_URL set):
 *   bun packages/core/src/discovery/strategy/dryRunEval.ts
 *   bun packages/core/src/discovery/strategy/dryRunEval.ts <strategy-uuid-prefix>
 */
import "@/load-env.js";

if (process.env.NODE_ENV === "production" && !process.argv.includes("--i-know-what-im-doing")) {
  console.error(
    "ERROR: dryRunEval is a dev/staging tool that reads live strategy rows from the database.\n" +
    "Pass --i-know-what-im-doing to override.",
  );
  process.exit(1);
}

import { fetchAvantisMarkPrice, isAvantisLive } from "@basemate/avantis-client";

import { StrategyAdapter } from "@/discovery/adapters/strategy.adapter.js";
import { connectDb, db } from "@/discovery/db.js";

import { getMarkSamples } from "./priceHistory.js";
import { evaluateOracleDiagnostics, evaluateOracleSignals, type PriceSample } from "./signals.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveStrategy(idOrPrefix?: string) {
  const key = idOrPrefix?.trim();
  if (!key) {
    const active = await StrategyAdapter.listActiveForEval();
    const row = active[0] ?? null;
    if (!row) return null;
    console.log(`No id passed — using first active strategy: ${row.name} (${row.id})\n`);
    return row;
  }

  if (UUID_RE.test(key)) {
    const exact = await StrategyAdapter.getById(key);
    if (exact) return exact;
  }

  const all = await StrategyAdapter.listActiveForEval();
  const byPrefix = all.find((s) => s.id.startsWith(key)) ?? null;
  if (byPrefix) return byPrefix;

  // Also search non-eval statuses (e.g. paper-only rows not in listActiveForEval edge cases).
  const res = await db.query(`SELECT id FROM strategies WHERE id::text LIKE $1 LIMIT 1`, [`${key}%`]);
  const fullId = res.rows[0]?.id as string | undefined;
  return fullId ? StrategyAdapter.getById(fullId) : null;
}

const SCENARIOS: Array<{ label: string; build: (mark: number) => number[] }> = [
  {
    label: "flat chop (should NOT fire with antiChop)",
    build: (mark) => Array.from({ length: 12 }, (_, i) => mark + (i % 2 === 0 ? 0.02 : -0.02)),
  },
  {
    label: "superburst long (+2.5% in last 5 samples)",
    build: (mark) => {
      const flat = Array.from({ length: 7 }, () => mark);
      const ramp = [mark, mark * 1.005, mark * 1.012, mark * 1.02, mark * 1.026];
      return [...flat, ...ramp];
    },
  },
  {
    label: "crash / alpha crush short (-2.5% in last 5 samples)",
    build: (mark) => {
      const flat = Array.from({ length: 7 }, () => mark);
      const dump = [mark, mark * 0.995, mark * 0.985, mark * 0.975, mark * 0.965];
      return [...flat, ...dump];
    },
  },
  {
    label: "breakout long (trend up + at window high)",
    build: (mark) => {
      const base = mark * 0.99;
      return Array.from({ length: 12 }, (_, i) => base + (i / 11) * (mark - base));
    },
  },
];

function samplesFromPrices(prices: number[]): PriceSample[] {
  const start = Date.now() - prices.length * 60_000;
  return prices.map((price, i) => ({ ts: start + i * 60_000, price }));
}

async function main(): Promise<void> {
  await connectDb();

  const prefix = process.argv.slice(2).find((a) => !a.startsWith("-"));
  const row = await resolveStrategy(prefix);
  if (!row) {
    console.error("Strategy not found — pass a full UUID or prefix (e.g. d1d5e725).");
    process.exit(1);
  }

  const pairs = row.config.pairs.filter(Boolean);
  if (!pairs.length) {
    console.error("Strategy has no pairs configured.");
    process.exit(1);
  }

  console.log(`Strategy: ${row.name} (${row.id})`);
  console.log(`Status:   ${row.status} · trades: ${row.trade_count} · last eval: ${row.last_eval_at ?? "never"}`);
  console.log(`Pairs:    ${pairs.join(", ")}`);
  console.log(`Modes:    ${row.config.enabledStrategies.join(", ")}`);
  console.log(`Wallet:   ${row.execution_wallet_address ?? "(not bound yet)"}`);
  console.log(`\nLive runner needs ~12 minutes of 60s mark samples before entries.`);
  console.log(`Reading prod mark buffers when available (Avantis fetch optional).\n`);

  console.log("── Live mark buffers (prod DB) ──");
  for (const pair of pairs) {
    const samples = await getMarkSamples(pair);
    const price = samples.length ? samples[samples.length - 1]!.price : 0;
    const d = evaluateOracleDiagnostics({ pair, price, samples, config: row.config });
    const block =
      d.blockReason ??
      (d.signal ? `would fire ${d.signal.mode} ${d.signal.side}` : "none");
    console.log(
      `${pair} · mark $${price.toFixed(2)} · ${d.sampleCount} samples · range12 ${d.range12Pct.toFixed(3)}% · move5 ${d.move5Pct >= 0 ? "+" : ""}${d.move5Pct.toFixed(3)}%`,
    );
    console.log(`  regime ${d.regime}${d.isTrueChop ? " (true chop)" : ""} · ${block}`);
  }
  console.log("");

  const primaryPair = pairs[0]!;
  const base = primaryPair.split("-")[0] ?? primaryPair;
  const live = isAvantisLive();
  const mark = live ? await fetchAvantisMarkPrice(base).catch(() => null) : null;
  if (mark == null && live) {
    console.log(
      "Note: Avantis mark fetch failed locally (network/env) — synthetic scenarios below use $100.\n",
    );
  }
  const refMark = mark ?? 100;

  console.log(`── Synthetic scenarios (${primaryPair} @ $${refMark.toFixed(2)}) ──`);
  for (const scenario of SCENARIOS) {
    const prices = scenario.build(refMark);
    const signal = evaluateOracleSignals({
      pair: primaryPair,
      price: prices[prices.length - 1]!,
      samples: samplesFromPrices(prices),
      config: row.config,
    });
    const outcome = signal
      ? `${signal.mode} ${signal.side} — ${signal.reason} (conf ${signal.confidence})`
      : "no signal";
    console.log(`• ${scenario.label}`);
    console.log(`  → ${outcome}\n`);
  }

  if (row.trade_count === 0 && row.status === "testing") {
    console.log(
      "Tip: fund the Basemate wallet with USDC + ETH on Base before a live fire — execution uses the CDP cp- wallet.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
