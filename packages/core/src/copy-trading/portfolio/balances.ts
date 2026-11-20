import { createPublicClient, formatUnits, http, type Address } from "viem";
import { base } from "viem/chains";

import { fetchBasePortfolioHoldings, type PortfolioHolding } from "@/portfolio-reviews/index.js";
import { fetchCoinGeckoQuote } from "@/price-alerts/providers/coingecko.js";
import { fetchDexScreenerMarkets } from "@/price-alerts/providers/dexscreener.js";
import { logger } from "@/utils/logger.js";
import { getBalances, isCdpEnabled, type TokenBalance } from "@/wallet/cdp.js";

import { copyTradingConfig } from "../config.js";
import { decodeTokenAmount } from "./amounts.js";

/**
 * Broadened balance discovery for tracked traders. The base portfolio engine
 * (`fetchBasePortfolioHoldings`) only scans a curated ~10-token list on Base,
 * which is fine for known users but too narrow for arbitrary leader wallets that
 * may hold long-tail tokens. When an Alchemy key is configured we additionally
 * enumerate all ERC-20 balances and price the unknown ones via DexScreener so
 * copy sizing and Trader Profiles reflect the full portfolio.
 */

interface AlchemyTokenBalance {
  contractAddress: string;
  tokenBalance: string | null;
}

interface AlchemyTokenMetadata {
  decimals?: number | string;
  name?: string;
  symbol?: string;
}

const ALCHEMY_BASE_URL = "https://base-mainnet.g.alchemy.com/v2";
const NATIVE_ETH_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const tokenClient = createPublicClient({
  chain: base,
  transport: http(copyTradingConfig.baseRpcUrl),
});

const ERC20_DECIMALS_ABI = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

async function alchemyRpc<T>(
  method: string,
  params: unknown[],
): Promise<T | null> {
  if (!copyTradingConfig.alchemyApiKey) return null;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(`${ALCHEMY_BASE_URL}/${copyTradingConfig.alchemyApiKey}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { result?: T; error?: { message?: string } };
      if (json.error) throw new Error(json.error.message ?? "Alchemy JSON-RPC error");
      if (json.result == null) throw new Error("Alchemy response did not include a result");
      return json.result;
    } catch (err) {
      lastError = err;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 200));
      }
    }
  }
  logger.warn(`copy-trading: alchemy ${method} failed: ${(lastError as Error)?.message}`);
  return null;
}

function parseDecimals(value: unknown): number | null {
  const decimals = Number(value);
  return Number.isInteger(decimals) && decimals > 0 && decimals <= 36 ? decimals : null;
}

/** Prefer on-chain ERC-20 decimals; fall back to Alchemy metadata, then 18. */
async function fetchDecimals(address: string): Promise<number> {
  try {
    const onchain = await tokenClient.readContract({
      address: address as Address,
      abi: ERC20_DECIMALS_ABI,
      functionName: "decimals",
    });
    const decimals = parseDecimals(onchain);
    if (decimals != null) return decimals;
  } catch {
    // Some unusual tokens may not expose decimals(); metadata is the fallback.
  }

  const meta = await alchemyRpc<AlchemyTokenMetadata>("alchemy_getTokenMetadata", [address]);
  return parseDecimals(meta?.decimals) ?? 18;
}

function riskFromLiquidity(liquidityUsd: number | null): PortfolioHolding["risk"] {
  if (liquidityUsd == null) return "high";
  if (liquidityUsd >= 1_000_000) return "medium";
  return "high";
}

/**
 * Enumerate the embedded wallet through CDP, then price every ERC-20 through
 * DexScreener and native ETH through CoinGecko. A null result means CDP was
 * unavailable and callers should use the RPC/Alchemy fallback.
 */
async function discoverCdpWalletHoldings(
  wallet: string,
  minValueUsd: number,
): Promise<PortfolioHolding[] | null> {
  if (!isCdpEnabled()) return null;

  let balances: TokenBalance[];
  try {
    balances = await getBalances(wallet);
  } catch (error) {
    logger.warn(
      `portfolio: CDP balance enumeration failed, using RPC fallback: ${(error as Error)?.message}`,
    );
    return null;
  }

  const nonZero = balances.filter((balance) => balance.amount > 0n);
  const native = nonZero.find(
    (balance) => balance.contractAddress.toLowerCase() === NATIVE_ETH_ADDRESS,
  );
  const erc20 = nonZero.filter(
    (balance) => balance.contractAddress.toLowerCase() !== NATIVE_ETH_ADDRESS,
  );
  const [dexMarkets, ethQuote] = await Promise.all([
    fetchDexScreenerMarkets(erc20.map((balance) => balance.contractAddress)),
    native ? fetchCoinGeckoQuote("ethereum") : Promise.resolve(null),
  ]);

  const holdings: PortfolioHolding[] = [];
  if (native) {
    const amount = Number(formatUnits(native.amount, native.decimals));
    if (Number.isFinite(amount) && amount > 0) {
      const priceUsd = ethQuote?.priceUsd ?? null;
      holdings.push({
        symbol: "ETH",
        name: "Ethereum",
        tokenAddress: null,
        amount: native.formatted,
        decimals: native.decimals,
        priceUsd,
        valueUsd: priceUsd == null ? 0 : amount * priceUsd,
        change24hPct: null,
        risk: "low",
      });
    }
  }

  for (const balance of erc20) {
    const address = balance.contractAddress.toLowerCase();
    const dex = dexMarkets.get(address);
    // DexScreener-less balances are generally spam airdrops and cannot
    // contribute to a USD total, so do not expose them on portfolio surfaces.
    if (!dex || dex.priceUsd == null) continue;
    const { amount, decimals } = decodeTokenAmount(balance.amount, balance.decimals, dex);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const valueUsd = amount * dex.priceUsd;
    if (valueUsd < minValueUsd) continue;
    holdings.push({
      symbol: dex.symbol || balance.symbol,
      name: dex.name,
      tokenAddress: address,
      amount: String(amount),
      decimals,
      priceUsd: dex.priceUsd,
      valueUsd,
      change24hPct: dex.change24hPct,
      risk: riskFromLiquidity(dex.liquidityUsd),
    });
  }

  return holdings.sort((a, b) => b.valueUsd - a.valueUsd);
}

async function discoverLongTailHoldings(
  wallet: string,
  known: Set<string>,
  minValueUsd: number,
): Promise<PortfolioHolding[]> {
  const result = await alchemyRpc<{ tokenBalances: AlchemyTokenBalance[] }>(
    "alchemy_getTokenBalances",
    [wallet, "erc20"],
  );
  if (!result?.tokenBalances) return [];

  // Bound the work: only enrich the first ~40 non-zero unknown tokens.
  const candidates = result.tokenBalances
    .filter((b) => b.tokenBalance && BigInt(b.tokenBalance) > 0n)
    .filter((b) => !known.has(b.contractAddress.toLowerCase()))
    .slice(0, 40);
  const dexMarkets = await fetchDexScreenerMarkets(
    candidates.map((candidate) => candidate.contractAddress),
  );

  async function enrich(bal: AlchemyTokenBalance): Promise<PortfolioHolding | null> {
    const address = bal.contractAddress.toLowerCase();
    const dex = dexMarkets.get(address) ?? null;
    // Unpriced long-tail balances are commonly spam airdrops. Keep curated
    // assets visible when unpriced, but require a real market for discovered
    // tokens so the balance response is not flooded with junk.
    if (!dex || dex.priceUsd == null) return null;
    const raw = BigInt(bal.tokenBalance ?? "0");
    const decoded = decodeTokenAmount(raw, await fetchDecimals(address), dex);
    const { amount, decimals } = decoded;
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const valueUsd = amount * dex.priceUsd;
    if (valueUsd < minValueUsd) return null;
    return {
      symbol: dex.symbol,
      name: dex.name,
      tokenAddress: address,
      amount: String(amount),
      decimals,
      priceUsd: dex.priceUsd,
      valueUsd,
      change24hPct: dex.change24hPct,
      risk: riskFromLiquidity(dex.liquidityUsd),
    };
  }

  // Enrich candidates in parallel with a modest concurrency cap so a wallet with
  // many dust tokens doesn't serialize ~40 DexScreener + RPC round-trips (the
  // dominant source of portfolio load latency), while staying under rate limits.
  const CONCURRENCY = 10;
  const out: PortfolioHolding[] = [];
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const chunk = candidates.slice(i, i + CONCURRENCY);
    const enriched = await Promise.all(chunk.map(enrich));
    for (const holding of enriched) {
      if (holding) out.push(holding);
    }
  }
  return out;
}

/**
 * Full portfolio holdings for a tracked trader: curated tokens (always) plus
 * long-tail discovery (when Alchemy is configured). Sorted by USD value.
 *
 * `minValueUsd` defaults to the copy-trade execution floor for copy sizing, but
 * display surfaces can lower it to show tiny wallet balances.
 */
export async function fetchTraderHoldings(
  wallet: string,
  opts: { minValueUsd?: number } = {},
): Promise<PortfolioHolding[]> {
  const curated = await fetchBasePortfolioHoldings(wallet);
  const known = new Set(
    curated.map((h) => (h.tokenAddress ? h.tokenAddress.toLowerCase() : h.symbol.toLowerCase())),
  );
  const longTail = await discoverLongTailHoldings(
    wallet,
    known,
    opts.minValueUsd ?? copyTradingConfig.copyTradeFloorUsd,
  );
  return [...curated, ...longTail].sort((a, b) => b.valueUsd - a.valueUsd);
}

/**
 * Full embedded-wallet portfolio. CDP provides paginated balance discovery for
 * every asset in the wallet; RPC/Alchemy remains a resilience fallback.
 */
export async function fetchWalletHoldings(
  wallet: string,
  opts: { minValueUsd?: number } = {},
): Promise<PortfolioHolding[]> {
  const minValueUsd = opts.minValueUsd ?? copyTradingConfig.copyTradeFloorUsd;
  const [cdpResult, rpcResult] = await Promise.allSettled([
    discoverCdpWalletHoldings(wallet, minValueUsd),
    fetchTraderHoldings(wallet, { minValueUsd }),
  ]);
  const cdpHoldings = cdpResult.status === "fulfilled" ? cdpResult.value : null;
  const rpcHoldings = rpcResult.status === "fulfilled" ? rpcResult.value : null;
  if (cdpHoldings === null && rpcHoldings === null) {
    throw rpcResult.status === "rejected"
      ? rpcResult.reason
      : cdpResult.status === "rejected"
        ? cdpResult.reason
        : new Error("No wallet balance provider is available");
  }
  if (cdpHoldings === null) return rpcHoldings ?? [];
  if (rpcHoldings === null) return cdpHoldings;

  // CDP provides broad token discovery, while direct RPC reads are fresher for
  // curated assets. Merge both and prefer RPC values when the same asset occurs.
  const merged = new Map<string, PortfolioHolding>();
  for (const holding of cdpHoldings) {
    merged.set(holding.tokenAddress?.toLowerCase() ?? "eth", holding);
  }
  for (const holding of rpcHoldings) {
    merged.set(holding.tokenAddress?.toLowerCase() ?? "eth", holding);
  }
  return [...merged.values()].sort((a, b) => b.valueUsd - a.valueUsd);
}

export function totalHoldingsUsd(holdings: PortfolioHolding[]): number {
  return holdings.reduce((sum, h) => sum + (Number.isFinite(h.valueUsd) ? h.valueUsd : 0), 0);
}
