/**
 * 24h DEX volume per stock, used to list the most traded stocks first.
 *
 * base.org/markets/stocks doesn't publish per-stock volume (its 24h column
 * is blank), so this sums DexScreener's 24h volume over every Base pair for
 * each token. Refreshed in the background every 10 minutes; callers never
 * wait more than a few seconds, and fall back to catalog order.
 */
import { listSpotBuyableOffers } from "@/discovery/doppler/stockCatalog.js";
import { logger } from "@/utils/logger.js";

const TTL_MS = 10 * 60_000;
const CONCURRENCY = 8;
const COLD_WAIT_MS = 3000;

type Volumes = Map<string, number>;

let cache: { at: number; volumes: Volumes } | null = null;
let inflight: Promise<Volumes | null> | null = null;

async function fetchTokenVolume(address: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/base/${address}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const pairs = (await res.json()) as Array<{ volume?: { h24?: number } }>;
    if (!Array.isArray(pairs)) return null;
    return pairs.reduce((sum, p) => sum + (Number(p.volume?.h24) || 0), 0);
  } catch {
    return null;
  }
}

async function refresh(): Promise<Volumes | null> {
  const offers = listSpotBuyableOffers();
  const volumes: Volumes = new Map();
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < offers.length) {
        const o = offers[next++]!;
        const v = await fetchTokenVolume(o.address);
        if (v !== null) volumes.set(o.symbol, v);
      }
    }),
  );
  // Mostly failed (rate limit, outage): keep the last good ranking.
  if (volumes.size < offers.length / 2) {
    logger.warn({ got: volumes.size, of: offers.length }, "[stocks] volume refresh incomplete");
    return cache?.volumes ?? null;
  }
  cache = { at: Date.now(), volumes };
  return volumes;
}

function refreshOnce(): Promise<Volumes | null> {
  inflight ??= refresh().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Latest 24h volumes by symbol, or null if none are known yet. Serves stale while refreshing. */
export async function stockVolumes24h(): Promise<Volumes | null> {
  if (cache) {
    if (Date.now() - cache.at > TTL_MS) void refreshOnce();
    return cache.volumes;
  }
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), COLD_WAIT_MS));
  return Promise.race([refreshOnce(), timeout]);
}

/** Highest volume first; stocks without a number keep catalog order at the end. */
export function sortByVolume<T extends { symbol: string }>(items: T[], volumes: Volumes | null): T[] {
  if (!volumes) return items;
  return items
    .map((item, i) => ({ item, i, v: volumes.get(item.symbol) ?? -1 }))
    .sort((a, b) => b.v - a.v || a.i - b.i)
    .map((x) => x.item);
}

/** Tests only. */
export function resetStockVolumeCache(): void {
  cache = null;
  inflight = null;
}
