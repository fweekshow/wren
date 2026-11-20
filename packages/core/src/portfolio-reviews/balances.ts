import { createPublicClient, formatUnits, http, type Address } from "viem";
import { base } from "viem/chains";

import { fetchCoinGeckoQuote } from "@/price-alerts/providers/coingecko.js";
import {
  fetchDexScreenerMarket,
  fetchDexScreenerMarkets,
  type DexScreenerMarket,
} from "@/price-alerts/providers/dexscreener.js";
import { resolveBaseRpcUrl } from "@/chain/base-rpc.js";

export type PortfolioRiskLevel = "low" | "medium" | "high";

export interface PortfolioHolding {
  symbol: string;
  name: string | null;
  tokenAddress: string | null;
  amount: string;
  decimals: number;
  priceUsd: number | null;
  valueUsd: number;
  change24hPct: number | null;
  risk: PortfolioRiskLevel;
}

interface KnownToken {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  stable?: boolean;
}

const NATIVE_ETH: PortfolioHolding = {
  symbol: "ETH",
  name: "Ethereum",
  tokenAddress: null,
  amount: "0",
  decimals: 18,
  priceUsd: null,
  valueUsd: 0,
  change24hPct: null,
  risk: "low",
};

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const BASE_WETH_ADDRESS = "0x4200000000000000000000000000000000000006";

const KNOWN_BASE_TOKENS: KnownToken[] = [
  {
    symbol: "USDC",
    name: "USD Coin",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    stable: true,
  },
  {
    symbol: "WETH",
    name: "Wrapped Ether",
    address: BASE_WETH_ADDRESS,
    decimals: 18,
  },
  {
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    decimals: 8,
  },
  {
    symbol: "AERO",
    name: "Aerodrome",
    address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
    decimals: 18,
  },
  {
    symbol: "VIRTUAL",
    name: "Virtuals Protocol",
    address: "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b",
    decimals: 18,
  },
  {
    symbol: "DEGEN",
    name: "Degen",
    address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed",
    decimals: 18,
  },
  {
    symbol: "MORPHO",
    name: "Morpho",
    address: "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842",
    decimals: 18,
  },
  {
    symbol: "WELL",
    name: "Moonwell",
    address: "0xA88594D404727625A9437C3f886C7643872296AE",
    decimals: 18,
  },
  {
    symbol: "BRETT",
    name: "Brett",
    address: "0x532f27101965dd16442E59d40670FaF5eBB142E4",
    decimals: 18,
  },
  {
    symbol: "BASEMATE",
    name: "Basemate",
    address: "0x07E61D8a4e197dfC269e90D7ECe1dF0D26702bA3",
    decimals: 18,
  },
];


const client = createPublicClient({
  chain: base,
  transport: http(resolveBaseRpcUrl()),
});

const BALANCE_RPC_ATTEMPTS = 3;
const BALANCE_RPC_RETRY_DELAY_MS = 200;

export async function retryPortfolioRpc<T>(
  operation: () => Promise<T>,
  attempts = BALANCE_RPC_ATTEMPTS,
  retryDelayMs = BALANCE_RPC_RETRY_DELAY_MS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  }
  throw lastError;
}

function toNumberAmount(amount: bigint, decimals: number): number {
  const parsed = Number(formatUnits(amount, decimals));
  return Number.isFinite(parsed) ? parsed : 0;
}

function riskFor(args: {
  stable?: boolean;
  symbol: string;
  valueUsd: number;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  change24hPct: number | null;
}): PortfolioRiskLevel {
  const symbol = args.symbol.toUpperCase();
  if (args.stable || ["ETH", "WETH", "BTC", "CBBTC", "USDC"].includes(symbol)) {
    return "low";
  }
  const liquidity = args.liquidityUsd ?? 0;
  const marketCap = args.marketCapUsd ?? 0;
  const absChange = Math.abs(args.change24hPct ?? 0);
  if (liquidity >= 1_000_000 && marketCap >= 50_000_000 && absChange < 25) {
    return "medium";
  }
  if (args.valueUsd < 5 && liquidity >= 250_000) {
    return "medium";
  }
  return "high";
}

async function fetchDexMarket(address: string): Promise<{
  priceUsd: number | null;
  change24hPct: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
} | null> {
  return fetchDexScreenerMarket(address);
}

async function priceKnownToken(
  token: KnownToken,
  prefetchedDex?: Map<string, DexScreenerMarket>,
): Promise<{
  priceUsd: number | null;
  change24hPct: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
}> {
  const dex = prefetchedDex
    ? prefetchedDex.get(token.address.toLowerCase()) ?? null
    : await fetchDexMarket(token.address);
  if (dex?.priceUsd != null) return dex;
  return { priceUsd: null, change24hPct: null, liquidityUsd: null, marketCapUsd: null };
}

async function fetchNativeEthHolding(wallet: Address): Promise<PortfolioHolding | null> {
  const balance = await retryPortfolioRpc(() => client.getBalance({ address: wallet }));
  if (balance <= 0n) return null;
  const amount = toNumberAmount(balance, 18);
  if (amount <= 0) return null;
  const quote = await fetchCoinGeckoQuote("ethereum");
  const priceUsd = quote?.priceUsd ?? null;
  return {
    ...NATIVE_ETH,
    amount: formatUnits(balance, 18),
    priceUsd,
    valueUsd: priceUsd == null ? 0 : amount * priceUsd,
    change24hPct: null,
  };
}

async function holdingFromTokenBalance(
  balance: bigint,
  token: KnownToken,
  prefetchedDex?: Map<string, DexScreenerMarket>,
): Promise<PortfolioHolding | null> {
  if (balance <= 0n) return null;
  const amount = toNumberAmount(balance, token.decimals);
  if (amount <= 0) return null;
  const market = await priceKnownToken(token, prefetchedDex);
  const valueUsd = market.priceUsd == null ? 0 : amount * market.priceUsd;
  return {
    symbol: token.symbol,
    name: token.name,
    tokenAddress: token.address.toLowerCase(),
    amount: formatUnits(balance, token.decimals),
    decimals: token.decimals,
    priceUsd: market.priceUsd,
    valueUsd,
    change24hPct: market.change24hPct,
    risk: riskFor({
      stable: token.stable,
      symbol: token.symbol,
      valueUsd,
      liquidityUsd: market.liquidityUsd,
      marketCapUsd: market.marketCapUsd,
      change24hPct: market.change24hPct,
    }),
  };
}

export async function fetchBasePortfolioHoldings(walletAddress: string): Promise<PortfolioHolding[]> {
  const wallet = walletAddress as Address;
  const holdings: PortfolioHolding[] = [];
  const native = await fetchNativeEthHolding(wallet);
  if (native) holdings.push(native);

  // One multicall avoids bursting the RPC with parallel eth_call requests.
  // Retry individual failed contracts because one non-standard token must not
  // make every otherwise valid ERC-20 balance unavailable.
  const results = await retryPortfolioRpc(() =>
    client.multicall({
      allowFailure: true,
      contracts: KNOWN_BASE_TOKENS.map((token) => ({
        address: token.address,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf" as const,
        args: [wallet] as const,
      })),
    }),
  );

  const balances: Array<bigint | null> = results.map((result) =>
    result.status === "success" ? result.result : null,
  );
  for (let index = 0; index < balances.length; index += 1) {
    if (balances[index] !== null) continue;
    const token = KNOWN_BASE_TOKENS[index];
    try {
      balances[index] = await retryPortfolioRpc(() =>
        client.readContract({
          address: token.address,
          abi: ERC20_BALANCE_ABI,
          functionName: "balanceOf",
          args: [wallet],
        }),
      );
    } catch (error) {
      console.warn("portfolio: failed to read curated ERC-20 balance", {
        error,
        symbol: token.symbol,
        wallet: walletAddress,
      });
    }
  }

  if (balances.every((balance) => balance === null)) {
    throw new Error("Unable to verify ERC-20 balances from the Base RPC");
  }

  const pricedTokenAddresses = KNOWN_BASE_TOKENS.flatMap((token, index) =>
    (balances[index] ?? 0n) > 0n ? [token.address] : [],
  );
  const dexMarkets = await fetchDexScreenerMarkets(pricedTokenAddresses);
  const tokenHoldings = await Promise.all(
    KNOWN_BASE_TOKENS.map((token, index) =>
      balances[index] === null
        ? null
        : holdingFromTokenBalance(balances[index], token, dexMarkets),
    ),
  );
  for (const holding of tokenHoldings) {
    if (holding) holdings.push(holding);
  }

  return holdings.sort((a, b) => b.valueUsd - a.valueUsd);
}

/**
 * Fetches the raw ERC-20 balance for a wallet, returning a human-readable
 * float (e.g. 67.5 for 67.5 MXNB). Returns 0 on any error.
 */
export async function fetchErc20TokenBalance(
  tokenAddress: string,
  walletAddress: string,
  decimals: number,
): Promise<number> {
  try {
    const balance = await client.readContract({
      address: tokenAddress as Address,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [walletAddress as Address],
    });
    return toNumberAmount(balance, decimals);
  } catch {
    return 0;
  }
}
