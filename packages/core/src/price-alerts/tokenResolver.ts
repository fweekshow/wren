import {
  fetchCoinGeckoQuote,
  matchMainstreamCoin,
} from "./providers/coingecko.js";
import {
  fetchDexScreenerByAddress,
  searchDexScreenerBySymbol,
} from "./providers/dexscreener.js";
import type { TokenQuote, TokenResolution } from "./types.js";

type FetchLike = typeof fetch;

export interface ResolveOptions {
  fetchFn?: FetchLike;
}

const CONTRACT_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Resolve a user-supplied token reference into a concrete priced token.
 *
 * Rules (per task spec):
 *  - A contract address → DexScreener (works for any Base/long-tail token).
 *  - A mainstream symbol → CoinGecko.
 *  - Any other symbol → DexScreener search. If the symbol maps to more than one
 *    contract, return `ambiguous` so the caller can ask for the address.
 */
export async function resolveAlertToken(
  query: string,
  contractAddress: string | null,
  options: ResolveOptions = {},
): Promise<TokenResolution> {
  const address = contractAddress ?? (CONTRACT_RE.test(query.trim()) ? query.trim() : null);

  if (address) {
    const resolved = await fetchDexScreenerByAddress(address, options);
    if (!resolved) return { kind: "not_found" };
    return { kind: "resolved", token: resolved.token, quote: resolved.quote };
  }

  const symbol = query.trim().replace(/^\$+/, "");
  if (!symbol) return { kind: "not_found" };

  // Mainstream coins (by ticker OR full name) always price via CoinGecko, so a
  // request for "Bitcoin" never falls through to look-alike DexScreener tokens.
  const mainstream = matchMainstreamCoin(symbol);
  if (mainstream) {
    const quote = await fetchCoinGeckoQuote(mainstream.id, options);
    const token = {
      source: "coingecko" as const,
      tokenId: mainstream.id,
      tokenAddress: null,
      chainId: null,
      symbol: mainstream.symbol,
      name: null,
    };
    if (!quote) return { kind: "unpriced", token };
    return { kind: "resolved", token, quote };
  }

  const candidates = await searchDexScreenerBySymbol(symbol, options);
  if (candidates.length === 0) return { kind: "not_found" };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };

  const only = candidates[0];
  if (!only.tokenAddress) return { kind: "not_found" };
  const resolved = await fetchDexScreenerByAddress(only.tokenAddress, options);
  if (!resolved) {
    return {
      kind: "resolved",
      token: only,
      quote: { priceUsd: null, marketCapUsd: null },
    };
  }
  return { kind: "resolved", token: resolved.token, quote: resolved.quote };
}

/** Re-price an already-resolved token (used by the poller). */
export async function fetchQuoteForToken(
  token: { source: "coingecko" | "dexscreener"; tokenId: string | null; tokenAddress: string | null },
  options: ResolveOptions = {},
): Promise<TokenQuote | null> {
  if (token.source === "coingecko" && token.tokenId) {
    return fetchCoinGeckoQuote(token.tokenId, options);
  }
  if (token.source === "dexscreener" && token.tokenAddress) {
    const resolved = await fetchDexScreenerByAddress(token.tokenAddress, options);
    return resolved?.quote ?? null;
  }
  return null;
}
