import type { TokenCandidate, TokenQuote, ResolvedToken } from "../types.js";

type FetchLike = typeof fetch;

interface DexPair {
  chainId?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string | null;
  priceChange?: { h24?: number | null } | null;
  liquidity?: { usd?: number | null } | null;
  marketCap?: number | null;
  fdv?: number | null;
}

/** Richer market data for callers that need more than just a price. */
export interface DexScreenerMarket {
  symbol: string;
  name: string | null;
  priceUsd: number | null;
  change24hPct: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
}

const DEX_BATCH_SIZE = 30;

function liquidityOf(pair: DexPair): number {
  return pair.liquidity?.usd ?? 0;
}

function marketCapOf(pair: DexPair): number | null {
  if (typeof pair.marketCap === "number") return pair.marketCap;
  if (typeof pair.fdv === "number") return pair.fdv;
  return null;
}

/**
 * Resolve a token by contract address using DexScreener's token endpoint
 * (`/latest/dex/tokens/{address}`). Picks the most-liquid pair as canonical.
 */
export async function fetchDexScreenerByAddress(
  address: string,
  options: { fetchFn?: FetchLike; timeoutMs?: number } = {},
): Promise<{ token: ResolvedToken; quote: TokenQuote } | null> {
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const res = await fetchFn(
      `https://api.dexscreener.com/latest/dex/tokens/${address}`,
      { signal: AbortSignal.timeout(options.timeoutMs ?? 6000) },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { pairs?: DexPair[] };
    const pairs = json.pairs ?? [];
    const lower = address.toLowerCase();
    const matching = pairs.filter(
      (p) => p.baseToken?.address?.toLowerCase() === lower,
    );
    const pool = matching.length > 0 ? matching : pairs;
    if (pool.length === 0) return null;

    const best = pool.sort((a, b) => liquidityOf(b) - liquidityOf(a))[0];
    const base = best.baseToken ?? {};
    const priceUsd = best.priceUsd ? parseFloat(best.priceUsd) : null;

    return {
      token: {
        source: "dexscreener",
        tokenId: null,
        tokenAddress: base.address ?? address,
        chainId: best.chainId ?? null,
        symbol: (base.symbol ?? "").toUpperCase() || address.slice(0, 8),
        name: base.name ?? null,
      },
      quote: {
        priceUsd: priceUsd && Number.isFinite(priceUsd) ? priceUsd : null,
        marketCapUsd: marketCapOf(best),
      },
    };
  } catch {
    return null;
  }
}

/**
 * Search DexScreener for tokens whose base symbol matches `symbol`. Returns one
 * candidate per distinct contract address (deduped, sorted by liquidity) so the
 * caller can detect duplicate-symbol ambiguity and ask for a contract address.
 */
export async function searchDexScreenerBySymbol(
  symbol: string,
  options: { fetchFn?: FetchLike; timeoutMs?: number; limit?: number } = {},
): Promise<TokenCandidate[]> {
  const fetchFn = options.fetchFn ?? fetch;
  const clean = symbol.trim().replace(/^\$+/, "");
  if (!clean) return [];
  const upper = clean.toUpperCase();

  try {
    const res = await fetchFn(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(clean)}`,
      { signal: AbortSignal.timeout(options.timeoutMs ?? 5000) },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as { pairs?: DexPair[] };
    const pairs = json.pairs ?? [];

    const byAddress = new Map<string, TokenCandidate>();
    for (const pair of pairs) {
      const base = pair.baseToken;
      if (!base?.address || !base.symbol) continue;
      if (base.symbol.toUpperCase() !== upper) continue;

      const addrKey = base.address.toLowerCase();
      const liquidity = liquidityOf(pair);
      const existing = byAddress.get(addrKey);
      if (existing && (existing.liquidityUsd ?? 0) >= liquidity) continue;

      byAddress.set(addrKey, {
        source: "dexscreener",
        tokenId: null,
        tokenAddress: base.address,
        chainId: pair.chainId ?? null,
        symbol: base.symbol.toUpperCase(),
        name: base.name ?? null,
        liquidityUsd: liquidity,
      });
    }

    const candidates = [...byAddress.values()].sort(
      (a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0),
    );
    return candidates.slice(0, options.limit ?? 5);
  } catch {
    return [];
  }
}

/**
 * Fetch full market data for a token by contract address.
 * Picks the most-liquid Base pair. Used by portfolio-reviews and copy-trading
 * when change24hPct and liquidityUsd are needed in addition to price.
 */
export async function fetchDexScreenerMarket(
  address: string,
  options: { fetchFn?: FetchLike; timeoutMs?: number } = {},
): Promise<DexScreenerMarket | null> {
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const res = await fetchFn(
      `https://api.dexscreener.com/latest/dex/tokens/${address}`,
      { signal: AbortSignal.timeout(options.timeoutMs ?? 6000) },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { pairs?: DexPair[] };
    const lower = address.toLowerCase();
    const pairs = (json.pairs ?? []).filter((p) => p.chainId === "base");
    const matching = pairs.filter((p) => p.baseToken?.address?.toLowerCase() === lower);
    const pool = matching.length > 0 ? matching : pairs;
    if (pool.length === 0) return null;
    const best = pool.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const price = best.priceUsd ? Number(best.priceUsd) : NaN;
    return {
      symbol: best.baseToken?.symbol || address.slice(0, 8),
      name: best.baseToken?.name ?? null,
      priceUsd: Number.isFinite(price) && price > 0 ? price : null,
      change24hPct: typeof best.priceChange?.h24 === "number" ? best.priceChange.h24 : null,
      liquidityUsd: best.liquidity?.usd ?? null,
      marketCapUsd: marketCapOf(best),
    };
  } catch {
    return null;
  }
}

/**
 * Batch-price Base tokens using DexScreener's documented tokens v1 endpoint.
 * This avoids rate limiting caused by issuing one request per wallet token.
 */
export async function fetchDexScreenerMarkets(
  addresses: string[],
  options: { fetchFn?: FetchLike; timeoutMs?: number } = {},
): Promise<Map<string, DexScreenerMarket>> {
  const fetchFn = options.fetchFn ?? fetch;
  const unique = [...new Set(addresses.map((address) => address.toLowerCase()))];
  const markets = new Map<string, DexScreenerMarket>();

  for (let offset = 0; offset < unique.length; offset += DEX_BATCH_SIZE) {
    const chunk = unique.slice(offset, offset + DEX_BATCH_SIZE);
    let pairs: DexPair[] | null = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const res = await fetchFn(
          `https://api.dexscreener.com/tokens/v1/base/${chunk.join(",")}`,
          { signal: AbortSignal.timeout(options.timeoutMs ?? 8000) },
        );
        if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
        pairs = (await res.json()) as DexPair[];
        break;
      } catch {
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 250));
        }
      }
    }

    if (!pairs) continue;
    for (const address of chunk) {
      const matching = pairs.filter(
        (pair) => pair.baseToken?.address?.toLowerCase() === address,
      );
      if (matching.length === 0) continue;
      const best = matching.sort((a, b) => liquidityOf(b) - liquidityOf(a))[0];
      const price = best.priceUsd ? Number(best.priceUsd) : NaN;
      markets.set(address, {
        symbol: best.baseToken?.symbol || address.slice(0, 8),
        name: best.baseToken?.name ?? null,
        priceUsd: Number.isFinite(price) && price > 0 ? price : null,
        change24hPct:
          typeof best.priceChange?.h24 === "number" ? best.priceChange.h24 : null,
        liquidityUsd: best.liquidity?.usd ?? null,
        marketCapUsd: marketCapOf(best),
      });
    }
  }

  return markets;
}

/**
 * Convenience helper: fetch just the USD price for a token by contract address.
 * Returns null when the token is not found or the request fails.
 * Used by portfolio, portfolio-reviews, and copy-trading to avoid duplicating
 * the full DexScreener response-parsing logic.
 */
export async function fetchDexScreenerPriceUsd(
  address: string,
  options: { fetchFn?: FetchLike; timeoutMs?: number } = {},
): Promise<number | null> {
  const result = await fetchDexScreenerByAddress(address, options);
  return result?.quote.priceUsd ?? null;
}

/** Re-price a previously resolved DexScreener token (used by the poller). */
export async function fetchDexScreenerQuote(
  address: string,
  options: { fetchFn?: FetchLike; timeoutMs?: number } = {},
): Promise<TokenQuote | null> {
  const resolved = await fetchDexScreenerByAddress(address, options);
  return resolved?.quote ?? null;
}
