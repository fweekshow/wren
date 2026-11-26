// Yahoo Finance's free chart API, for stocks Coinbase has no Chainlink feed
// for. Their Aerodrome pools barely trade, so without this those stocks show
// a flat line and a 0% day.
//
// Unofficial and unauthenticated: it rate-limits by IP (429) and rejects
// non-browser User-Agents. So: browser UA, 4 requests in flight at most,
// 10-minute cache, a short cool-off after a 429, and null on any failure so
// callers fall back to the pool.

import { logger } from "@/utils/logger.js";

const BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TIMEOUT_MS = 4000;
const CACHE_MS = 10 * 60_000;
const COOL_OFF_MS = 2 * 60_000;
const MAX_IN_FLIGHT = 4;
/** A daily candle is stamped at the 9:30 ET open; its close lands 6.5h later. */
const SESSION_MS = 390 * 60_000;

export type YahooRange = "5d" | "1mo" | "1y";
export type YahooInterval = "1h" | "1d";

export type YahooChart = {
  /** Last regular-session price. */
  price: number | null;
  /** When `price` traded (ms). */
  marketTime: number | null;
  /** [candle start ms, close], oldest first, nulls dropped. */
  candles: [number, number][];
};

/** Wren symbol → Yahoo ticker: `BRK.Bc` → `BRK-B`, `UBERc` → `UBER`. */
export function yahooTicker(symbol: string): string {
  return symbol.replace(/c$/, "").replace(/\./g, "-");
}

export function parseYahooChart(json: unknown): YahooChart | null {
  const result = (json as { chart?: { result?: unknown[] } } | null)?.chart?.result?.[0] as
    | {
        meta?: { regularMarketPrice?: number; regularMarketTime?: number };
        timestamp?: number[];
        indicators?: { quote?: { close?: (number | null)[] }[] };
      }
    | undefined;
  if (!result?.meta) return null;
  const ts = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const candles: [number, number][] = [];
  ts.forEach((t, i) => {
    const c = closes[i];
    if (typeof c === "number" && Number.isFinite(c) && c > 0) candles.push([t * 1000, c]);
  });
  const price = Number(result.meta.regularMarketPrice);
  const time = Number(result.meta.regularMarketTime);
  return {
    price: Number.isFinite(price) && price > 0 ? price : null,
    marketTime: Number.isFinite(time) && time > 0 ? time * 1000 : null,
    candles,
  };
}

const nyDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * The previous trading day's close from daily candles: the last close from a
 * New York day before today. Once today's session has a candle that is the
 * second-to-last; before the open, on weekends and holidays it is the last.
 * Wren's live price is the 24/7 pool, so on a holiday the "today" change runs
 * from the last session's close.
 * (`meta.chartPreviousClose` is the close before the whole range: not this.)
 */
export function previousClose(
  candles: [number, number][],
  now: number = Date.now(),
): { at: number; price: number } | null {
  const today = nyDay.format(new Date(now));
  for (let i = candles.length - 1; i >= 0; i--) {
    const [t, close] = candles[i];
    if (nyDay.format(new Date(t)) < today) return { at: t + SESSION_MS, price: close };
  }
  return null;
}

/** Candle → the time its close was set: the end of its hour or session. */
export function candleCloseAt(start: number, interval: YahooInterval): number {
  return start + (interval === "1d" ? SESSION_MS : 60 * 60_000);
}

// ── Fetching ───────────────────────────────────────────────────────────────

const cache = new Map<string, { at: number; chart: YahooChart | null }>();
const inflight = new Map<string, Promise<YahooChart | null>>();
let coolOffUntil = 0;
let active = 0;
const waiting: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_IN_FLIGHT) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

async function fetchChart(ticker: string, range: YahooRange, interval: YahooInterval): Promise<YahooChart | null> {
  if (Date.now() < coolOffUntil) return null;
  try {
    const res = await fetch(`${BASE_URL}${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 429) {
      coolOffUntil = Date.now() + COOL_OFF_MS;
      logger.warn(`[yahoo] rate limited; pausing ${COOL_OFF_MS / 1000}s`);
      return null;
    }
    if (!res.ok) return null;
    return parseYahooChart(await res.json());
  } catch {
    return null;
  }
}

/** A Wren stock's Yahoo chart, cached for 10 minutes; null when Yahoo fails. */
export async function yahooChart(
  symbol: string,
  range: YahooRange = "5d",
  interval: YahooInterval = "1d",
): Promise<YahooChart | null> {
  const ticker = yahooTicker(symbol);
  const key = `${ticker}|${range}|${interval}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.chart;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = slot(() => fetchChart(ticker, range, interval))
    .then((chart) => {
      // Failures are not cached, so the next call retries (the 429 cool-off
      // keeps that from hammering Yahoo).
      if (chart) cache.set(key, { at: Date.now(), chart });
      return chart;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** For tests. */
export function resetYahooCache(): void {
  cache.clear();
  inflight.clear();
  coolOffUntil = 0;
}
