/**
 * Token registry, symbol resolution, and price lookups for the DiscoveryAI.
 * Extracted from discovery/ai.ts; re-exported from that module for callers.
 */

import { createPublicClient, http, isAddress, type Address } from "viem";
import { base } from "viem/chains";

import { listStockTokens, resolveStockToken } from "@/discovery/doppler/stockRegistry.js";

// ─── Token registry on Base mainnet (chainId 8453) ────────────────────────────
// Curated from Uniswap default-token-list + Bankr/Base community tokens.
// resolveToken() falls back to DexScreener live lookup for anything not listed here.

export const BASE_TOKENS: Record<string, { address: string; decimals: number; symbol: string }> = {
  // Core / native
  ETH:      { address: "ETH",                                              decimals: 18, symbol: "ETH" },
  WETH:     { address: "0x4200000000000000000000000000000000000006",       decimals: 18, symbol: "WETH" },
  USDC:     { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",       decimals: 6,  symbol: "USDC" },
  USDT:     { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",       decimals: 6,  symbol: "USDT" },
  DAI:      { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",       decimals: 18, symbol: "DAI" },
  USDBC:    { address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",       decimals: 6,  symbol: "USDbC" },
  EURC:     { address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",       decimals: 6,  symbol: "EURC" },
  MXNB:     { address: "0xf197ffc28c23e0309b5559e7a166f2c6164c80aa",       decimals: 6,  symbol: "MXNB" },
  // Local-currency corridor stables on Base (phone-number remittance routing)
  BRZ:      { address: "0xE9185Ee218cae427aF7B9764A011bb89FeA761B4",       decimals: 18, symbol: "BRZ" },
  ZARP:     { address: "0xb755506531786C8aC63B756BaB1ac387bACB0C04",       decimals: 18, symbol: "ZARP" },
  XSGD:     { address: "0x0A4C9cb2778aB3302996A34BeFCF9a8Bc288C33b",       decimals: 6,  symbol: "XSGD" },
  IDRX:     { address: "0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22",       decimals: 2,  symbol: "IDRX" },
  MYRC:     { address: "0x3eD03E95DD894235090B3d4A49E0C3239EDcE59e",       decimals: 18, symbol: "MYRC" },
  AUDD:     { address: "0x449B3317a6d1efb1Bc3ba0700C9EaA4FFFf4Ae65",       decimals: 6,  symbol: "AUDD" },
  TGBP:     { address: "0x27f6c8289550fce67f6b50bed1f519966afe5287",       decimals: 18, symbol: "TGBP" },
  // AllUnity CHF on Base (ticker CHFAU on-chain; corridor map uses VCHF)
  VCHF:     { address: "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78",       decimals: 6,  symbol: "VCHF" },
  CHFAU:    { address: "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78",       decimals: 6,  symbol: "CHFAU" },
  SEKAU:    { address: "0x0297B579B0CB603B5eE814EB7322b960D3ae7A66",       decimals: 6,  symbol: "SEKAU" },
  // Coinbase wrapped assets
  CBBTC:    { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",       decimals: 8,  symbol: "cbBTC" },
  CBETH:    { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",       decimals: 18, symbol: "cbETH" },
  CBDOGE:   { address: "0xcbD06E5A2B0C65597161de254AA074E489dEb510",       decimals: 8,  symbol: "cbDOGE" },
  CBXRP:    { address: "0xcb585250f852C6c6bf90434AB21A00f02833a4af",       decimals: 6,  symbol: "cbXRP" },
  CBLTC:    { address: "0xcb17C9Db87B595717C857a08468793f5bAb6445F",       decimals: 8,  symbol: "cbLTC" },
  // Base DeFi / infrastructure
  AERO:     { address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",       decimals: 18, symbol: "AERO" },
  WELL:     { address: "0xA88594D404727625A9437C3f886C7643872296AE",       decimals: 18, symbol: "WELL" },
  UNI:      { address: "0xc3De830EA07524a0761646a6a4e4be0e114a3C83",       decimals: 18, symbol: "UNI" },
  COMP:     { address: "0x9e1028F5F1D5eDE59748FFceE5532509976840E0",       decimals: 18, symbol: "COMP" },
  // Base culture / meme tokens
  BRETT:    { address: "0x532f27101965dd16442E59d40670FaF5eBB142E4",       decimals: 18, symbol: "BRETT" },
  TOSHI:    { address: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4",       decimals: 18, symbol: "TOSHI" },
  DEGEN:    { address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed",       decimals: 18, symbol: "DEGEN" },
  HIGHER:   { address: "0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe",       decimals: 18, symbol: "HIGHER" },
  DOGINME:  { address: "0x6921B130D297cc43754afba22e5EAc0FBf8Db75b",       decimals: 18, symbol: "doginme" },
  KEYCAT:   { address: "0x9a26F5433671751C3276a065f57e5a02D2817973",       decimals: 18, symbol: "KEYCAT" },
  SPX:      { address: "0x50dA645f148798F68EF2d7dB7C1CB22A6819bb2C",       decimals: 8,  symbol: "SPX" },
  // AI / Virtuals ecosystem
  VIRTUAL:  { address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",       decimals: 18, symbol: "VIRTUAL" },
  AIXBT:    { address: "0x4F9Fd6Be4a90f2620860d680c0d4d5Fb53d1A825",       decimals: 18, symbol: "AIXBT" },
  // Base ecosystem projects
  ZORA:     { address: "0x1111111111166b7FE7bd91427724B487980aFc69",       decimals: 18, symbol: "ZORA" },
  CLANKER:  { address: "0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb",       decimals: 18, symbol: "CLANKER" },
  BNKR:     { address: "0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b",       decimals: 18, symbol: "BNKR" },
  BASEMATE: { address: "0x07E61D8a4e197dfC269e90D7ECe1dF0D26702bA3",       decimals: 18, symbol: "BASEMATE" },
  HOME:     { address: "0x4BfAa776991E85e5f8b1255461cbbd216cFc714f",       decimals: 18, symbol: "HOME" },
  TOWNS:    { address: "0x00000000A22C618fd6b4D7E9A335C4B96B189a38",       decimals: 18, symbol: "TOWNS" },
  KAITO:    { address: "0x98d0baa52b2D063E780DE12F615f963Fe8537553",       decimals: 18, symbol: "KAITO" },
  VVV:      { address: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf",       decimals: 18, symbol: "VVV" },
  B3:       { address: "0xB3B32F9f8827D4634fE7d973Fa1034Ec9fdDB3B3",       decimals: 18, symbol: "B3" },
  RSR:      { address: "0xaB36452DbAC151bE02b16Ca17d8919826072f64a",       decimals: 18, symbol: "RSR" },
  ZRO:      { address: "0x6985884C4392D348587B19cb9eAAf157F13271cd",       decimals: 18, symbol: "ZRO" },
  // LSTs / LRTs (needed for Moonwell markets)
  WSTETH:   { address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",       decimals: 18, symbol: "wstETH" },
  RETH:     { address: "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c",       decimals: 18, symbol: "rETH" },
  WEETH:    { address: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A",       decimals: 18, symbol: "weETH" },
  WRSETH:   { address: "0xEDfa23602D0EC14714057867A78d01e94176BEA0",       decimals: 18, symbol: "wrsETH" },
  // BTC variants
  TBTC:     { address: "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b",       decimals: 18, symbol: "tBTC" },
  LBTC:     { address: "0xecAc9C5F704e954931349Da37F60E39f515c11c1",       decimals: 8,  symbol: "LBTC" },
  // Stablecoins
  USDS:     { address: "0x820C137D761430A8E5A3571D3e0Eb24b9C02Ad7E",       decimals: 18, symbol: "USDS" },
  // Governance / protocol tokens (needed for Moonwell markets)
  MORPHO:   { address: "0x58D97B57BB95320F9a05dC918Aef65434969c2B2",       decimals: 18, symbol: "MORPHO" },
  MAMO:     { address: "0x7300B37DfdfAb110d83290A29DfB31B1740219fE",       decimals: 18, symbol: "MAMO" },
};

/** User-facing names that differ from on-chain tickers (e.g. Bankr product → BNKR token). */
export const TOKEN_SYMBOL_ALIASES: Record<string, string> = {
  BANKR: "BNKR",
  STABLES: "USDC",
  STABLE: "USDC",
  DOLLARS: "USDC",
  DOLLAR: "USDC",
  BUCKS: "USDC",
  BUCK: "USDC",
  // AllUnity CHF on-chain ticker; corridor map uses VCHF.
  CHFAU: "VCHF",
};

export const AVANTIS_STOCK_SYMBOLS = new Set([
  "AAPL",
  "AMZN",
  "COIN",
  "GOOGL",
  "META",
  "MSFT",
  "NVDA",
  "TSLA",
]);

export const MAJOR_PRICE_ALIASES: Record<string, string> = {
  BITCOIN: "BTC",
  BTC: "BTC",
  CBTC: "BTC",
  CBBTC: "BTC",
  ETHEREUM: "ETH",
  ETHER: "ETH",
  ETH: "ETH",
  WETH: "ETH",
  SOLANA: "SOL",
  SOL: "SOL",
  DOGECOIN: "DOGE",
  DOGE: "DOGE",
  XRP: "XRP",
  LITECOIN: "LTC",
  LTC: "LTC",
};

export const PRICE_QUERY_STOP_WORDS = new Set([
  "A",
  "AN",
  "AT",
  "CURRENT",
  "FOR",
  "IS",
  "NOW",
  "OF",
  "ON",
  "PRICE",
  "STOCK",
  "THE",
  "TOKEN",
  "TODAY",
  "TRADING",
  "USD",
  "WORTH",
]);

/** Stablecoins where 1 token ≈ $1 — skip DexScreener price conversion for USD spends. */
export const STABLECOIN_ADDRESSES = new Set<string>([
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", // DAI
  "0x820c137d761430a8e5a3571d3e0eb24b9c02ad7e", // USDS (matches BASE_TOKENS)
  "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42", // EURC
  "0x9786c9d0f6c84f4dbdee67f00c8e7aacfcb4af11", // USDT
  "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", // USDT (alt Base)
  "0xf197ffc28c23e0309b5559e7a166f2c6164c80aa", // MXNB (Mexican peso stable — Aerodrome stable pool)
  "0xe9185ee218cae427af7b9764a011bb89fea761b4", // BRZ
  "0xb755506531786c8ac63b756bab1ac387bacb0c04", // ZARP
  "0x0a4c9cb2778ab3302996a34befcf9a8bc288c33b", // XSGD
  "0x18bc5bcc660cf2b9ce3cd51a404afe1a0cbd3c22", // IDRX
  "0x3ed03e95dd894235090b3d4a49e0c3239edce59e", // MYRC
  "0x449b3317a6d1efb1bc3ba0700c9eaa4ffff4ae65", // AUDD
  "0x27f6c8289550fce67f6b50bed1f519966afe5287", // TGBP
  "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78", // VCHF / CHFAU
  "0x0297b579b0cb603b5ee814eb7322b960d3ae7a66", // SEKAU
]);

export function isStablecoinAddress(address: string): boolean {
  return STABLECOIN_ADDRESSES.has(address.toLowerCase());
}

// ─── Dynamic token lookup cache (DexScreener fallback) ────────────────────────
const tokenLookupCache = new Map<string, { address: string; decimals: number; symbol: string } | null>();
const priceUsdCache = new Map<string, { price: number; fetchedAt: number }>();

/** Fetch a token's USD price from DexScreener. Caches for 60 s. Returns null on failure. */
export async function fetchTokenPriceUsd(address: string): Promise<number | null> {
  if (!address || address === "ETH") return null;
  const key = address.toLowerCase();
  const cached = priceUsdCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < 60_000) return cached.price;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const json = await res.json() as { pairs?: Array<{ chainId: string; priceUsd?: string }> };
    const pair = json.pairs?.find((p) => p.chainId === "base" && p.priceUsd);
    if (!pair?.priceUsd) return null;
    const price = parseFloat(pair.priceUsd);
    if (!Number.isFinite(price) || price <= 0) return null;
    priceUsdCache.set(key, { price, fetchedAt: Date.now() });
    return price;
  } catch {
    return null;
  }
}

export function extractPriceLookup(message: string): { asset: string; assetType?: "token" | "stock" } | null {
  const withoutMentions = message.trim().replace(/^(?:@\S+\s+)+/i, "").trim();
  const lower = withoutMentions.toLowerCase();
  if (/\b(liquidat\w*|liq\b)\b/.test(lower)) return null;
  if (!/\b(price|worth|trading at|how much is|what'?s .* at)\b/i.test(withoutMentions)) return null;

  const direct =
    /\b(?:price of|price for|how much is|what'?s|what is)\s+\$?([a-z0-9]{2,12}|0x[a-f0-9]{40})\b/i.exec(withoutMentions)?.[1] ??
    /\b\$([a-z][a-z0-9]{1,11})\b/i.exec(withoutMentions)?.[1] ??
    /\b([a-z][a-z0-9]{1,11})\s+(?:price|stock price|token price)\b/i.exec(withoutMentions)?.[1];

  let asset = direct?.trim();
  if (asset && !asset.startsWith("0x") && PRICE_QUERY_STOP_WORDS.has(asset.toUpperCase())) {
    asset = undefined;
  }
  if (!asset) {
    const candidates = withoutMentions
      .replace(/[?!.,]/g, " ")
      .split(/\s+/)
      .map((w) => w.replace(/^\$/, "").toUpperCase())
      .filter((w) => /^[A-Z0-9]{2,12}$/.test(w) && !PRICE_QUERY_STOP_WORDS.has(w));
    asset = candidates[0];
  }

  if (!asset) return null;
  const normalized = asset.startsWith("0x") ? asset : MAJOR_PRICE_ALIASES[asset.toUpperCase()] ?? asset.toUpperCase();
  return {
    asset: normalized,
    assetType: AVANTIS_STOCK_SYMBOLS.has(normalized) || /\bstock\b/i.test(withoutMentions) ? "stock" : undefined,
  };
}

async function lookupTokenOnDexScreener(symbol: string): Promise<{ address: string; decimals: number; symbol: string } | null> {
  const clean = symbol.trim().replace(/^\$+/, "");
  if (!clean) return null;
  const cacheKey = clean.toUpperCase();
  if (tokenLookupCache.has(cacheKey)) return tokenLookupCache.get(cacheKey)!;

  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(clean)}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`DexScreener ${res.status}`);
    const json = await res.json() as {
      pairs?: Array<{
        chainId: string;
        liquidity?: { usd?: number };
        baseToken: { address: string; symbol: string; decimals?: number };
      }>;
    };
    const candidates = (json.pairs ?? []).filter(
      (p) => p.chainId === "base" && p.baseToken.symbol.toUpperCase() === cacheKey,
    );
    if (candidates.length > 0) {
      // Curated registry wins over DexScreener — imposters often spoof tickers.
      const curated = BASE_TOKENS[cacheKey];
      if (curated?.address.startsWith("0x")) {
        const curatedLower = curated.address.toLowerCase();
        const curatedMatch = candidates.find(
          (p) => p.baseToken.address.toLowerCase() === curatedLower,
        );
        if (curatedMatch) {
          const token = { address: curated.address, decimals: curated.decimals, symbol: curated.symbol };
          tokenLookupCache.set(cacheKey, token);
          return token;
        }
      }
      // Pick the most-liquid pair to land on the canonical contract.
      candidates.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const best = candidates[0];
      const token = {
        address: best.baseToken.address,
        decimals: best.baseToken.decimals ?? 18,
        symbol: best.baseToken.symbol,
      };
      tokenLookupCache.set(cacheKey, token);
      return token;
    }
  } catch {
    // fall through
  }
  tokenLookupCache.set(cacheKey, null);
  return null;
}

function resolveB20Token(
  raw: string,
): { address: string; decimals: number; symbol: string } | null {
  const entry = resolveStockToken(raw);
  if (!entry) return null;
  return { address: entry.address, decimals: entry.decimals, symbol: entry.symbol };
}

/** True when `address` is a Coinbase B20 catalog token (8 decimals). */
export function isB20StockAddress(address: string): boolean {
  if (!address.startsWith("0x")) return false;
  const lower = address.toLowerCase();
  return listStockTokens().some((t) => t.address.toLowerCase() === lower);
}

export function resolveToken(symbol: string): { address: string; decimals: number; symbol: string } {
  const upper = symbol.trim().toUpperCase();
  const canonical = TOKEN_SYMBOL_ALIASES[upper] ?? upper;
  if (BASE_TOKENS[canonical]) return BASE_TOKENS[canonical];
  return resolveB20Token(symbol) ?? resolveB20Token(canonical)
    ?? { address: symbol, decimals: 18, symbol: symbol.toUpperCase() };
}

function resolveByRegistryAddress(
  address: string,
): { address: string; decimals: number; symbol: string } | null {
  const lower = address.toLowerCase();
  for (const entry of Object.values(BASE_TOKENS)) {
    if (entry.address.startsWith("0x") && entry.address.toLowerCase() === lower) {
      return entry;
    }
  }
  for (const entry of listStockTokens()) {
    if (entry.address.toLowerCase() === lower) {
      return { address: entry.address, decimals: entry.decimals, symbol: entry.symbol };
    }
  }
  return null;
}

const ERC20_METADATA_ABI = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

const tokenMetadataClient = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
});

async function resolveTokenAddressMetadata(
  address: string,
): Promise<{ address: string; decimals: number; symbol: string } | null> {
  if (!isAddress(address)) return null;
  try {
    const [decimals, symbol] = await Promise.all([
      tokenMetadataClient.readContract({
        address: address as Address,
        abi: ERC20_METADATA_ABI,
        functionName: "decimals",
      }),
      tokenMetadataClient.readContract({
        address: address as Address,
        abi: ERC20_METADATA_ABI,
        functionName: "symbol",
      }),
    ]);
    if (!symbol.trim() || decimals < 0 || decimals > 255) return null;
    return { address, decimals, symbol: symbol.trim() };
  } catch {
    return null;
  }
}

/**
 * Resolves a token symbol to address+decimals, falling back to DexScreener for unknowns.
 * Sets `resolved: false` when no on-chain match is found so callers can short-circuit
 * with a friendly message instead of passing garbage to swap encoders.
 */
export async function resolveTokenAsync(
  symbolOrAddress: string,
): Promise<{ address: string; decimals: number; symbol: string; resolved: boolean }> {
  if (/^0x/i.test(symbolOrAddress)) {
    const address = `0x${symbolOrAddress.slice(2)}`;
    const known = resolveByRegistryAddress(address);
    if (known) return { ...known, resolved: true };
    const onchain = await resolveTokenAddressMetadata(address);
    if (onchain) return { ...onchain, resolved: true };
    return {
      address,
      decimals: 18,
      symbol: address.slice(0, 8),
      resolved: false,
    };
  }
  const clean = symbolOrAddress.trim().replace(/^\$+/, "");
  const upper = clean.toUpperCase();
  const canonical = TOKEN_SYMBOL_ALIASES[upper] ?? upper;
  if (BASE_TOKENS[canonical]) return { ...BASE_TOKENS[canonical], resolved: true };
  const b20 = resolveB20Token(clean) ?? resolveB20Token(canonical);
  if (b20) return { ...b20, resolved: true };
  const live = await lookupTokenOnDexScreener(canonical);
  if (live) return { ...live, resolved: true };
  return { address: symbolOrAddress, decimals: 18, symbol: upper || symbolOrAddress, resolved: false };
}
