import { db } from "@/discovery/db.js";

import { logger } from "@/utils/logger.js";

import { getStrategyRedisConnection } from "./redis.js";
import type { PriceSample } from "./signals.js";

export const MARK_SAMPLE_CAP = 48;
/** Samples older than this don't count toward the 12-tick warmup window. */
const MAX_SAMPLE_AGE_MS = 20 * 60 * 1000;
const REDIS_KEY_PREFIX = "strategy:mark:";
const REDIS_TTL_SEC = 2 * 60 * 60;

function normalizePair(pair: string): string {
  const p = pair.toUpperCase().trim();
  return p.includes("-") ? p : `${p}-USD`;
}

function pruneStale(samples: PriceSample[]): PriceSample[] {
  const cutoff = Date.now() - MAX_SAMPLE_AGE_MS;
  return samples.filter((s) => s.ts >= cutoff).slice(-MARK_SAMPLE_CAP);
}

function parseSamples(raw: unknown): PriceSample[] | null {
  if (!Array.isArray(raw)) return null;
  const samples = raw.filter(
    (s): s is PriceSample =>
      s != null &&
      typeof s === "object" &&
      typeof (s as PriceSample).ts === "number" &&
      typeof (s as PriceSample).price === "number" &&
      Number.isFinite((s as PriceSample).price),
  );
  return pruneStale(samples);
}

/** In-process cache — hydrated from Postgres on first read after restart. */
const memory = new Map<string, PriceSample[]>();

async function loadFromPostgres(key: string): Promise<PriceSample[] | null> {
  try {
    const res = await db.query<{ samples: unknown }>(
      `SELECT samples FROM strategy_mark_buffers WHERE pair = $1`,
      [key],
    );
    if (!res.rows[0]) return null;
    return parseSamples(res.rows[0].samples);
  } catch (err) {
    logger.warn(`strategy mark postgres load failed: ${(err as Error).message}`);
    return null;
  }
}

async function persistToPostgres(key: string, samples: PriceSample[]): Promise<void> {
  try {
    await db.query(
      `INSERT INTO strategy_mark_buffers (pair, samples, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (pair) DO UPDATE
         SET samples = EXCLUDED.samples, updated_at = NOW()`,
      [key, JSON.stringify(samples)],
    );
  } catch (err) {
    logger.warn(`strategy mark postgres save failed: ${(err as Error).message}`);
  }
}

async function loadFromRedis(key: string): Promise<PriceSample[] | null> {
  try {
    const r = getStrategyRedisConnection();
    if (!r) return null;
    const raw = await r.get(`${REDIS_KEY_PREFIX}${key}`);
    if (!raw) return null;
    return parseSamples(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

async function persistToRedis(key: string, samples: PriceSample[]): Promise<void> {
  try {
    const r = getStrategyRedisConnection();
    if (!r) return;
    await r.setex(`${REDIS_KEY_PREFIX}${key}`, REDIS_TTL_SEC, JSON.stringify(samples));
  } catch {
    /* optional cache — postgres is source of truth */
  }
}

async function getOrHydrate(key: string): Promise<PriceSample[]> {
  const cached = memory.get(key);
  if (cached?.length) return cached;

  const fromRedis = await loadFromRedis(key);
  if (fromRedis?.length) {
    memory.set(key, fromRedis);
    logger.info(`strategy mark history restored ${key} (${fromRedis.length} samples, redis)`);
    void persistToPostgres(key, fromRedis);
    return fromRedis;
  }

  const fromDb = await loadFromPostgres(key);
  if (fromDb?.length) {
    memory.set(key, fromDb);
    logger.info(`strategy mark history restored ${key} (${fromDb.length} samples, postgres)`);
    void persistToRedis(key, fromDb);
    return fromDb;
  }

  return [];
}

/**
 * Append a mark sample for a pair. Shared across all strategies on that pair
 * so four ETH strategies don't each need their own 12-minute warmup.
 */
export async function pushMarkSample(pair: string, price: number): Promise<PriceSample[]> {
  const key = normalizePair(pair);
  const arr = await getOrHydrate(key);
  arr.push({ ts: Date.now(), price });
  const trimmed = pruneStale(arr);
  memory.set(key, trimmed);
  void persistToPostgres(key, trimmed);
  void persistToRedis(key, trimmed);
  return trimmed;
}

/** Read mark samples without appending (for diagnostics / Technicals). */
export async function getMarkSamples(pair: string): Promise<PriceSample[]> {
  const key = normalizePair(pair);
  return getOrHydrate(key);
}

/** For tests — reset in-memory state only. */
export function clearMarkSampleCache(): void {
  memory.clear();
}
