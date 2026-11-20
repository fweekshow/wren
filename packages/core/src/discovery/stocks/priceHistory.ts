// Stock price history for Wren's charts, sparklines and "today" changes.
//
// Two free sources, no vendor:
// - Backfill: Chainlink's own past rounds on Base. Reading a feed is a free
//   view call; equity feeds update ~10–15 times a trading day, so this is
//   good for 1W / 1M / 1Y.
// - Snapshots: every 5 minutes, the same live price quotes use
//   (liveSharePriceUsd: Chainlink, or the Aerodrome pool when they drift or
//   the market is closed). This makes the 1D line smooth.
//
// Rows are keyed by (symbol, at) with snapshots rounded to their 5-minute
// slot, so several server replicas running the job never duplicate rows.

import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";

import { resolveBaseRpcUrl } from "@/chain/base-rpc.js";
import { db } from "@/discovery/db.js";
import { listSpotBuyableOffers } from "@/discovery/doppler/stockCatalog.js";
import { resolveStockToken } from "@/discovery/doppler/stockRegistry.js";
import { liveSharePriceUsd } from "@/discovery/stocks/giftStock.service.js";
import { logger } from "@/utils/logger.js";

export type PriceRange = "1D" | "1W" | "1M" | "1Y";

const RANGE_MS: Record<PriceRange, number> = {
  "1D": 24 * 60 * 60 * 1000,
  "1W": 7 * 24 * 60 * 60 * 1000,
  "1M": 31 * 24 * 60 * 60 * 1000,
  "1Y": 366 * 24 * 60 * 60 * 1000,
};
const MAX_POINTS = 120;
const SNAPSHOT_SLOT_MS = 5 * 60 * 1000;
const BACKFILL_DAYS = 366;
const BACKFILL_MAX_ROUNDS = 6000;
const FEED_DECIMALS = 8;

let tableReady: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  tableReady ??= db
    .query(
      `CREATE TABLE IF NOT EXISTS stock_prices (
         symbol    TEXT NOT NULL,
         at        TIMESTAMPTZ NOT NULL,
         price_usd NUMERIC NOT NULL,
         source    TEXT NOT NULL,
         PRIMARY KEY (symbol, at)
       );
       CREATE TABLE IF NOT EXISTS stock_price_backfills (
         symbol  TEXT PRIMARY KEY,
         done_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         rounds  INTEGER NOT NULL
       );`,
    )
    .then(() => undefined)
    .catch((err) => {
      tableReady = null;
      throw err;
    });
  return tableReady;
}

async function insertPrices(rows: { symbol: string; at: Date; price: number; source: string }[]): Promise<void> {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const values: unknown[] = [];
    const tuples = chunk.map((r, j) => {
      values.push(r.symbol, r.at.toISOString(), r.price, r.source);
      return `($${j * 4 + 1}, $${j * 4 + 2}, $${j * 4 + 3}, $${j * 4 + 4})`;
    });
    await db.query(
      `INSERT INTO stock_prices (symbol, at, price_usd, source) VALUES ${tuples.join(",")}
       ON CONFLICT (symbol, at) DO NOTHING`,
      values,
    );
  }
}

// ── Snapshots ──────────────────────────────────────────────────────────────

/** Saves the live price of every sendable stock for the current 5-minute slot. */
export async function snapshotStockPrices(now = new Date()): Promise<number> {
  await ensureTable();
  const slot = new Date(Math.floor(now.getTime() / SNAPSHOT_SLOT_MS) * SNAPSHOT_SLOT_MS);
  const rows: { symbol: string; at: Date; price: number; source: string }[] = [];
  for (const offer of listSpotBuyableOffers()) {
    const entry = resolveStockToken(offer.symbol);
    if (!entry) continue;
    const live = await liveSharePriceUsd(entry).catch(() => null);
    if (live) rows.push({ symbol: offer.symbol, at: slot, price: live.priceUsd, source: live.source });
  }
  await insertPrices(rows);
  return rows.length;
}

// ── Chainlink backfill ─────────────────────────────────────────────────────

const PROXY_ABI = [
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    name: "getRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint80" }],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    name: "phaseAggregators",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "phaseId", type: "uint16" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const AGGREGATOR_ABI = [
  { name: "latestRound", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const PHASE_SHIFT = 64n;
const AGG_MASK = (1n << PHASE_SHIFT) - 1n;

function client() {
  return createPublicClient({
    chain: base,
    transport: http(resolveBaseRpcUrl()),
    batch: { multicall: true },
  });
}

/**
 * Reads a stock's Chainlink rounds back to BACKFILL_DAYS ago, across feed
 * phases. Runs once per symbol (recorded in stock_price_backfills).
 */
export async function backfillStockFromChainlink(symbol: string): Promise<number> {
  await ensureTable();
  const done = await db.query(`SELECT 1 FROM stock_price_backfills WHERE symbol = $1`, [symbol]);
  if (done.rows.length) return 0;
  const entry = resolveStockToken(symbol);
  if (!entry?.feedAddress) return 0;
  const feed = entry.feedAddress as Address;
  const c = client();
  const cutoffSec = Math.floor((Date.now() - BACKFILL_DAYS * 86_400_000) / 1000);

  const [latestId] = await c.readContract({ address: feed, abi: PROXY_ABI, functionName: "latestRoundData" });
  let phase = latestId >> PHASE_SHIFT;
  let round = latestId & AGG_MASK;
  const rows: { symbol: string; at: Date; price: number; source: string }[] = [];
  let reachedCutoff = false;

  while (phase > 0n && rows.length < BACKFILL_MAX_ROUNDS && !reachedCutoff) {
    while (round > 0n && rows.length < BACKFILL_MAX_ROUNDS && !reachedCutoff) {
      const ids: bigint[] = [];
      for (let k = 0n; k < 100n && round - k > 0n; k++) ids.push((phase << PHASE_SHIFT) | (round - k));
      const results = await Promise.all(
        ids.map((id) =>
          c.readContract({ address: feed, abi: PROXY_ABI, functionName: "getRoundData", args: [id] }).catch(() => null),
        ),
      );
      for (const r of results) {
        if (!r) continue;
        const updatedAt = Number(r[3]);
        const answer = r[1];
        if (!updatedAt || answer <= 0n) continue;
        if (updatedAt < cutoffSec) {
          reachedCutoff = true;
          break;
        }
        rows.push({ symbol, at: new Date(updatedAt * 1000), price: Number(answer) / 10 ** FEED_DECIMALS, source: "chainlink_round" });
      }
      round -= BigInt(ids.length);
    }
    // Earlier phase: its aggregator knows its own last round.
    phase -= 1n;
    if (phase <= 0n) break;
    try {
      const agg = await c.readContract({ address: feed, abi: PROXY_ABI, functionName: "phaseAggregators", args: [Number(phase)] });
      if (!agg || /^0x0+$/.test(agg)) break;
      round = await c.readContract({ address: agg, abi: AGGREGATOR_ABI, functionName: "latestRound" });
    } catch {
      break;
    }
  }

  await insertPrices(rows);
  await db.query(
    `INSERT INTO stock_price_backfills (symbol, rounds) VALUES ($1, $2) ON CONFLICT (symbol) DO NOTHING`,
    [symbol, rows.length],
  );
  return rows.length;
}

// ── Reads ──────────────────────────────────────────────────────────────────

/** Keeps the last price in each time bucket so a chart is at most `max` points. */
export function downsample(points: [number, number][], max = MAX_POINTS): [number, number][] {
  if (points.length <= max) return points;
  const start = points[0][0];
  const span = points[points.length - 1][0] - start || 1;
  const out: [number, number][] = [];
  let bucket = -1;
  for (const p of points) {
    const b = Math.min(max - 1, Math.floor(((p[0] - start) / span) * max));
    if (b === bucket) out[out.length - 1] = p;
    else {
      out.push(p);
      bucket = b;
    }
  }
  return out;
}

export function changePct(from: number | null, to: number | null): number | null {
  if (!from || !to) return null;
  return Math.round(((to - from) / from) * 10_000) / 100;
}

/** Points for a chart, plus the change across the range. */
export async function stockPriceHistory(
  symbol: string,
  range: PriceRange,
): Promise<{ symbol: string; range: PriceRange; priceUsd: number | null; changePct: number | null; points: [number, number][] }> {
  await ensureTable();
  const since = new Date(Date.now() - RANGE_MS[range]);
  const [inRange, before] = await Promise.all([
    db.query(
      `SELECT EXTRACT(EPOCH FROM at) * 1000 AS t, price_usd::float AS p
         FROM stock_prices WHERE symbol = $1 AND at >= $2 ORDER BY at`,
      [symbol, since.toISOString()],
    ),
    db.query(
      `SELECT price_usd::float AS p FROM stock_prices WHERE symbol = $1 AND at < $2 ORDER BY at DESC LIMIT 1`,
      [symbol, since.toISOString()],
    ),
  ]);
  const points = (inRange.rows as { t: string | number; p: number }[]).map(
    (r) => [Number(r.t), Number(r.p)] as [number, number],
  );
  const last = points.length ? points[points.length - 1][1] : null;
  // Change is measured from the last price before the range opened.
  const baseline = (before.rows[0] as { p?: number } | undefined)?.p ?? (points[0]?.[1] ?? null);
  return { symbol, range, priceUsd: last, changePct: changePct(baseline, last), points: downsample(points) };
}

/** Every sendable stock with its latest price, change over 24h and a 1D sparkline. */
export async function stockMarket(): Promise<
  { symbol: string; name: string; priceUsd: number | null; changePct: number | null; spark: number[] }[]
> {
  const offers = listSpotBuyableOffers();
  return Promise.all(
    offers.map(async (o) => {
      const h = await stockPriceHistory(o.symbol, "1D").catch(() => null);
      return {
        symbol: o.symbol,
        name: o.name,
        priceUsd: h?.priceUsd ?? null,
        changePct: h?.changePct ?? null,
        spark: downsample(h?.points ?? [], 24).map((p) => p[1]),
      };
    }),
  );
}

// ── The job ────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the 5-minute snapshot job and backfills any stock not yet backfilled.
 * Safe to run on several replicas: rows dedupe on (symbol, slot).
 * Off when DISABLE_PRICE_HISTORY=true.
 */
export function startPriceHistoryJob(): void {
  if (timer || process.env.DISABLE_PRICE_HISTORY === "true") return;
  const tick = () =>
    snapshotStockPrices().catch((err) => logger.warn({ err }, "[prices] snapshot failed"));
  void tick();
  timer = setInterval(tick, SNAPSHOT_SLOT_MS);
  void (async () => {
    for (const offer of listSpotBuyableOffers()) {
      try {
        const n = await backfillStockFromChainlink(offer.symbol);
        if (n) logger.info(`[prices] backfilled ${offer.symbol}: ${n} Chainlink rounds`);
      } catch (err) {
        logger.warn({ err, symbol: offer.symbol }, "[prices] backfill failed");
      }
    }
  })();
}
