import type { TokenQuote } from "../types.js";

type FetchLike = typeof fetch;

export interface MainstreamCoin {
  /** CoinGecko coin id. */
  id: string;
  /** Canonical ticker used for display + storage. */
  symbol: string;
  /** Lowercased full-name aliases so "Bitcoin"/"bitcoin cash" resolve too. */
  names: string[];
}

/**
 * Curated list of the mainstream coins we always price through CoinGecko — even
 * when someone types the full name (e.g. "track Bitcoin"). This is what stops
 * look-alike L2 / wrapped tokens on DexScreener from hijacking a request for a
 * household-name coin. Anything outside this list (and the extended symbol map
 * below) goes to DexScreener, or the user can force a token by contract address.
 */
export const MAINSTREAM_COINS: MainstreamCoin[] = [
  { id: "bitcoin", symbol: "BTC", names: ["bitcoin"] },
  { id: "ethereum", symbol: "ETH", names: ["ethereum", "ether"] },
  { id: "tether", symbol: "USDT", names: ["tether"] },
  { id: "binancecoin", symbol: "BNB", names: ["bnb", "binance coin"] },
  { id: "solana", symbol: "SOL", names: ["solana"] },
  { id: "usd-coin", symbol: "USDC", names: ["usd coin", "usdc"] },
  { id: "ripple", symbol: "XRP", names: ["ripple", "xrp"] },
  { id: "dogecoin", symbol: "DOGE", names: ["dogecoin", "doge"] },
  { id: "cardano", symbol: "ADA", names: ["cardano"] },
  { id: "tron", symbol: "TRX", names: ["tron"] },
  { id: "avalanche-2", symbol: "AVAX", names: ["avalanche"] },
  { id: "chainlink", symbol: "LINK", names: ["chainlink"] },
  { id: "polkadot", symbol: "DOT", names: ["polkadot"] },
  { id: "the-open-network", symbol: "TON", names: ["toncoin", "the open network"] },
  { id: "shiba-inu", symbol: "SHIB", names: ["shiba inu", "shiba"] },
  { id: "litecoin", symbol: "LTC", names: ["litecoin"] },
  { id: "bitcoin-cash", symbol: "BCH", names: ["bitcoin cash"] },
  { id: "stellar", symbol: "XLM", names: ["stellar", "stellar lumens"] },
  { id: "uniswap", symbol: "UNI", names: ["uniswap"] },
  { id: "polygon-ecosystem-token", symbol: "POL", names: ["polygon", "matic"] },
];

/**
 * Extended ticker → CoinGecko id map. Covers the curated mainstream coins plus
 * additional well-known symbols we still trust to CoinGecko when referenced by
 * ticker (not by full name).
 */
export const COINGECKO_IDS: Record<string, string> = {
  ...Object.fromEntries(MAINSTREAM_COINS.map((c) => [c.symbol, c.id])),
  WBTC: "wrapped-bitcoin",
  WETH: "weth",
  STETH: "staked-ether",
  MATIC: "matic-network",
  ATOM: "cosmos",
  AAVE: "aave",
  ARB: "arbitrum",
  OP: "optimism",
  SUI: "sui",
  APT: "aptos",
  NEAR: "near",
  FIL: "filecoin",
  HBAR: "hedera-hashgraph",
  ICP: "internet-computer",
  ETC: "ethereum-classic",
  DAI: "dai",
  PEPE: "pepe",
  CRO: "crypto-com-chain",
  MKR: "maker",
  TIA: "celestia",
  RNDR: "render-token",
  INJ: "injective-protocol",
  SEI: "sei-network",
};

const NAME_TO_COIN: Record<string, { id: string; symbol: string }> = (() => {
  const map: Record<string, { id: string; symbol: string }> = {};
  for (const coin of MAINSTREAM_COINS) {
    for (const name of coin.names) {
      map[name.toLowerCase()] = { id: coin.id, symbol: coin.symbol };
    }
  }
  return map;
})();

export interface MainstreamMatch {
  id: string;
  symbol: string;
}

/**
 * Match a user query to a CoinGecko coin by ticker OR full name. Name matching
 * is exact (case-insensitive) so "bitcoin" maps to BTC while "basedbitcoin"
 * does not. Returns null for anything that should fall through to DexScreener.
 */
export function matchMainstreamCoin(query: string): MainstreamMatch | null {
  const cleaned = query.trim().replace(/^\$+/, "").trim();
  if (!cleaned) return null;

  const bySymbol = COINGECKO_IDS[cleaned.toUpperCase()];
  if (bySymbol) return { id: bySymbol, symbol: cleaned.toUpperCase() };

  const byName = NAME_TO_COIN[cleaned.toLowerCase()];
  if (byName) return byName;

  return null;
}

/** Symbols we will price through CoinGecko. */
export function coingeckoIdForSymbol(symbol: string): string | null {
  const clean = symbol.trim().replace(/^\$+/, "").toUpperCase();
  return COINGECKO_IDS[clean] ?? null;
}

export function isMainstreamSymbol(symbol: string): boolean {
  return matchMainstreamCoin(symbol) !== null;
}

function apiBase(): string {
  return process.env.COINGECKO_API_KEY
    ? "https://pro-api.coingecko.com/api/v3"
    : "https://api.coingecko.com/api/v3";
}

function apiHeaders(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY;
  return key ? { "x-cg-pro-api-key": key } : {};
}

/**
 * Fetch current USD price + market cap for a CoinGecko coin id via
 * `/simple/price?include_market_cap=true`.
 */
export async function fetchCoinGeckoQuote(
  coinId: string,
  options: { fetchFn?: FetchLike; timeoutMs?: number } = {},
): Promise<TokenQuote | null> {
  const fetchFn = options.fetchFn ?? fetch;
  const url =
    `${apiBase()}/simple/price?ids=${encodeURIComponent(coinId)}` +
    `&vs_currencies=usd&include_market_cap=true`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetchFn(url, {
        headers: apiHeaders(),
        signal: AbortSignal.timeout(options.timeoutMs ?? 6000),
      });
      if (!res.ok) {
        if (res.status !== 429 && res.status < 500) return null;
        throw new Error(`CoinGecko HTTP ${res.status}`);
      }
      const json = (await res.json()) as Record<
        string,
        { usd?: number; usd_market_cap?: number }
      >;
      const entry = json[coinId];
      if (!entry || typeof entry.usd !== "number") return null;
      return {
        priceUsd: entry.usd,
        marketCapUsd:
          typeof entry.usd_market_cap === "number" ? entry.usd_market_cap : null,
      };
    } catch {
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
  }
  return null;
}
