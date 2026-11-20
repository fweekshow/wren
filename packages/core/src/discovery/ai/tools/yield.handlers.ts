// ─── tools/yield.handlers.ts ─────────────────────────────────────────────────
// Yield-protocol tool handlers extracted from toolbox.ts (E2-1 refactor).
// Each exported function maps 1-to-1 with a Toolbox method, accepting
// (ctx: RespondCtx, args) instead of using `this.ctx`, so they can be
// called from the thin Toolbox dispatcher and tested in isolation.
// ─────────────────────────────────────────────────────────────────────────────

import { encodeFunctionData, formatUnits, parseUnits, type Address } from "viem";
import { sanitizeAmount } from "@basemate/shared";
import { config } from "@/config/config.js";
import {
  isB20StockAddress,
  isStablecoinAddress,
  resolveTokenAsync,
  fetchTokenPriceUsd,
} from "@/discovery/ai/tokens.js";
import { buildB20UsdcSpotBuy } from "@/discovery/stocks/giftStock.service.js";
import {
  assertSwapUsdWithinLimit,
  resolveProtocolVolumeUsdc,
  resolveUsdQuotedSwapAmount,
  usdToTokenAmount,
} from "@/discovery/ai/amounts.js";
import {
  amountUsdFromPrepared,
  FlashPrepareError,
  formatFlashOrderPreview,
  prepareFlashOrder,
} from "@/discovery/flash/index.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { logger } from "@/utils/logger.js";
import {
  AERODROME_DEFAULT_FACTORY,
  AERODROME_ROUTER,
  AERODROME_ROUTER_LP_ABI,
  buildAerodromeRoutedSwap,
  buildERC20Approve,
  getBestSwapQuote,
} from "@/discovery/ai/tools/swap.js";
import {
  fetchMoonwellDirectSupplies,
  MOONWELL_MTOKEN_ABI,
  MOONWELL_MTOKENS,
  moonwellUnderlyingSymbol,
} from "@/portfolio/moonwell.js";
import { MOONWELL_MTOKEN_KEY_SET } from "@/discovery/ai/intents.js";
import type { WalletCall } from "@/discovery/ai/types.js";
import type { RespondCtx, ToolResult } from "../toolbox.js";

// ─── Portfolio / dashboard URLs ───────────────────────────────────────────────
export const MOONWELL_PORTFOLIO_URL = "https://moonwell.fi/portfolio";
export const MORPHO_PORTFOLIO_URL   = "https://morpho.org";
export const AAVE_PORTFOLIO_URL     = "https://app.aave.com";

// ─── Aave V3 constants (Base) ─────────────────────────────────────────────────
const AAVE_DATA_PROVIDER = "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A" as const satisfies Address;
const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as const satisfies Address;

const AAVE_BASE_ASSETS: Partial<Record<string, Address>> = {
  USDC:   "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH:   "0x4200000000000000000000000000000000000006",
  CBBTC:  "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  WSTETH: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
  CBETH:  "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
  USDS:   "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc",
};

const AAVE_DATA_PROVIDER_ABI = [
  {
    name: "getReserveData",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "unbacked", type: "uint256" },
      { name: "accruedToTreasuryScaled", type: "uint256" },
      { name: "totalAToken", type: "uint256" },
      { name: "totalStableDebt", type: "uint256" },
      { name: "totalVariableDebt", type: "uint256" },
      { name: "liquidityRate", type: "uint256" },
      { name: "variableBorrowRate", type: "uint256" },
      { name: "stableBorrowRate", type: "uint256" },
      { name: "averageStableBorrowRate", type: "uint256" },
      { name: "liquidityIndex", type: "uint256" },
      { name: "variableBorrowIndex", type: "uint256" },
      { name: "lastUpdateTimestamp", type: "uint40" },
    ],
  },
] as const;

const AAVE_POOL_ABI = [
  {
    name: "supply",
    type: "function",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// ─── Morpho market cache ──────────────────────────────────────────────────────
interface MorphoMarketEntry {
  marketId: string;
  name: string;
  loanSymbol: string;
  apy: number;
  tvlUsd: number;
}
let morphoMarketCache: { ts: number; markets: MorphoMarketEntry[] } | null = null;
const MORPHO_CACHE_TTL_MS = 30 * 60 * 1000;

// ─── Aave rate cache ──────────────────────────────────────────────────────────
interface AaveRateCacheEntry { ts: number; apr: number | null }
const aaveRateCache = new Map<string, AaveRateCacheEntry>();
const AAVE_CACHE_TTL_MS = 5 * 60_000;
const RAY = BigInt("1000000000000000000000000000"); // 1e27

// ─── Moonwell market cache ────────────────────────────────────────────────────
interface MoonwellMarket {
  asset: string;
  deprecated: boolean;
  baseSupplyApy: number;
  totalSupplyApr: number;
}
let moonwellMarketsCache: { ts: number; markets: MoonwellMarket[] } | null = null;
const MOONWELL_CACHE_TTL_MS = 5 * 60_000;

// ─── Private helpers ──────────────────────────────────────────────────────────

function formatTvl(usd: number): string {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(0)}K`;
  return `$${Math.round(usd)}`;
}

function moonwellAmountValue(amount: unknown): number {
  if (!amount || typeof amount !== "object") return 0;
  const value = (amount as { value?: unknown }).value;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  const formatted = (amount as { formatted?: unknown }).formatted;
  if (typeof formatted === "number") return formatted;
  if (typeof formatted === "string") return Number(formatted) || 0;
  const toString = (amount as { toString?: unknown }).toString;
  if (typeof toString === "function") {
    const parsed = Number(toString.call(amount));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function moonwellPositionSymbol(pos: unknown): string {
  const market = (pos as { market?: unknown } | null)?.market as Record<string, unknown> | undefined;
  const underlying = market?.underlyingToken;
  const candidates = [
    typeof underlying === "object" && underlying ? (underlying as Record<string, unknown>).symbol : undefined,
    typeof underlying === "string" ? underlying : undefined,
    market?.assetSymbol,
    market?.underlyingSymbol,
    market?.symbol,
    market?.name,
  ];
  const raw = candidates.find((v): v is string => typeof v === "string" && v.length > 0) ?? "?";
  return moonwellUnderlyingSymbol(raw);
}

/** Thin wrapper — delegates to the cached service-layer fetch. */
async function fetchMorphoVaultsFromApi(): Promise<MorphoVaultEntry[]> {
  return fetchMorphoVaultsService();
}

/** Listed Morpho Blue markets on Base (loan-side supply APY). Cached. */
async function fetchMorphoMarketsFromApi(): Promise<MorphoMarketEntry[]> {
  const now = Date.now();
  if (morphoMarketCache && now - morphoMarketCache.ts < MORPHO_CACHE_TTL_MS) {
    return morphoMarketCache.markets;
  }
  const res = await fetch("https://blue-api.morpho.org/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query {
        markets(
          first: 100
          where: { listed: true, chainId_in: [8453] }
          orderBy: SupplyAssetsUsd
          orderDirection: Desc
        ) {
          items {
            id
            loanAsset { symbol }
            collateralAsset { symbol }
            state { netSupplyApy supplyAssetsUsd }
          }
        }
      }`,
    }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Morpho API ${res.status}`);
  const json = await res.json() as {
    data?: {
      markets?: {
        items?: Array<{
          id?: string;
          loanAsset?: { symbol?: string };
          collateralAsset?: { symbol?: string };
          state?: { netSupplyApy?: number; supplyAssetsUsd?: number };
        }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) throw new Error(json.errors[0].message);

  const raw = json.data?.markets?.items ?? [];
  const markets: MorphoMarketEntry[] = raw
    .filter((m) => {
      const tvl = m.state?.supplyAssetsUsd ?? 0;
      const apy = m.state?.netSupplyApy ?? 0;
      return !!m.id && tvl >= 1_000 && apy > 0 && apy < 2;
    })
    .map((m) => {
      const loan = m.loanAsset?.symbol ?? "?";
      const coll = m.collateralAsset?.symbol ?? "?";
      const apy = (m.state?.netSupplyApy ?? 0) * 100;
      return {
        marketId: m.id!,
        name: `${loan}/${coll} market`,
        loanSymbol: loan.toUpperCase(),
        apy,
        tvlUsd: Math.round(m.state?.supplyAssetsUsd ?? 0),
      };
    });
  morphoMarketCache = { ts: now, markets };
  return markets;
}

/** Top listed Morpho Blue market by TVL where the loan asset matches the symbol. */
async function fetchMorphoTopMarket(
  tokenSymbol: string,
): Promise<{ marketId: string; name: string; apy: number; tvlUsd: number } | null> {
  const markets = await fetchMorphoMarketsFromApi();
  const matchSet = new Set(morphoAssetAliases(tokenSymbol));
  const matching = markets.filter((m) => matchSet.has(m.loanSymbol));
  if (matching.length === 0) return null;
  matching.sort((a, b) => b.tvlUsd - a.tvlUsd);
  const top = matching[0]!;
  if (!Number.isFinite(top.apy) || top.apy <= 0) return null;
  return { marketId: top.marketId, name: top.name, apy: top.apy, tvlUsd: top.tvlUsd };
}

/**
 * Find the top-TVL Morpho vault (V1 MetaMorpho or V2) whose underlying asset matches.
 * Falls back to Morpho Blue loan markets only when no vault exists for the asset.
 */
async function fetchMorphoTopVault(
  tokenSymbol: string,
): Promise<{ name: string; address: string; apy: number; tvlUsd: number } | null> {
  let vaults: MorphoVaultEntry[];
  try {
    vaults = await fetchMorphoVaultsFromApi();
  } catch {
    vaults = [];
  }
  const matchSet = new Set(morphoAssetAliases(tokenSymbol));
  const matching = vaults.filter((v) => matchSet.has(v.assetSymbol.toUpperCase()));
  if (matching.length > 0) {
    matching.sort((a, b) => {
      const apyA = parseFloat(a.apy.replace(/[^0-9.]/g, "")) || 0;
      const apyB = parseFloat(b.apy.replace(/[^0-9.]/g, "")) || 0;
      return apyB - apyA || b.tvlUsd - a.tvlUsd;
    });
    const top = matching[0]!;
    const apyNum = parseFloat(top.apy.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(apyNum) && apyNum > 0) {
      return { name: top.name, address: top.address, apy: apyNum, tvlUsd: top.tvlUsd };
    }
  }

  const market = await fetchMorphoTopMarket(tokenSymbol).catch(() => null);
  if (!market) return null;
  return {
    name: market.name,
    address: market.marketId,
    apy: market.apy,
    tvlUsd: market.tvlUsd,
  };
}

// ─── Module-level yield-compare helpers (exported for use in tests / eval) ────

export async function fetchMoonwellSupplyApr(tokenSymbol: string): Promise<{ base: number; total: number } | null> {
  const now = Date.now();
  if (!moonwellMarketsCache || now - moonwellMarketsCache.ts > MOONWELL_CACHE_TTL_MS) {
    const resp = await fetch(
      "https://api.moonwell.fi/v1/markets?chainId=8453",
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!resp.ok) throw new Error(`moonwell ${resp.status}`);
    const json = (await resp.json()) as { success: boolean; data: MoonwellMarket[] };
    if (!json.success || !Array.isArray(json.data)) throw new Error("moonwell bad payload");
    moonwellMarketsCache = { ts: now, markets: json.data };
  }
  const candidates = moonwellMarketAliases(tokenSymbol);
  const market = moonwellMarketsCache.markets.find(
    (m) => !m.deprecated && candidates.includes(m.asset.toUpperCase()),
  );
  if (!market) return null;
  const base = market.baseSupplyApy;
  const total = market.totalSupplyApr || market.baseSupplyApy;
  return base >= 0.05 ? { base, total } : null;
}

/**
 * Featured Moonwell markets for the app Earn tab, in fixed priority order.
 * `symbol` is the display/label (also what the deposit endpoint resolves, which
 * upper-cases before lookup); `key` indexes MOONWELL_MTOKENS. APY is a PERCENT
 * (e.g. 4.2). We keep the four in order regardless of APY and always list them
 * (apy null renders as "—") so the tab is stable.
 */
const MOONWELL_EARN_ASSETS: ReadonlyArray<{ symbol: string; key: keyof typeof MOONWELL_MTOKENS }> = [
  { symbol: "USDC", key: "USDC" },
  { symbol: "EURC", key: "EURC" },
  { symbol: "WETH", key: "WETH" },
  { symbol: "cbBTC", key: "CBBTC" },
];

export async function fetchMoonwellRates(): Promise<
  Array<{ name: string; asset: string; apy: number | null; address: string }>
> {
  return Promise.all(
    MOONWELL_EARN_ASSETS.map(async ({ symbol, key }) => {
      const apr = await fetchMoonwellSupplyApr(symbol).catch(() => null);
      return {
        name: `Moonwell ${symbol}`,
        asset: symbol,
        apy: apr?.total ?? null,
        address: MOONWELL_MTOKENS[key] as string,
      };
    }),
  );
}

export async function fetchAaveV3SupplyApr(tokenSymbol: string): Promise<number | null> {
  const key = normalizeYieldTokenSymbol(tokenSymbol);
  const assetAddr = AAVE_BASE_ASSETS[key];
  if (!assetAddr) return null;

  const now = Date.now();
  const cached = aaveRateCache.get(key);
  if (cached && now - cached.ts < AAVE_CACHE_TTL_MS) {
    return cached.apr;
  }

  try {
    const { createPublicClient, http } = await import("viem");
    const { base } = await import("viem/chains");
    const client = createPublicClient({
      chain: base,
      transport: http(process.env.BASE_RPC_URL ?? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY ?? ""}`),
    });
    const result = await Promise.race([
      client.readContract({
        address: AAVE_DATA_PROVIDER,
        abi: AAVE_DATA_PROVIDER_ABI,
        functionName: "getReserveData",
        args: [assetAddr],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("aave rate read timeout")), 5_000),
      ),
    ]);
    const liquidityRate = result[5] as bigint;
    if (!liquidityRate || liquidityRate === BigInt(0)) {
      aaveRateCache.set(key, { ts: now, apr: null });
      return null;
    }
    const aprBps = Number((liquidityRate * BigInt(10000)) / RAY);
    const aprPct = aprBps / 100;
    const out = aprPct >= 0.05 ? aprPct : null;
    aaveRateCache.set(key, { ts: now, apr: out });
    return out;
  } catch (err) {
    console.warn("aave apr read failed:", err instanceof Error ? err.message : String(err));
    aaveRateCache.set(key, { ts: now, apr: null });
    return null;
  }
}

// ─── Exported tool handlers ───────────────────────────────────────────────────

export async function uniswap_prepare_swap(
  ctx: RespondCtx,
  args: {
    fromAsset: string;
    toAsset: string;
    amount: string;
    isUsd?: boolean;
  },
): Promise<ToolResult> {
  const [from, to] = await Promise.all([
    resolveTokenAsync(args.fromAsset),
    resolveTokenAsync(args.toAsset),
  ]);
  let amount = sanitizeAmount(args.amount);
  if (!amount) {
    return {
      data: { error: "Invalid amount" },
      control: { type: "text", text: "What amount should I swap?" },
    };
  }
  const unresolved = [!from.resolved && args.fromAsset, !to.resolved && args.toAsset].filter(Boolean) as string[];
  if (unresolved.length > 0) {
    const list = unresolved.join(" and ");
    return {
      data: { error: `Unresolved token(s): ${list}` },
      control: {
        type: "text",
        text: `couldn't find ${list} on Base. paste the contract address and I'll swap it.`,
      },
    };
  }

  let isUsd = args.isUsd ?? false;
  ({ amount, isUsd } = resolveUsdQuotedSwapAmount({
    modelAmount: amount,
    userMessage: ctx.userMessage,
    fromStablecoin: isStablecoinAddress(from.address),
    isUsd,
  }));

  let usdSpend: string | undefined;
  if (isUsd) {
    usdSpend = amount;
    const limitErr = assertSwapUsdWithinLimit(amount);
    if (limitErr) {
      return { data: { error: limitErr }, control: { type: "text", text: limitErr } };
    }
  }
  const usdLabel = isUsd && usdSpend ? ` ($${usdSpend})` : "";
  if (isUsd && usdSpend) {
    const converted = await usdToTokenAmount(usdSpend, from);
    if ("error" in converted) {
      return {
        data: { error: "Price unavailable" },
        control: { type: "text", text: converted.error },
      };
    }
    amount = converted.amount;
  }

  // B20 stocks (AAPLc, …) are Slipstream USDC pairs. Flash has no book and
  // DexScreener-first resolution used to price them at 18 decimals.
  if (isStablecoinAddress(from.address) && isB20StockAddress(to.address)) {
    const senderKey = ctx.copyUserKey ?? ctx.inboxId;
    const embedded = senderKey ? await WalletAdapter.getEmbeddedWallet(senderKey) : null;
    const walletAddress = embedded?.address || ctx.walletAddress || "";
    if (!walletAddress) {
      return {
        data: { error: "No wallet" },
        control: {
          type: "text",
          text: "connect your Basemate account first, then I'll buy that stock.",
        },
      };
    }
    const built = await buildB20UsdcSpotBuy({
      toAddress: to.address,
      toSymbol: to.symbol || args.toAsset,
      toDecimals: to.decimals,
      usdcHuman: amount,
      walletAddress,
      amountUsd: usdSpend,
    });
    if (!built) {
      return {
        data: { error: "No B20 Slipstream route" },
        control: {
          type: "text",
          text: `couldn't find a USDC pool for ${to.symbol} on Base right now. try again in a bit.`,
        },
      };
    }
    return {
      data: { label: built.label, source: "slipstream" },
      control: {
        type: "transaction",
        text: built.label,
        calls: built.calls,
        chainId: "0x2105",
        copyTradeCtx: {
          type: "swap" as const,
          fromSymbol: from.symbol,
          fromAddress: from.address,
          fromDecimals: from.decimals,
          toSymbol: to.symbol,
          toAddress: to.address,
          amount,
        },
      },
    };
  }

  // When Flash is configured, market buys/sells go through Definitive — not Kyber/Uniswap.
  // Flash: target = traded token, contra = quote; buy spends contra, sell spends target.
  // Fail closed: never silently fall through to Uniswap (breaks paymaster + UX).
  if (config.flash.enabled && amount.toLowerCase() !== "all") {
    const senderKey = ctx.copyUserKey ?? ctx.inboxId;
    const embedded = senderKey ? await WalletAdapter.getEmbeddedWallet(senderKey) : null;
    if (!embedded) {
      return {
        data: { error: "No wallet" },
        control: {
          type: "text",
          text: "connect your Basemate account first, then I'll swap that.",
        },
      };
    }
    const fromStable = isStablecoinAddress(from.address);
    const toStable = isStablecoinAddress(to.address);
    const flashArgs =
      fromStable && !toStable
        ? {
            targetAsset: to.symbol || args.toAsset,
            contraAsset: from.symbol || args.fromAsset,
            side: "buy" as const,
          }
        : !fromStable && toStable
          ? {
              targetAsset: from.symbol || args.fromAsset,
              contraAsset: to.symbol || args.toAsset,
              side: "sell" as const,
            }
          : {
              // Token↔token / ETH pairs: buy `to` spending `from`.
              targetAsset: to.symbol || args.toAsset,
              contraAsset: from.symbol || args.fromAsset,
              side: "buy" as const,
            };
    try {
      const prepared = await prepareFlashOrder({
        funderAddress: embedded.address,
        ...flashArgs,
        qty: amount,
        orderType: "market",
        maxSlippage: "0.05",
      });
      const preview = formatFlashOrderPreview(prepared);
      return {
        data: { quoteId: prepared.quoteId, source: "flash", orderType: "market" },
        control: {
          type: "flash_order",
          text: preview,
          prepared,
          amountUsd:
            amountUsdFromPrepared(prepared) ??
            (usdSpend != null ? Number(usdSpend) : null),
        },
      };
    } catch (err) {
      const msg =
        err instanceof FlashPrepareError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Couldn't quote that swap.";
      logger.warn(
        {
          err,
          from: from.symbol,
          to: to.symbol,
          side: flashArgs.side,
          amount,
        },
        "[flash] market swap prepare failed — not falling back to Uniswap",
      );
      return {
        data: { error: msg, source: "flash" },
        control: {
          type: "text",
          text:
            err instanceof FlashPrepareError
              ? msg
              : `couldn't get a flash quote for ${from.symbol} → ${to.symbol}. try again in a moment, or paste the token address.`,
        },
      };
    }
  }

  const label = `Swap ${amount} ${from.symbol}${usdLabel} → ${to.symbol}`;

  const rawAmountIn = parseUnits(amount, from.address === "ETH" ? 18 : from.decimals);

  const best = await getBestSwapQuote({
    fromAddress: from.address,
    fromIsEth: from.address === "ETH",
    fromDecimals: from.decimals,
    fromSymbol: from.symbol,
    toAddress: to.address,
    toSymbol: to.symbol,
    toDecimals: to.decimals,
    rawAmountIn,
    humanAmount: amount,
    walletAddress: ctx.walletAddress || "",
    label,
    isUsd,
    amountUsd: usdSpend,
  });
  if (best) {
    const swapVolumeUsdc = await resolveProtocolVolumeUsdc({
      usdAmount: usdSpend ?? amount,
      isUsd: isUsd || isStablecoinAddress(from.address),
      tokenAmount: amount,
      symbol: from.symbol,
      tokenAddress: from.address,
    });
    return {
      data: { label: best.label, source: best.dex },
      control: {
        type: "transaction",
        text: `${best.label} on Base — sign below:`,
        calls: best.calls,
        chainId: "0x2105",
        copyTradeCtx: {
          type: "swap" as const,
          fromSymbol: from.symbol,
          fromAddress: from.address,
          fromDecimals: from.decimals,
          toSymbol: to.symbol,
          toAddress: to.address,
          amount,
        },
        ...(swapVolumeUsdc != null && swapVolumeUsdc > 0
          ? {
              protocolVolume: {
                protocol: best.dex,
                action: "swap",
                token: `${from.symbol}/${to.symbol}`,
                amountUsdc: swapVolumeUsdc,
              },
            }
          : {}),
      },
    };
  }

  return {
    data: { error: "Could not build swap" },
    control: {
      type: "text",
      text: `I couldn't find a swap route for ${from.symbol} → ${to.symbol} on Base. The token may not have enough liquidity on Uniswap or Aerodrome yet. Try a smaller amount.`,
    },
  };
}

export async function morpho_get_vaults(
  ctx: RespondCtx,
  args: { asset?: string; limit?: number },
): Promise<ToolResult> {
  const limit = Math.min(args.limit ?? 5, 10);
  try {
    let items = await fetchMorphoVaultsFromApi();

    if (args.asset) {
      const want = args.asset.toUpperCase();
      items = items.filter((v) => v.assetSymbol.toUpperCase() === want);
    }

    const top = items
      .sort((a, b) => b.tvlUsd - a.tvlUsd)
      .slice(0, limit)
      .map((v) => ({
        name: v.name,
        address: v.address,
        asset: v.assetSymbol,
        apy: v.apy,
        tvlUsd: v.tvlUsd,
        tvlFormatted: formatTvl(v.tvlUsd),
      }));

    if (top.length === 0) {
      const wanted = args.asset?.toUpperCase();
      if (wanted) {
        const market = await fetchMorphoTopMarket(wanted).catch(() => null);
        if (market) {
          return {
            data: {
              vaults: [],
              market: {
                id: market.marketId,
                name: market.name,
                asset: wanted,
                apy: `${market.apy.toFixed(2)}%`,
                tvlUsd: market.tvlUsd,
              },
            },
            control: {
              type: "text",
              text:
                `no Morpho vault for ${wanted} yet — but Morpho Blue has a ${market.name} at ~${market.apy.toFixed(1)}% supply APY ($${Math.round(market.tvlUsd / 1000)}k supplied). ` +
                `supply at https://app.morpho.org/base/earn?asset=${encodeURIComponent(
                  (await resolveTokenAsync(wanted).catch(() => null))?.address ?? wanted,
                )}`,
            },
          };
        }
      }
      return {
        data: { vaults: [] },
        control: {
          type: "text",
          text: wanted
            ? `no morpho vault for ${wanted} on base — morpho's listed vaults are mostly USDC, WETH, cbBTC, EURC, MXNB. try one of those, or pick another protocol.`
            : "no morpho vaults available right now — try again in a sec",
        },
      };
    }

    return { data: { vaults: top } };
  } catch (err) {
    console.warn("⚠️ Morpho API error:", err);
    return {
      data: { error: "Morpho API unavailable" },
      control: {
        type: "text",
        text: "couldn't reach morpho right now — try again in a sec",
      },
    };
  }
}

export async function morpho_prepare_deposit(
  ctx: RespondCtx,
  args: {
    asset: string;
    amount?: string;
    isUsd?: boolean;
    vaultName?: string;
  },
): Promise<ToolResult> {
  const asset = await resolveTokenAsync(args.asset);
  if (!args.amount) {
    const vaults = await fetchMorphoVaultsFromApi().catch(() => []);
    const matchSet = new Set(morphoAssetAliases(asset.symbol));
    const hasVault = vaults.some((v) => matchSet.has(v.assetSymbol.toUpperCase()));
    if (!hasVault) {
      const market = await fetchMorphoTopMarket(asset.symbol).catch(() => null);
      if (market && asset.address !== "ETH") {
        const earnUrl = `https://app.morpho.org/base/earn?asset=${asset.address}`;
        return {
          data: { asset: asset.symbol, marketId: market.marketId },
          control: {
            type: "text",
            text:
              `${asset.symbol} earns ~${market.apy.toFixed(1)}% on Morpho Blue (${market.name}) — no in-chat vault deposit yet. Supply here: ${earnUrl}`,
          },
        };
      }
    }
    return {
      data: { asset: asset.symbol, pendingAmount: true },
      control: {
        type: "amount_select",
        text: `how much do you want to deposit on morpho? tap a preset or type your own (e.g. "0.01 ${asset.symbol}"):`,
        asset: asset.symbol,
        protocol: "morpho",
        presetsUsd: [5, 25, 100],
      },
    };
  }
  let amount = sanitizeAmount(args.amount);
  if (!amount) {
    return {
      data: { error: "Invalid amount" },
      control: { type: "text", text: "How much do you want to deposit?" },
    };
  }

  const usdNote = args.isUsd ? ` ($${args.amount})` : "";
  if (args.isUsd && asset.address !== "ETH") {
    const priceUsd = await fetchTokenPriceUsd(asset.address);
    if (!priceUsd) {
      return {
        data: { error: "Price unavailable" },
        control: {
          type: "text",
          text: `can't price ${asset.symbol} right now — try specifying the token amount directly (e.g. "deposit 100 ${asset.symbol} on morpho").`,
        },
      };
    }
    const tokenAmt = parseFloat(amount) / priceUsd;
    amount = tokenAmt.toFixed(Math.min(asset.decimals, 8));
  }

  const receiver = ctx.walletAddress;
  if (!receiver || receiver === "0x0000000000000000000000000000000000000000") {
    return {
      data: { error: "Wallet address unknown" },
      control: {
        type: "text",
        text: "I can't read your wallet address from this conversation. Try sending the message again or restart the chat.",
      },
    };
  }

  try {
    const vaultResult = await morpho_get_vaults(ctx, { asset: asset.symbol, limit: 10 });
    const vaultData = vaultResult.data as {
      vaults?: Array<{ address: string; name: string; apy: string }>;
    };
    const allVaults = vaultData?.vaults ?? [];

    let topVault: (typeof allVaults)[0] | undefined;
    if (args.vaultName && allVaults.length > 0) {
      const hint = args.vaultName.toLowerCase();
      const scored = allVaults
        .map((v) => {
          const vname = v.name.toLowerCase();
          let score = 0;
          if (vname.includes(hint)) score += 10;
          const words = hint.split(/\s+/).filter(Boolean);
          for (const w of words) {
            if (vname.includes(w)) score += 3;
          }
          return { v, score };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score);
      topVault = scored[0]?.v ?? allVaults[0];
    } else {
      topVault = allVaults[0];
    }

    if (topVault?.address && asset.address !== "ETH") {
      const rawAmount = parseUnits(amount, asset.decimals);
      const vaultAddr = topVault.address as Address;
      const label = `Deposit ${amount} ${asset.symbol}${usdNote} on Morpho — ${topVault.name} vault (${topVault.apy} APY)`;

      const depositData = encodeFunctionData({
        abi: MORPHO_VAULT_ABI,
        functionName: "deposit",
        args: [rawAmount, receiver as Address],
      });

      const calls: WalletCall[] = [
        buildERC20Approve(asset.address as Address, vaultAddr, rawAmount),
        {
          to: vaultAddr,
          value: "0x0",
          data: depositData,
          metadata: { description: `${label} — track: ${MORPHO_PORTFOLIO_URL}`, transactionType: "deposit" },
        },
      ];

      const amountUsdc = await resolveProtocolVolumeUsdc({
        usdAmount: args.amount!,
        isUsd: args.isUsd,
        tokenAmount: amount,
        symbol: asset.symbol,
        tokenAddress: asset.address,
      });

      return {
        data: { label },
        control: {
          type: "transaction",
          text: `${label} — sign below:`,
          calls,
          chainId: "0x2105",
          ...(amountUsdc != null && amountUsdc > 0
            ? {
                protocolVolume: {
                  protocol: "morpho" as const,
                  action: "supply",
                  token: asset.symbol,
                  amountUsdc,
                },
              }
            : {}),
        },
      };
    }
  } catch (err) {
    console.warn("⚠️ Morpho deposit encoding failed:", err);
  }

  const market = await fetchMorphoTopMarket(asset.symbol).catch(() => null);
  if (market && asset.address !== "ETH") {
    const earnUrl = `https://app.morpho.org/base/earn?asset=${asset.address}`;
    return {
      data: { error: "No vault found", marketId: market.marketId },
      control: {
        type: "text",
        text:
          `${asset.symbol} doesn't have a Morpho vault on Base yet — supply the Morpho Blue ${market.name} (~${market.apy.toFixed(1)}% APY) here: ${earnUrl}`,
      },
    };
  }

  return {
    data: { error: "No vault found" },
    control: {
      type: "text",
      text: `I couldn't find a Morpho vault for ${asset.symbol} on Base right now. Try USDC or WETH, or check back shortly.`,
    },
  };
}

export async function morpho_get_position(
  ctx: RespondCtx,
  args: { asset?: string } = {},
): Promise<ToolResult> {
  const walletAddress = ctx.walletAddress;
  if (!walletAddress || walletAddress === "0x0000000000000000000000000000000000000000") {
    return {
      data: { error: "wallet address unavailable" },
      control: { type: "text", text: "i can't read your wallet address right now — try again in a sec" },
    };
  }

  try {
    const vaults = await fetchMorphoVaultsFromApi();
    const assetFilter = args.asset?.trim();
    const filtered = assetFilter
      ? vaults.filter((vault) => {
          const aliases = new Set(morphoAssetAliases(assetFilter).map((s) => s.toUpperCase()));
          return aliases.has(vault.assetSymbol.toUpperCase());
        })
      : vaults;

    if (filtered.length === 0) {
      return {
        data: { positions: [] },
        control: {
          type: "text",
          text: assetFilter
            ? `no morpho vaults found for ${assetFilter.toUpperCase()} on base`
            : "no morpho vaults available to check right now — try again in a sec",
        },
      };
    }

    const { createPublicClient, http } = await import("viem");
    const { base } = await import("viem/chains");
    const { resolveBaseRpcUrl } = await import("@/chain/base-rpc.js");
    const publicClient = createPublicClient({
      chain: base,
      transport: http(resolveBaseRpcUrl()),
    });

    const positions: string[] = [];
    const CHUNK_SIZE = 4;

    for (let i = 0; i < filtered.length; i += CHUNK_SIZE) {
      const chunk = filtered.slice(i, i + CHUNK_SIZE);
      const chunkRows = await Promise.all(
        chunk.map(async (vault) => {
          try {
            const shares = await publicClient.readContract({
              address: vault.address as Address,
              abi: MORPHO_VAULT_ABI,
              functionName: "balanceOf",
              args: [walletAddress as Address],
            });
            if (shares <= 0n) return null;

            const assets = await publicClient.readContract({
              address: vault.address as Address,
              abi: MORPHO_VAULT_ABI,
              functionName: "convertToAssets",
              args: [shares],
            });
            const token = await resolveTokenAsync(vault.assetSymbol);
            const amount = Number(formatUnits(assets, token.decimals));
            if (!Number.isFinite(amount) || amount <= 0) return null;
            return `${vault.assetSymbol}: ${amount.toFixed(amount >= 1 ? 4 : 6)} in ${vault.name} (${vault.apy} APY)`;
          } catch (err) {
            console.warn("⚠️ morpho_get_position vault read failed", { vault: vault.address, err });
            return null;
          }
        }),
      );
      positions.push(...chunkRows.filter((row): row is string => Boolean(row)));
    }

    const summary =
      positions.length > 0
        ? `morpho deposits (${positions.length} vault${positions.length > 1 ? "s" : ""}):\n• ${positions.join("\n• ")}`
        : assetFilter
          ? `no active morpho deposit for ${assetFilter.toUpperCase()} on base yet`
          : "no active morpho deposits on base yet";

    return {
      data: { positionCount: positions.length },
      control: { type: "text", text: summary },
    };
  } catch (err) {
    console.warn("⚠️ morpho_get_position error:", err);
    return {
      data: { error: String(err) },
      control: {
        type: "text",
        text: "having trouble reading your morpho position right now — try again in a moment",
      },
    };
  }
}

export async function morpho_prepare_withdraw(
  ctx: RespondCtx,
  args: {
    asset?: string;
    amount?: string;
    isUsd?: boolean;
    all?: boolean;
    vaultName?: string;
  } = {},
): Promise<ToolResult> {
  const walletAddress = ctx.walletAddress;
  if (!walletAddress || walletAddress === "0x0000000000000000000000000000000000000000") {
    return {
      data: { error: "wallet address unavailable" },
      control: { type: "text", text: "i can't read your wallet address right now — try again in a sec" },
    };
  }

  const all = args.all ?? !args.amount;
  const asset = args.asset ? await resolveTokenAsync(args.asset) : null;

  try {
    if (all) {
      const vaults = await fetchMorphoVaultsFromApi();

      const filtered = asset
        ? vaults.filter((v) => {
            const aliases = new Set(morphoAssetAliases(asset.symbol).map((s) => s.toUpperCase()));
            return aliases.has(v.assetSymbol.toUpperCase());
          })
        : vaults;

      if (filtered.length === 0) {
        return {
          data: { positions: [] },
          control: {
            type: "text",
            text: asset
              ? `no morpho vaults found for ${asset.symbol.toUpperCase()} on base`
              : "no morpho vaults available to check right now — try again in a sec",
          },
        };
      }

      const { calls, names } = await buildMorphoRedeemAllCalls({
        walletAddress,
        assetSymbol: asset?.symbol ?? null,
      });

      if (calls.length === 0) {
        const scope = asset ? `${asset.symbol.toUpperCase()} deposit` : "deposit";
        return {
          data: { empty: true },
          control: {
            type: "text",
            text: `i don't see any active morpho ${scope} to withdraw from this wallet.`,
          },
        };
      }

      const namesText = names.join(", ");
      const label = asset
        ? `Withdraw all ${asset.symbol.toUpperCase()} from Morpho`
        : `Close Morpho positions: ${namesText}`;

      return {
        data: { label, vaults: namesText },
        control: {
          type: "transaction",
          text: `${label} — sign below:`,
          calls,
          chainId: "0x2105",
          followUp: `track your position: ${MORPHO_PORTFOLIO_URL}`,
        },
      };
    }

    if (!asset || !args.amount) {
      return {
        data: { error: "asset and amount required" },
        control: { type: "text", text: "tell me the token and amount to withdraw, or say 'close all morpho'." },
      };
    }

    let amount = sanitizeAmount(args.amount);
    if (!amount) {
      return {
        data: { error: "Invalid amount" },
        control: { type: "text", text: "how much do you want to withdraw from Morpho?" },
      };
    }

    if (args.isUsd) {
      const priceUsd = await fetchTokenPriceUsd(asset.address);
      if (!priceUsd) {
        return {
          data: { error: "Price unavailable" },
          control: {
            type: "text",
            text: `can't look up the current ${asset.symbol} price. try a token amount like "withdraw 100 ${asset.symbol} from morpho".`,
          },
        };
      }
      amount = (parseFloat(amount) / priceUsd).toFixed(Math.min(asset.decimals, 6));
    }

    const vaultResult = await morpho_get_vaults(ctx, { asset: asset.symbol, limit: 10 });
    const vaultData = vaultResult.data as { vaults?: Array<{ address: string; name: string; apy: string }> };
    const allVaults = vaultData?.vaults ?? [];

    if (allVaults.length === 0) {
      return {
        data: { error: "No vault found" },
        control: {
          type: "text",
          text: `no morpho vault found for ${asset.symbol} on base. check your position at ${MORPHO_PORTFOLIO_URL}`,
        },
      };
    }

    let targetVault = allVaults[0];
    if (args.vaultName) {
      const hint = args.vaultName.toLowerCase();
      const scored = allVaults
        .map((v) => {
          const vname = v.name.toLowerCase();
          let score = vname.includes(hint) ? 10 : 0;
          for (const w of hint.split(/\s+/).filter(Boolean)) {
            if (vname.includes(w)) score += 3;
          }
          return { v, score };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score);
      if (scored[0]) targetVault = scored[0].v;
    }

    const rawAmount = parseUnits(amount, asset.decimals);
    const vaultAddr = targetVault!.address as Address;
    const usdNote = args.isUsd ? ` ($${args.amount})` : "";
    const label = `Withdraw ${amount} ${asset.symbol}${usdNote} from Morpho — ${targetVault!.name}`;

    return {
      data: { label },
      control: {
        type: "transaction",
        text: `${label} — sign below:`,
        calls: [
          {
            to: vaultAddr,
            value: "0x0",
            data: encodeFunctionData({
              abi: MORPHO_VAULT_ABI,
              functionName: "withdraw",
              args: [rawAmount, walletAddress as Address, walletAddress as Address],
            }),
            metadata: { description: label, transactionType: "withdraw" },
          },
        ],
        chainId: "0x2105",
        followUp: `track your position: ${MORPHO_PORTFOLIO_URL}`,
      },
    };
  } catch (err) {
    console.warn("⚠️ morpho_prepare_withdraw error:", err);
    return {
      data: { error: String(err) },
      control: {
        type: "text",
        text: "having trouble preparing the Morpho withdraw right now — the on-chain read timed out or failed. try again in a moment",
      },
    };
  }
}

/**
 * Aave V3 supply on Base. Standard 2-step approve + Pool.supply call.
 * Pool address: 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5.
 */
export async function aave_prepare_supply(
  ctx: RespondCtx,
  args: {
    asset: string;
    amount?: string;
    isUsd?: boolean;
  },
): Promise<ToolResult> {
  const asset = await resolveTokenAsync(args.asset);
  if (!args.amount) {
    return {
      data: { asset: asset.symbol, pendingAmount: true },
      control: {
        type: "amount_select",
        text: `how much do you want to supply on aave? tap a preset or type your own (e.g. "0.01 ${asset.symbol}"):`,
        asset: asset.symbol,
        protocol: "aave",
        presetsUsd: [5, 25, 100],
      },
    };
  }
  let amount = sanitizeAmount(args.amount);
  if (!amount) {
    return {
      data: { error: "Invalid amount" },
      control: { type: "text", text: "How much do you want to supply?" },
    };
  }

  const usdNote = args.isUsd ? ` ($${args.amount})` : "";
  if (args.isUsd && asset.address !== "ETH") {
    const priceUsd = await fetchTokenPriceUsd(asset.address);
    if (!priceUsd) {
      return {
        data: { error: "Price unavailable" },
        control: {
          type: "text",
          text: `can't price ${asset.symbol} right now — try specifying the token amount directly (e.g. "supply 100 ${asset.symbol} on aave").`,
        },
      };
    }
    const tokenAmt = parseFloat(amount) / priceUsd;
    amount = tokenAmt.toFixed(Math.min(asset.decimals, 8));
  }

  const onBehalfOf = ctx.walletAddress;
  if (!onBehalfOf || onBehalfOf === "0x0000000000000000000000000000000000000000") {
    return {
      data: { error: "Wallet address unknown" },
      control: {
        type: "text",
        text: "I can't read your wallet address from this conversation. Try sending the message again or restart the chat.",
      },
    };
  }

  const tokenKey = normalizeYieldTokenSymbol(asset.symbol);
  const aaveAsset = AAVE_BASE_ASSETS[tokenKey];
  if (!aaveAsset || asset.address === "ETH") {
    return {
      data: { error: "Token not on Aave V3 Base" },
      control: {
        type: "text",
        text: `Aave V3 doesn't list ${asset.symbol} on Base. Supported: USDC, WETH, cbBTC, wstETH, cbETH, USDS.`,
      },
    };
  }

  try {
    const rawAmount = parseUnits(amount, asset.decimals);
    const label = `Supply ${amount} ${asset.symbol}${usdNote} on Aave V3`;

    const supplyData = encodeFunctionData({
      abi: AAVE_POOL_ABI,
      functionName: "supply",
      args: [aaveAsset, rawAmount, onBehalfOf as Address, 0],
    });

    const calls: WalletCall[] = [
      buildERC20Approve(asset.address as Address, AAVE_POOL, rawAmount),
      {
        to: AAVE_POOL,
        value: "0x0",
        data: supplyData,
        metadata: { description: `${label} — track: ${AAVE_PORTFOLIO_URL}`, transactionType: "supply" },
      },
    ];

    const amountUsdc = await resolveProtocolVolumeUsdc({
      usdAmount: args.amount!,
      isUsd: args.isUsd,
      tokenAmount: amount,
      symbol: asset.symbol,
      tokenAddress: asset.address,
    });

    return {
      data: { label },
      control: {
        type: "transaction",
        text: `${label} — sign below:`,
        calls,
        chainId: "0x2105",
        ...(amountUsdc != null && amountUsdc > 0
          ? {
              protocolVolume: {
                protocol: "aave" as const,
                action: "supply",
                token: asset.symbol,
                amountUsdc,
              },
            }
          : {}),
      },
    };
  } catch (err) {
    console.warn("⚠️ Aave supply encoding failed:", err);
    return {
      data: { error: "Encoding failed" },
      control: {
        type: "text",
        text: `Couldn't prepare an Aave V3 supply for ${asset.symbol} right now — try again in a sec.`,
      },
    };
  }
}

export async function moonwell_get_position(ctx: RespondCtx): Promise<ToolResult> {
  const walletAddress = ctx.walletAddress;
  if (!walletAddress || walletAddress === "0x0000000000000000000000000000000000000000") {
    console.warn("⚠️ moonwell_get_position: wallet address unavailable");
    return {
      data: { error: "wallet address unavailable" },
      control: { type: "text", text: "i can't read your wallet address right now — try again in a sec" },
    };
  }

  try {
    const { createMoonwellClient } = await import("@moonwell-fi/moonwell-sdk");
    const { resolveBaseRpcUrl } = await import("@/chain/base-rpc.js");

    const client = createMoonwellClient({
      networks: { base: { rpcUrls: [resolveBaseRpcUrl()] } },
    });
    const startedAt = Date.now();
    console.log("🌙 moonwell_get_position start", {
      wallet: walletAddress,
      chainId: 8453,
    });

    const positions = await Promise.race([
      client.getUserPositions({ userAddress: walletAddress as `0x${string}`, chainId: 8453 }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 12_000)),
    ]);
    console.log("🌙 moonwell_get_position fetched", {
      wallet: walletAddress,
      count: positions.length,
      latencyMs: Date.now() - startedAt,
    });

    const supplied: string[] = [];
    const borrowed: string[] = [];
    let totalSuppliedUsd = 0;
    let totalBorrowedUsd = 0;
    let totalCollateralUsd = 0;

    for (const pos of positions) {
      const symbol = moonwellPositionSymbol(pos);

      const supplyUsd = Number((pos as any).suppliedUsd ?? 0);
      const borrowUsd = Number((pos as any).borrowedUsd ?? 0);
      const collateralUsd = Number((pos as any).collateralUsd ?? 0);

      const supplyAmt = moonwellAmountValue((pos as any).supplied);
      const borrowAmt = moonwellAmountValue((pos as any).borrowed);
      console.log("🌙 moonwell_get_position market", {
        symbol,
        supplyUsd,
        borrowUsd,
        collateralUsd,
        supplyAmt,
        borrowAmt,
        collateralEnabled: (pos as any).collateralEnabled,
        market: (pos as any).market,
      });

      if (supplyUsd > 0.001) {
        supplied.push(`${symbol}: ${supplyAmt > 0 ? supplyAmt.toFixed(4) + " " : ""}($${supplyUsd.toFixed(2)})`);
        totalSuppliedUsd += supplyUsd;
        totalCollateralUsd += collateralUsd;
      }
      if (borrowUsd > 0.001) {
        borrowed.push(`${symbol}: ${borrowAmt > 0 ? borrowAmt.toFixed(4) + " " : ""}($${borrowUsd.toFixed(2)})`);
        totalBorrowedUsd += borrowUsd;
      }
    }

    if (supplied.length === 0 && borrowed.length === 0) {
      console.log("🌙 moonwell_get_position sdk empty; checking direct mToken balances", {
        wallet: walletAddress,
      });
      const directSupplies = await Promise.race([
        fetchMoonwellDirectSupplies(walletAddress as Address),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("direct mToken timeout")), 12_000)),
      ]);
      console.log("🌙 moonwell_get_position direct mToken balances", {
        wallet: walletAddress,
        count: directSupplies.length,
        supplies: directSupplies,
      });

      for (const supply of directSupplies) {
        const underlyingText =
          supply.underlyingAmount != null && supply.underlyingAmount > 0
            ? `~${supply.underlyingAmount.toFixed(6)} ${supply.symbol}`
            : `${supply.mTokenBalance.toFixed(6)} ${supply.mTokenSymbol}`;
        supplied.push(
          `${supply.symbol}: ${underlyingText} (${supply.mTokenBalance.toFixed(6)} ${supply.mTokenSymbol})`,
        );
      }
    }

    let hfStr = "∞ (no borrows)";
    if (totalBorrowedUsd > 0) {
      const hf = (totalCollateralUsd > 0 ? totalCollateralUsd : totalSuppliedUsd) / totalBorrowedUsd;
      hfStr = hf.toFixed(2);
    }

    let summary = `health factor: ${hfStr}`;
    if (supplied.length > 0) summary += `\n\nsupplied (${supplied.length} market${supplied.length > 1 ? "s" : ""}):\n• ${supplied.join("\n• ")}`;
    if (borrowed.length > 0) summary += `\n\nborrowed:\n• ${borrowed.join("\n• ")}`;
    if (supplied.length === 0 && borrowed.length === 0) summary += "\n\nno active positions on moonwell base yet";
    console.log("🌙 moonwell_get_position summary", {
      wallet: walletAddress,
      suppliedMarkets: supplied.length,
      borrowedMarkets: borrowed.length,
      totalSuppliedUsd,
      totalBorrowedUsd,
      totalCollateralUsd,
      healthFactor: hfStr,
    });

    return {
      data: { totalSuppliedUsd, totalBorrowedUsd },
      control: { type: "text", text: summary },
    };
  } catch (err) {
    console.warn("⚠️ moonwell_get_position error:", err);
    return {
      data: { error: String(err) },
      control: { type: "text", text: "having trouble reading your moonwell position right now — the on-chain read timed out or failed. try again in a moment" },
    };
  }
}

export async function moonwell_prepare_withdraw(
  ctx: RespondCtx,
  args: {
    asset?: string;
    amount?: string;
    isUsd?: boolean;
    all?: boolean;
  } = {},
): Promise<ToolResult> {
  const walletAddress = ctx.walletAddress;
  if (!walletAddress || walletAddress === "0x0000000000000000000000000000000000000000") {
    return {
      data: { error: "wallet address unavailable" },
      control: { type: "text", text: "i can't read your wallet address right now — try again in a sec" },
    };
  }

  const all = args.all ?? !args.amount;
  const asset = args.asset ? await resolveTokenAsync(args.asset) : null;
  const mTokenKey = asset ? normalizeYieldTokenSymbol(asset.symbol) : null;

  if (asset && !MOONWELL_MTOKENS[mTokenKey as keyof typeof MOONWELL_MTOKENS]) {
    return {
      data: { error: "Token not supported on Moonwell" },
      control: { type: "text", text: `Moonwell doesn't have a Base market for ${asset.symbol}.` },
    };
  }

  if (!asset && !all) {
    return {
      data: { error: "asset required" },
      control: { type: "text", text: `which Moonwell market do you want to withdraw from? e.g. \u201cwithdraw USDC from moonwell\u201d` },
    };
  }

  try {
    if (all) {
      const { calls, names } = await buildMoonwellRedeemAllCalls({
        walletAddress,
        assetSymbol: asset?.symbol ?? null,
      });

      if (calls.length === 0) {
        const scope = asset ? `${asset.symbol} supply` : "supply";
        return {
          data: { empty: true },
          control: { type: "text", text: `i don't see any active Moonwell ${scope} to withdraw from this wallet.` },
        };
      }

      const namesText = names.join(", ");
      const label = asset ? `Withdraw all ${asset.symbol} from Moonwell` : `Close Moonwell positions: ${namesText}`;
      return {
        data: { label, markets: namesText },
        control: {
          type: "transaction",
          text: `${label} — sign below:`,
          calls,
          chainId: "0x2105",
          followUp: `track your position: ${MOONWELL_PORTFOLIO_URL}`,
        },
      };
    }

    if (!asset || !mTokenKey || !args.amount) {
      return {
        data: { error: "asset and amount required" },
        control: { type: "text", text: `tell me the token and amount to withdraw, or say \u201cclose all moonwell\u201d.` },
      };
    }

    let amount = sanitizeAmount(args.amount);
    if (!amount) {
      return {
        data: { error: "Invalid amount" },
        control: { type: "text", text: "how much do you want to withdraw from Moonwell?" },
      };
    }

    if (args.isUsd) {
      const priceUsd = await fetchTokenPriceUsd(asset.address);
      if (!priceUsd) {
        return {
          data: { error: "Price unavailable" },
          control: { type: "text", text: `can't look up the current ${asset.symbol} price. try a token amount like "withdraw 5 ${asset.symbol} from moonwell".` },
        };
      }
      amount = (parseFloat(amount) / priceUsd).toFixed(Math.min(asset.decimals, 6));
    }

    const mToken = MOONWELL_MTOKENS[mTokenKey as keyof typeof MOONWELL_MTOKENS];
    const rawAmount = parseUnits(amount, asset.decimals);
    const label = `Withdraw ${amount} ${asset.symbol}${args.isUsd ? ` ($${args.amount})` : ""} from Moonwell`;
    const data = encodeFunctionData({
      abi: MOONWELL_MTOKEN_ABI,
      functionName: "redeemUnderlying",
      args: [rawAmount],
    });

    return {
      data: { label },
      control: {
        type: "transaction",
        text: `${label} — sign below:`,
        calls: [{
          to: mToken,
          value: "0x0",
          data,
          metadata: { description: label, transactionType: "withdraw" },
        }],
        chainId: "0x2105",
        followUp: `track your position: ${MOONWELL_PORTFOLIO_URL}`,
      },
    };
  } catch (err) {
    console.warn("⚠️ moonwell_prepare_withdraw error:", err);
    return {
      data: { error: String(err) },
      control: { type: "text", text: "having trouble preparing the Moonwell withdraw right now — the on-chain read timed out or failed. try again in a moment" },
    };
  }
}

/**
 * Build the approve + mToken.mint calls to supply an ERC-20 to Moonwell.
 * Shared by the chat tool (moonwell_prepare_supply) and the in-app deposit
 * endpoint. Returns null for native ETH or an unsupported asset.
 */
export function buildMoonwellSupplyCalls(args: {
  assetSymbol: string;
  assetAddress: string;
  decimals: number;
  amount: string; // token amount (not USD)
}): { calls: WalletCall[]; mToken: Address; label: string } | null {
  if (args.assetAddress === "ETH") return null;
  const mTokenKey = normalizeYieldTokenSymbol(args.assetSymbol);
  const mToken = MOONWELL_MTOKENS[mTokenKey as keyof typeof MOONWELL_MTOKENS];
  if (!mToken) return null;

  const rawAmount = parseUnits(args.amount, args.decimals);
  const label = `Supply ${args.amount} ${args.assetSymbol} to Moonwell`;
  const mintData = encodeFunctionData({
    abi: MOONWELL_MTOKEN_ABI,
    functionName: "mint",
    args: [rawAmount],
  });
  const calls: WalletCall[] = [
    buildERC20Approve(args.assetAddress as Address, mToken, rawAmount),
    {
      to: mToken,
      value: "0x0",
      data: mintData,
      metadata: { description: label, transactionType: "supply" },
    },
  ];
  return { calls, mToken, label };
}

export async function moonwell_prepare_supply(
  ctx: RespondCtx,
  args: { asset: string; amount?: string; isUsd?: boolean },
): Promise<ToolResult> {
  const asset = await resolveTokenAsync(args.asset);
  if (!args.amount) {
    return {
      data: { asset: asset.symbol, pendingAmount: true },
      control: {
        type: "amount_select",
        text: `how much do you want to supply to moonwell? tap a preset or type your own (e.g. "0.01 ${asset.symbol}"):`,
        asset: asset.symbol,
        protocol: "moonwell",
        presetsUsd: [5, 25, 100],
      },
    };
  }
  let amount = sanitizeAmount(args.amount);
  if (!amount) {
    return {
      data: { error: "Invalid amount" },
      control: { type: "text", text: "How much do you want to supply?" },
    };
  }

  if (args.isUsd && asset.address !== "ETH") {
    const priceUsd = await fetchTokenPriceUsd(asset.address);
    if (!priceUsd) {
      return {
        data: { error: "Price unavailable" },
        control: {
          type: "text",
          text: `Can't look up the current ${asset.symbol} price to convert your dollar amount. Try specifying the token amount directly — e.g. "supply 500 ${asset.symbol}".`,
        },
      };
    }
    const tokenAmt = parseFloat(amount) / priceUsd;
    amount = tokenAmt.toFixed(Math.min(asset.decimals, 6));
  }

  try {
    if (asset.address !== "ETH") {
      const built = buildMoonwellSupplyCalls({
        assetSymbol: asset.symbol,
        assetAddress: asset.address,
        decimals: asset.decimals,
        amount,
      });
      if (built) {
        const usdNote = args.isUsd ? ` ($${args.amount})` : "";
        const label = `Supply ${amount} ${asset.symbol}${usdNote} to Moonwell`;
        const { calls } = built;

        const amountUsdc = await resolveProtocolVolumeUsdc({
          usdAmount: args.amount!,
          isUsd: args.isUsd,
          tokenAmount: amount,
          symbol: asset.symbol,
          tokenAddress: asset.address,
        });

        return {
          data: { label },
          control: {
            type: "transaction",
            text: `${label} — sign below:`,
            calls,
            chainId: "0x2105",
            followUp: `track your position: ${MOONWELL_PORTFOLIO_URL}`,
            ...(amountUsdc != null && amountUsdc > 0
              ? {
                  protocolVolume: {
                    protocol: "moonwell" as const,
                    action: "supply",
                    token: asset.symbol,
                    amountUsdc,
                  },
                }
              : {}),
          },
        };
      }
    }
  } catch (err) {
    console.warn("⚠️ Moonwell supply encoding failed:", err);
  }

  return {
    data: { error: "Token not supported on Moonwell" },
    control: {
      type: "text",
      text: `Moonwell doesn't have a market for ${asset.symbol} on Base. Supported: USDC, DAI, USDS, EURC, WETH, cbETH, wstETH, rETH, weETH, cbBTC, tBTC, LBTC, AERO, WELL, VIRTUAL, MORPHO, MAMO, VVV, cbXRP.`,
    },
  };
}

export async function aerodrome_get_pools(
  ctx: RespondCtx,
  args: { limit?: number; asset?: string },
): Promise<ToolResult> {
  const limit = args.limit ?? 8;

  const cacheKey = `aero_pools_${args.asset ?? "all"}`;
  const cached = (globalThis as Record<string, unknown>)[cacheKey] as
    | { ts: number; text: string } | undefined;
  if (cached && Date.now() - cached.ts < 5 * 60_000) {
    return { data: {}, control: { type: "text", text: cached.text } };
  }

  try {
    const url = "https://yields.llama.fi/pools";
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) throw new Error(`DeFi Llama ${resp.status}`);

    const json = await resp.json() as { data: Array<{
      project: string;
      chain: string;
      symbol: string;
      tvlUsd: number;
      apy: number;
    }> };

    const pools = json.data
      .filter(p =>
        (p.project === "aerodrome-v1" || p.project === "aerodrome-slipstream") &&
        p.chain === "Base" &&
        p.tvlUsd > 100_000 &&
        (!args.asset || p.symbol.toUpperCase().includes(args.asset.toUpperCase()))
      )
      .sort((a, b) => b.tvlUsd - a.tvlUsd)
      .slice(0, limit);

    if (pools.length === 0) {
      return {
        data: { pools: [] },
        control: {
          type: "text",
          text: args.asset
            ? `no aerodrome pools found for ${args.asset.toUpperCase()} right now`
            : "no aerodrome pools available right now — try again in a sec",
        },
      };
    }

    const lines = pools.map(p => {
      const apy = p.apy > 0 ? `${p.apy.toFixed(1)}% APY` : "APY n/a";
      const tvl = p.tvlUsd > 1_000_000
        ? `$${(p.tvlUsd / 1_000_000).toFixed(1)}M TVL`
        : `$${(p.tvlUsd / 1_000).toFixed(0)}K TVL`;
      return `• ${p.symbol} — ${apy} — ${tvl}`;
    });

    const text = `top aerodrome pools on base:\n${lines.join("\n")}`;
    (globalThis as Record<string, unknown>)[cacheKey] = { ts: Date.now(), text };
    return { data: { pools }, control: { type: "text", text } };
  } catch (err) {
    console.warn("⚠️ Aerodrome pools fetch failed:", err);
    return {
      data: { error: "DeFi Llama unavailable" },
      control: {
        type: "text",
        text: "couldn't pull live aerodrome pools right now — try again in a sec",
      },
    };
  }
}

export async function aerodrome_prepare_swap(
  ctx: RespondCtx,
  args: {
    fromAsset: string;
    toAsset: string;
    amount: string;
    isUsd?: boolean;
  },
): Promise<ToolResult> {
  const walletAddress = ctx.walletAddress;
  if (!walletAddress || walletAddress === "0x0000000000000000000000000000000000000000") {
    return {
      data: { error: "no wallet" },
      control: { type: "text", text: "i can't see your wallet — make sure you're connected and try again" },
    };
  }

  const fromSymbol = args.fromAsset.toUpperCase();
  const toSymbol   = args.toAsset.toUpperCase();

  let fromToken: { address: string; decimals: number; symbol: string } | null = null;
  let toToken:   { address: string; decimals: number; symbol: string } | null = null;

  try {
    fromToken = await resolveTokenAsync(fromSymbol);
    toToken   = await resolveTokenAsync(toSymbol);
  } catch (err) {
    return {
      data: { error: String(err) },
      control: { type: "text", text: `couldn't resolve tokens ${fromSymbol} / ${toSymbol}` },
    };
  }

  if (!fromToken || !toToken) {
    return {
      data: { error: "unresolved token" },
      control: { type: "text", text: `i don't know one of those tokens — double-check the symbols` },
    };
  }

  let sanitized = sanitizeAmount(args.amount);
  if (!sanitized) {
    return {
      data: { error: "invalid amount" },
      control: { type: "text", text: `that doesn't look like a valid amount — try something like "10"` },
    };
  }

  let humanAmount = sanitized;
  let usdSpend: string | undefined;
  let isUsd = args.isUsd ?? false;
  ({ amount: humanAmount, isUsd } = resolveUsdQuotedSwapAmount({
    modelAmount: humanAmount,
    userMessage: ctx.userMessage,
    fromStablecoin: isStablecoinAddress(fromToken.address),
    isUsd,
  }));
  if (isUsd) {
    usdSpend = humanAmount;
    const limitErr = assertSwapUsdWithinLimit(humanAmount);
    if (limitErr) {
      return { data: { error: limitErr }, control: { type: "text", text: limitErr } };
    }
    const converted = await usdToTokenAmount(humanAmount, fromToken);
    if ("error" in converted) {
      return {
        data: { error: "price unavailable" },
        control: { type: "text", text: converted.error },
      };
    }
    humanAmount = converted.amount;
  }

  const built = await buildAerodromeRoutedSwap({
    fromAddress: fromToken.address,
    fromSymbol: fromToken.symbol,
    fromDecimals: fromToken.decimals,
    toAddress: toToken.address,
    toSymbol: toToken.symbol,
    humanAmount,
    walletAddress,
  });
  if (!built) {
    return {
      data: { error: "build failed" },
      control: { type: "text", text: `couldn't build that aerodrome swap — try again in a sec` },
    };
  }

  const swapVolumeUsdc = await resolveProtocolVolumeUsdc({
    usdAmount: usdSpend ?? humanAmount,
    isUsd: isUsd || isStablecoinAddress(fromToken.address),
    tokenAmount: humanAmount,
    symbol: fromToken.symbol,
    tokenAddress: fromToken.address,
  });
  return {
    data: { calls: built.calls, chainId: "0x2105", fromSymbol, toSymbol, amount: humanAmount },
    control: {
      type: "transaction",
      calls: built.calls,
      chainId: "0x2105",
      text: `${built.label} — sign below:`,
      copyTradeCtx: {
        type: "swap" as const,
        fromSymbol: fromToken.symbol,
        fromAddress: fromToken.address,
        fromDecimals: fromToken.decimals,
        toSymbol: toToken.symbol,
        toAddress: toToken.address,
        amount: humanAmount,
      },
      ...(swapVolumeUsdc != null && swapVolumeUsdc > 0
        ? {
            protocolVolume: {
              protocol: "aerodrome" as const,
              action: "swap",
              token: `${fromToken.symbol}/${toToken.symbol}`,
              amountUsdc: swapVolumeUsdc,
            },
          }
        : {}),
    },
  };
}

export async function aerodrome_prepare_add_liquidity(
  ctx: RespondCtx,
  args: {
    tokenA: string;
    tokenB: string;
    amountA: string;
    amountB: string;
  },
): Promise<ToolResult> {
  const walletAddress = ctx.walletAddress;
  if (!walletAddress || walletAddress === "0x0000000000000000000000000000000000000000") {
    return {
      data: { error: "no wallet" },
      control: { type: "text", text: "i can't see your wallet — make sure you're connected and try again" },
    };
  }

  const symbolA = args.tokenA.toUpperCase();
  const symbolB = args.tokenB.toUpperCase();

  let tokenA: { address: string; decimals: number; symbol: string } | null = null;
  let tokenB: { address: string; decimals: number; symbol: string } | null = null;

  try {
    [tokenA, tokenB] = await Promise.all([
      resolveTokenAsync(symbolA),
      resolveTokenAsync(symbolB),
    ]);
  } catch (err) {
    return {
      data: { error: String(err) },
      control: { type: "text", text: `couldn't resolve ${symbolA} or ${symbolB}` },
    };
  }

  if (!tokenA || !tokenB) {
    return {
      data: { error: "unresolved tokens" },
      control: { type: "text", text: `i don't know one of those tokens — double-check the symbols` },
    };
  }

  const addrA = tokenA.address as Address;
  const addrB = tokenB.address as Address;

  const sanitizedA = sanitizeAmount(args.amountA);
  const sanitizedB = sanitizeAmount(args.amountB);
  if (!sanitizedA || !sanitizedB) {
    return {
      data: { error: "invalid amount" },
      control: { type: "text", text: `invalid amounts — try something like "100" for each token` },
    };
  }
  const amountADesired = parseUnits(sanitizedA, tokenA.decimals);
  const amountBDesired = parseUnits(sanitizedB, tokenB.decimals);

  // Inline import of STABLECOIN_ADDRESSES to determine stable-pool routing
  const { STABLECOIN_ADDRESSES } = await import("@/discovery/ai/tokens.js");
  const stable =
    STABLECOIN_ADDRESSES.has(addrA.toLowerCase()) &&
    STABLECOIN_ADDRESSES.has(addrB.toLowerCase());

  const { createPublicClient, http } = await import("viem");
  const { base } = await import("viem/chains");
  const publicClient = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL ?? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY ?? ""}`),
  });

  let amountAMin = BigInt(0);
  let amountBMin = BigInt(0);

  try {
    const [quotedA, quotedB] = await Promise.race([
      publicClient.readContract({
        address: AERODROME_ROUTER,
        abi: AERODROME_ROUTER_LP_ABI,
        functionName: "quoteAddLiquidity",
        args: [addrA, addrB, stable, AERODROME_DEFAULT_FACTORY, amountADesired, amountBDesired],
      }) as Promise<[bigint, bigint, bigint]>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("quote timeout")), 8_000)
      ),
    ]);
    amountAMin = (quotedA * BigInt(9900)) / BigInt(10000);
    amountBMin = (quotedB * BigInt(9900)) / BigInt(10000);
  } catch (err) {
    console.warn("aerodrome quoteAddLiquidity failed — using 0 min amounts:", err instanceof Error ? err.message : String(err));
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);

  const calls: WalletCall[] = [
    buildERC20Approve(addrA, AERODROME_ROUTER, amountADesired),
    buildERC20Approve(addrB, AERODROME_ROUTER, amountBDesired),
    {
      to:    AERODROME_ROUTER,
      value: "0x0",
      data:  encodeFunctionData({
        abi: AERODROME_ROUTER_LP_ABI,
        functionName: "addLiquidity",
        args: [
          addrA, addrB, stable,
          amountADesired, amountBDesired,
          amountAMin, amountBMin,
          walletAddress as Address,
          deadline,
        ],
      }),
      metadata: {
        description: `Add ${args.amountA} ${symbolA} + ${args.amountB} ${symbolB} liquidity on Aerodrome`,
        transactionType: "addLiquidity",
      },
    },
  ];

  return {
    data: { calls, chainId: "0x2105", tokenA: symbolA, tokenB: symbolB, stable },
    control: {
      type: "transaction",
      calls,
      chainId: "0x2105" as `0x${string}`,
      text: `adding ${args.amountA} ${symbolA} + ${args.amountB} ${symbolB} to aerodrome — 3 txs: approve ${symbolA}, approve ${symbolB}, add liquidity`,
    },
  };
}

export async function yield_compare(
  ctx: RespondCtx,
  args: {
    token: string;
    amount?: string;
    isUsd?: boolean;
  },
): Promise<ToolResult> {
  const tokenSymbol = (args.token || "").trim().toUpperCase();
  if (!tokenSymbol) {
    return {
      data: { error: "missing token" },
      control: { type: "text", text: "which token are you trying to deploy?" },
    };
  }

  const asset = await resolveTokenAsync(tokenSymbol).catch(() => null);
  if (!asset) {
    return {
      data: { error: "unknown token" },
      control: { type: "text", text: `i don't recognize ${tokenSymbol} — double-check the symbol` },
    };
  }

  if (asset.address === "ETH") {
    const amountHint = args.amount ? `${args.amount} ` : "";
    return {
      data: { error: "eth not yield-bearing" },
      control: {
        type: "text",
        text: `native ETH doesn't earn yield directly — you'd need to wrap it to WETH first (or swap into USDC/cbBTC). want me to swap your ${amountHint}ETH to WETH so you can earn on it?`,
      },
    };
  }

  const sanitized = args.amount ? sanitizeAmount(args.amount) : null;
  const hasAmount = !!sanitized;

  let amountToken: string | null = sanitized;
  let amountUsd: string | null = args.isUsd && sanitized ? sanitized : null;
  if (hasAmount && args.isUsd && asset.address !== "ETH") {
    const priceUsd = await fetchTokenPriceUsd(asset.address);
    if (!priceUsd) {
      return {
        data: { error: "price unavailable" },
        control: {
          type: "text",
          text: `can't look up the current ${asset.symbol} price to convert your dollar amount — try specifying tokens directly (e.g. "earn 100 ${asset.symbol}")`,
        },
      };
    }
    const tokenAmt = parseFloat(sanitized!) / priceUsd;
    amountToken = tokenAmt.toFixed(Math.min(asset.decimals, 6));
  }

  const moonwellEligible = isMoonwellEarnSymbol(asset.symbol, MOONWELL_MTOKEN_KEY_SET);

  const [moonwellApr, morphoVault, aaveApr] = await Promise.all([
    moonwellEligible
      ? fetchMoonwellSupplyApr(asset.symbol).catch((err) => {
          console.warn("yield_compare moonwell:", err instanceof Error ? err.message : String(err));
          return null;
        })
      : Promise.resolve(null),
    fetchMorphoTopVault(asset.symbol).catch((err) => {
      console.warn("yield_compare morpho:", err instanceof Error ? err.message : String(err));
      return null;
    }),
    fetchAaveV3SupplyApr(asset.symbol).catch((err) => {
      console.warn("yield_compare aave:", err instanceof Error ? err.message : String(err));
      return null;
    }),
  ]);

  type Opt = {
    protocol: "moonwell" | "aerodrome" | "morpho" | "aave";
    apy: number;
    label: string;
  };
  const opts: Opt[] = [];

  if (moonwellApr !== null) {
    opts.push({
      protocol: "moonwell",
      apy: moonwellApr.total,
      label: `Moonwell — ${moonwellApr.total.toFixed(1)}%`,
    });
  }
  if (morphoVault) {
    opts.push({
      protocol: "morpho",
      apy: morphoVault.apy,
      label: `Morpho — ${morphoVault.apy.toFixed(1)}% APY`,
    });
  }
  if (aaveApr !== null) {
    opts.push({
      protocol: "aave",
      apy: aaveApr,
      label: `Aave — ${aaveApr.toFixed(1)}% APY`,
    });
  }

  if (opts.length === 0) {
    return {
      data: { token: asset.symbol },
      control: {
        type: "text",
        text: yieldCompareEmptyMessage(asset.symbol),
      },
    };
  }

  opts.sort((a, b) => b.apy - a.apy);

  if (!hasAmount || !amountToken) {
    return {
      data: {
        token: asset.symbol,
        options: opts.map((o) => ({ protocol: o.protocol, apy: o.apy })),
      },
      control: {
        type: "disambiguate",
        text: `here's where you can earn ${asset.symbol} right now — pick a venue and i'll ask you how much:`,
        token: asset.symbol,
        amountToken: null,
        amountUsd: null,
        options: opts.map((o) => ({ protocol: o.protocol, label: o.label })),
      },
    };
  }

  const finalAmountToken: string = amountToken;
  const displayAmount = amountUsd ? `$${amountUsd}` : `${finalAmountToken} ${asset.symbol}`;
  const intro = opts.length === 1
    ? `earn on ${displayAmount}:`
    : `pick where to earn ${displayAmount}:`;

  return {
    data: {
      token: asset.symbol,
      amountToken: finalAmountToken,
      amountUsd,
      options: opts.map((o) => ({ protocol: o.protocol, apy: o.apy })),
    },
    control: {
      type: "disambiguate",
      text: intro,
      token: asset.symbol,
      amountToken: finalAmountToken,
      amountUsd,
      options: opts.map((o) => ({ protocol: o.protocol, label: o.label })),
    },
  };
}
