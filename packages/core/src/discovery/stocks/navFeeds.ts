// Which tokenized stocks have a Chainlink price feed, from Coinbase's official
// list. Wren lists only those: a feed is the official on-chain price (24/5),
// while a stock with only an Aerodrome pool can sit at a stale price nobody
// trades. When Coinbase adds a feed for a token already in the catalog, the
// stock shows up by itself and its feed is used for history.

import { getAddress, type Address } from "viem";

import { STOCK_CATALOG } from "@/discovery/doppler/stockCatalog.js";
import { logger } from "@/utils/logger.js";

const NAV_FEEDS_URL = "https://api.coinbase.com/v1/tokenized-stocks/nav-feeds";
const CACHE_MS = 60 * 60_000;
const RETRY_MS = 5 * 60_000;
const TIMEOUT_MS = 4000;

/** token contract (lowercase) → feed address. */
export type NavFeeds = Map<string, Address>;

export function parseNavFeeds(json: unknown): NavFeeds | null {
  const list = (json as { nav_feeds?: unknown } | null)?.nav_feeds;
  if (!Array.isArray(list)) return null;
  const feeds: NavFeeds = new Map();
  for (const row of list as { contract_address?: unknown; nav_feed_address?: unknown }[]) {
    try {
      if (typeof row.contract_address !== "string" || typeof row.nav_feed_address !== "string") continue;
      feeds.set(row.contract_address.toLowerCase(), getAddress(row.nav_feed_address));
    } catch {
      // Malformed address: skip the row.
    }
  }
  return feeds;
}

/** The catalog's own feed addresses: the fallback when Coinbase can't be reached. */
export function catalogNavFeeds(): NavFeeds {
  const feeds: NavFeeds = new Map();
  for (const o of STOCK_CATALOG) if (o.feedAddress) feeds.set(o.address.toLowerCase(), getAddress(o.feedAddress));
  return feeds;
}

let cache: { at: number; feeds: NavFeeds; official: boolean } | null = null;
let inflight: Promise<NavFeeds> | null = null;

async function fetchOfficial(): Promise<NavFeeds | null> {
  try {
    const res = await fetch(NAV_FEEDS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const feeds = parseNavFeeds(await res.json());
    return feeds?.size ? feeds : null;
  } catch {
    return null;
  }
}

/**
 * Coinbase's official feeds, cached for an hour. If the fetch fails, the
 * catalog's `feedAddress` values stand in (retried after 5 minutes).
 */
export async function navFeeds(): Promise<NavFeeds> {
  if (cache && Date.now() - cache.at < (cache.official ? CACHE_MS : RETRY_MS)) return cache.feeds;
  inflight ??= fetchOfficial()
    .then((official) => {
      if (!official) logger.warn("[navFeeds] Coinbase feed list unavailable; using the catalog's feeds");
      // Keep the last official list over the catalog if a refresh fails.
      const feeds = official ?? (cache?.official ? cache.feeds : catalogNavFeeds());
      cache = { at: Date.now(), feeds, official: Boolean(official) };
      return feeds;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** A token's Chainlink feed, or null when it has none. */
export async function navFeedFor(tokenAddress: string): Promise<Address | null> {
  return (await navFeeds()).get(tokenAddress.toLowerCase()) ?? null;
}

/** Only the stocks with a Chainlink feed. */
export function withNavFeed<T extends { address: string }>(items: T[], feeds: NavFeeds): T[] {
  return items.filter((i) => feeds.has(i.address.toLowerCase()));
}

/** For tests. */
export function resetNavFeedsCache(): void {
  cache = null;
  inflight = null;
}
