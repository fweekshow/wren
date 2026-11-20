import { db } from "@/discovery/db.js";

const CACHE_MS = 60 * 1000;
const BATCH_SIZE = 30;
/** Local cache for Dune GET reads — refresh when you re-run the query on dune.com. */
const LIFETIME_READ_CACHE_MS = 30 * 60 * 1000;

const DUNE_API_KEY = process.env.DUNE_API_KEY ?? "";
const DUNE_BANKR_QUERY_ID =
  process.env.DUNE_BANKR_LIFETIME_QUERY_ID?.trim() || "7729265";

export interface BankrMarketStats {
  tradingVolume24hUsdc: number;
  tradingVolumeLifetimeUsdc: number;
}

let cachedStats: { value: BankrMarketStats; fetchedAt: number } | null = null;
let lifetimeCache: { value: number; fetchedAt: number } | null = null;

/** Drop cached DexScreener totals (e.g. after a new token launch). */
export function invalidateBankrMarketStatsCache(): void {
  cachedStats = null;
}

type DexTokenRef = { address?: string };
type DexPair = {
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  baseToken?: DexTokenRef;
};

function aggregatePairs(pairs: DexPair[]): { tradingVolume24hUsdc: number } {
  const perToken = new Map<string, { vol24: number }>();

  for (const pair of pairs) {
    const addr = pair.baseToken?.address?.toLowerCase();
    if (!addr) continue;
    const vol = pair.volume?.h24;
    const vol24 = typeof vol === "number" && Number.isFinite(vol) ? vol : 0;
    const cur = perToken.get(addr);
    if (!cur) {
      perToken.set(addr, { vol24 });
      continue;
    }
    perToken.set(addr, { vol24: Math.max(cur.vol24, vol24) });
  }

  let tradingVolume24hUsdc = 0;
  for (const { vol24 } of perToken.values()) {
    tradingVolume24hUsdc += vol24;
  }
  return { tradingVolume24hUsdc };
}

function parseLifetimeVolumeFromRows(
  rows: Array<Record<string, unknown>> | undefined,
): number | null {
  if (!rows?.length) return null;
  const row = rows[0];
  if (!row) return null;

  for (const key of [
    "lifetime_volume_usd",
    "lifetime_volume_usdc",
    "lifetime_volume",
    "volume_usd",
    "volume",
  ]) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
  }

  const firstNumeric = Object.values(row).find(
    (v) =>
      (typeof v === "number" && Number.isFinite(v)) ||
      (typeof v === "string" && Number.isFinite(Number(v))),
  );
  if (firstNumeric == null) return null;
  return typeof firstNumeric === "number" ? firstNumeric : Number(firstNumeric);
}

/**
 * Reads the latest result of your saved Dune query — does NOT execute SQL.
 * Re-run the query on dune.com/freeksh00w/basemate when you want fresh data.
 * @see https://docs.dune.com/api-reference/executions/endpoint/get-query-result
 */
async function readDuneLatestLifetimeVolumeUsdc(): Promise<number> {
  const res = await fetch(
    `https://api.dune.com/api/v1/query/${DUNE_BANKR_QUERY_ID}/results`,
    {
      headers: { "X-Dune-Api-Key": DUNE_API_KEY },
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `No saved Dune results for query ${DUNE_BANKR_QUERY_ID} — run it once on dune.com/queries/${DUNE_BANKR_QUERY_ID}`,
      );
    }
    throw new Error(`Dune read failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    state?: string;
    result?: { rows?: Array<Record<string, unknown>> };
  };

  if (data.state && data.state !== "QUERY_STATE_COMPLETED") {
    throw new Error(`Dune query not ready: ${data.state}`);
  }

  const volume = parseLifetimeVolumeFromRows(data.result?.rows);
  if (volume == null) throw new Error("Dune result missing lifetime volume column");
  return volume;
}

/**
 * Bankr lifetime secondary-market volume via cached GET of latest Dune result.
 */
export async function getBankrLifetimeVolumeUsdc(): Promise<number> {
  if (!DUNE_API_KEY) return 0;
  if (lifetimeCache && Date.now() - lifetimeCache.fetchedAt < LIFETIME_READ_CACHE_MS) {
    return lifetimeCache.value;
  }

  const volume = await readDuneLatestLifetimeVolumeUsdc();
  lifetimeCache = { value: volume, fetchedAt: Date.now() };
  return volume;
}

async function fetchDexStatsForTokens(addresses: string[]): Promise<{ tradingVolume24hUsdc: number }> {
  if (addresses.length === 0) return { tradingVolume24hUsdc: 0 };

  const allPairs: DexPair[] = [];
  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const batch = addresses.slice(i, i + BATCH_SIZE).join(",");
    const url = `https://api.dexscreener.com/tokens/v1/base/${batch}`;
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as DexPair[] | DexPair;
      const pairs = Array.isArray(data) ? data : [data];
      allPairs.push(...pairs);
    } catch {
      // DexScreener is best-effort; keep partial totals.
    }
  }
  return aggregatePairs(allPairs);
}

export async function getBankrLaunchedTokenMarketStats(): Promise<BankrMarketStats> {
  if (cachedStats && Date.now() - cachedStats.fetchedAt < CACHE_MS) {
    return cachedStats.value;
  }

  const { rows } = await db.query<{ token_address: string }>(
    `SELECT DISTINCT LOWER(token_address) AS token_address
     FROM token_launch_log
     WHERE status = 'success' AND token_address IS NOT NULL`,
  );
  const addresses = rows.map((r) => r.token_address).filter(Boolean);
  const [dex, lifetime] = await Promise.all([
    fetchDexStatsForTokens(addresses),
    getBankrLifetimeVolumeUsdc().catch(() => lifetimeCache?.value ?? 0),
  ]);
  const stats: BankrMarketStats = {
    tradingVolume24hUsdc: dex.tradingVolume24hUsdc,
    tradingVolumeLifetimeUsdc: lifetime,
  };
  cachedStats = { value: stats, fetchedAt: Date.now() };
  return stats;
}

/** @deprecated Use getBankrLaunchedTokenMarketStats */
export async function getBankrLaunchedTokenTradingVolume24h(): Promise<number> {
  const stats = await getBankrLaunchedTokenMarketStats();
  return stats.tradingVolume24hUsdc;
}
