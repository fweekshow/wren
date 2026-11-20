import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
  toHex,
  type Address,
} from "viem";
import type { WalletCall } from "@/discovery/ai/types.js";
import {
  BASE_TOKENS,
  fetchTokenPriceUsd,
  resolveToken,
  resolveTokenAsync,
  STABLECOIN_ADDRESSES,
} from "@/discovery/ai/tokens.js";
import {
  assertSwapUsdWithinLimit,
  coerceUsdAmountFromUserMessage,
  normalizeHexValue,
  resolveUsdQuotedSwapAmount,
  usdToTokenAmount,
  WETH_BASE_ADDRESS,
} from "@/discovery/ai/amounts.js";
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
import { applySwapFeeToBuild } from "@/discovery/ai/tools/swapFee.js";

const TRADE_API_BASE = "https://trade-api.gateway.uniswap.org/v1";
const TRADE_API_KEY = process.env.UNISWAP_API_KEY ?? "";
const TRADE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "x-api-key": TRADE_API_KEY,
  "x-permit2-disabled": "true",
};
// Native ETH sentinel for the Trade API (NOT the EeeEeE address).
const ETH_NATIVE_ADDR = "0x0000000000000000000000000000000000000000";

/**
 * Run the Uniswap Trade API 3-step proxy-approval flow:
 *   1. POST /check_approval  → optional ERC-20 approve calldata
 *   2. POST /quote           → routed quote across V2/V3/V4
 *   3. POST /swap            → unsigned swap calldata
 *
 * Returns the calls array ready to drop into wallet_sendCalls, or null when
 * the API has no route / returns an error. Caller falls back to direct
 * SwapRouter02 encoding on null.
 */
async function buildTradeApiSwap(args: {
  fromIsEth: boolean;
  fromAddress: string;
  toAddress: string;
  rawAmountIn: bigint;
  walletAddress: string;
  label: string;
}): Promise<WalletCall[] | null> {
  const { fromIsEth, fromAddress, toAddress, rawAmountIn, walletAddress, label } = args;
  const tokenInParam = fromIsEth ? ETH_NATIVE_ADDR : fromAddress;
  const tokenOutParam = toAddress === "ETH" ? ETH_NATIVE_ADDR : toAddress;
  // The Trade API rejects a non-address swapper. A blank/whitespace/malformed
  // wallet address means we have no signer for this swap — bail so the caller
  // surfaces "wallet not ready" instead of a misleading routing failure.
  const swapper = walletAddress.trim();
  if (!ETH_ADDRESS_RE.test(swapper) || swapper === ETH_NATIVE_ADDR) {
    console.warn(`⚠️ Trade API swap skipped — invalid swapper address: "${walletAddress}"`);
    return null;
  }

  // 1. check_approval — skip for ETH (no ERC-20 to approve)
  let approvalCall: WalletCall | null = null;
  if (!fromIsEth) {
    try {
      const approvalRes = await fetch(`${TRADE_API_BASE}/check_approval`, {
        method: "POST",
        headers: TRADE_HEADERS,
        body: JSON.stringify({
          walletAddress: swapper,
          token: tokenInParam,
          amount: rawAmountIn.toString(),
          chainId: 8453,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (approvalRes.ok) {
        const { approval } = (await approvalRes.json()) as {
          approval: { to: string; data: string; value?: string } | null;
        };
        if (approval?.to && approval?.data) {
          approvalCall = {
            to: approval.to as `0x${string}`,
            data: approval.data as `0x${string}`,
            value: normalizeHexValue(approval.value),
          };
        }
      }
    } catch (err) {
      console.warn("⚠️ Trade API /check_approval failed:", err);
      // Approval check is best-effort — if the swap call later returns 401 we'll fall back.
    }
  }

  // 2. quote
  let quoteData: any;
  try {
    const quoteBody = {
      type: "EXACT_INPUT",
      amount: rawAmountIn.toString(),
      tokenIn: tokenInParam,
      tokenOut: tokenOutParam,
      tokenInChainId: 8453,
      tokenOutChainId: 8453,
      swapper,
      autoSlippage: "DEFAULT",
      protocols: ["V4", "V3", "V2"],
      routingPreference: "BEST_PRICE",
    };
    const quoteRes = await fetch(`${TRADE_API_BASE}/quote`, {
      method: "POST",
      headers: TRADE_HEADERS,
      body: JSON.stringify(quoteBody),
      signal: AbortSignal.timeout(8000),
    });
    if (!quoteRes.ok) {
      const errBody = await quoteRes.text().catch(() => "");
      console.warn(
        `⚠️ Trade API /quote ${quoteRes.status} — body: ${errBody.slice(0, 400)} — req: ${JSON.stringify(quoteBody)}`,
      );
      return null;
    }
    quoteData = await quoteRes.json();
  } catch (err) {
    console.warn("⚠️ Trade API /quote failed:", err);
    return null;
  }

  // 3. swap — spread the entire quote response, drop null permit fields + signature
  const swapBody: Record<string, unknown> = { ...quoteData };
  if (swapBody.permitData == null) delete swapBody.permitData;
  if (swapBody.permitTransaction == null) delete swapBody.permitTransaction;
  delete swapBody.signature;

  try {
    const swapRes = await fetch(`${TRADE_API_BASE}/swap`, {
      method: "POST",
      headers: TRADE_HEADERS,
      body: JSON.stringify(swapBody),
      signal: AbortSignal.timeout(8000),
    });
    if (!swapRes.ok) {
      const errBody = await swapRes.text().catch(() => "");
      console.warn(`⚠️ Trade API /swap ${swapRes.status} — body: ${errBody.slice(0, 400)}`);
      return null;
    }
    const { swap } = (await swapRes.json()) as {
      swap: { to: string; data: string; value?: string };
    };
    if (!swap?.to || !swap?.data) return null;

    const calls: WalletCall[] = [
      ...(approvalCall ? [approvalCall] : []),
      {
        to: swap.to as `0x${string}`,
        data: swap.data as `0x${string}`,
        value: normalizeHexValue(swap.value),
        metadata: { description: label, transactionType: "swap" },
      },
    ];
    return calls;
  } catch (err) {
    console.warn("⚠️ Trade API /swap failed:", err);
    return null;
  }
}

/**
 * Build Uniswap V3 SwapRouter02 calldata for an exact-input single-hop swap.
 * Synchronous fallback — used when the routing API is unavailable.
 * Never throws — returns null if encoding fails.
 */
export function buildDirectSwap(
  fromAddress: string,
  fromSymbol: string,
  fromDecimals: number,
  toAddress: string,
  toSymbol: string,
  humanAmount: string,
  recipientAddress?: string,
): { calls: WalletCall[]; label: string } | null {
  try {
    const tokenInAddr = fromAddress === "ETH" ? WETH_BASE_ADDR : (fromAddress as Address);
    const tokenOutAddr = toAddress === "ETH" ? WETH_BASE_ADDR : (toAddress as Address);
    const rawAmountIn = parseUnits(humanAmount, fromAddress === "ETH" ? 18 : fromDecimals);
    const label = `Swap ${humanAmount} ${fromSymbol} → ${toSymbol}`;
    const recipient = (recipientAddress || "0x0000000000000000000000000000000000000000") as Address;

    const swapData = encodeFunctionData({
      abi: SWAP_ROUTER_ABI_EXPORT,
      functionName: "exactInputSingle",
      args: [{
        tokenIn: tokenInAddr,
        tokenOut: tokenOutAddr,
        fee: 10000, // 1% — works for new/exotic tokens
        recipient,
        amountIn: rawAmountIn,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      }],
    });

    const approveData = encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [SWAP_ROUTER_02_ADDR, rawAmountIn],
    });

    const calls: WalletCall[] = [
      ...(fromAddress !== "ETH"
        ? [{ to: fromAddress as Address, data: approveData, value: "0x0" as `0x${string}` }]
        : []),
      {
        to: SWAP_ROUTER_02_ADDR,
        data: swapData,
        value: fromAddress === "ETH" ? toHex(rawAmountIn) : "0x0",
        metadata: { description: label, transactionType: "swap" },
      },
    ];
    return { calls, label };
  } catch {
    return null;
  }
}

/**
 * Async version: compares Uniswap Trade API, Aerodrome v2, and Slipstream split
 * routes; builds calldata for the best quote. Returns null when no route exists.
 */
export async function buildRoutedSwap(
  fromAddress: string,
  fromSymbol: string,
  fromDecimals: number,
  toAddress: string,
  toSymbol: string,
  humanAmount: string,
  recipientAddress?: string,
): Promise<BestSwapQuoteResult | null> {
  const rawAmountIn = parseUnits(humanAmount, fromAddress === "ETH" ? 18 : fromDecimals);
  const label = `Swap ${humanAmount} ${fromSymbol} → ${toSymbol}`;
  const walletAddress = recipientAddress ?? "";
  const toDecimals = BASE_TOKENS[toSymbol.toUpperCase()]?.decimals ?? 18;

  const best = await getBestSwapQuote({
    fromAddress,
    fromIsEth: fromAddress === "ETH",
    fromDecimals,
    fromSymbol,
    toAddress,
    toSymbol,
    toDecimals,
    rawAmountIn,
    humanAmount,
    walletAddress,
    label,
  });
  if (best) return best;

  return null;
}

// Constants referenced by buildDirectSwap (defined early so they're hoisted before first use)
const SWAP_ROUTER_02_ADDR = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address;
const WETH_BASE_ADDR = "0x4200000000000000000000000000000000000006" as Address;
const SWAP_ROUTER_ABI_EXPORT = [
  {
    name: "exactInputSingle",
    type: "function",
    inputs: [{
      name: "params", type: "tuple",
      components: [
        { name: "tokenIn", type: "address" },
        { name: "tokenOut", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "recipient", type: "address" },
        { name: "amountIn", type: "uint256" },
        { name: "amountOutMinimum", type: "uint256" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
  },
] as const;
const ERC20_APPROVE_ABI = [
  {
    name: "approve", type: "function",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

// LaunchToken, LaunchResult — moved to src/discovery/ai/types.ts.

// ─── Uniswap V3 SwapRouter02 on Base mainnet ─────────────────────────────────

const SWAP_ROUTER_02 = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address;
const WETH_BASE = "0x4200000000000000000000000000000000000006" as Address;

const SWAP_ROUTER_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
  },
] as const;

// ─── Contract ABIs (minimal) ──────────────────────────────────────────────────

export const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    name: "transfer",
    type: "function",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// ---------------------------------------------------------------------------
// Aerodrome contracts (Base mainnet)
// ---------------------------------------------------------------------------

export const AERODROME_ROUTER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" as const satisfies Address;
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const satisfies Address;

const AERODROME_ROUTER_SWAP_ABI = [
  {
    name: "getAmountsOut",
    type: "function",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "routes", type: "tuple[]", components: [
        { name: "from",   type: "address" },
        { name: "to",     type: "address" },
        { name: "stable", type: "bool" },
        { name: "factory", type: "address" },
      ]},
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
    stateMutability: "view",
  },
  {
    name: "swapExactTokensForTokens",
    type: "function",
    inputs: [
      { name: "amountIn",     type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "routes", type: "tuple[]", components: [
        { name: "from",   type: "address" },
        { name: "to",     type: "address" },
        { name: "stable", type: "bool" },
        { name: "factory", type: "address" },
      ]},
      { name: "to",       type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
    stateMutability: "nonpayable",
  },
  {
    name: "swapExactETHForTokens",
    type: "function",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      { name: "routes", type: "tuple[]", components: [
        { name: "from",   type: "address" },
        { name: "to",     type: "address" },
        { name: "stable", type: "bool" },
        { name: "factory", type: "address" },
      ]},
      { name: "to",       type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
    stateMutability: "payable",
  },
  {
    name: "swapExactTokensForETH",
    type: "function",
    inputs: [
      { name: "amountIn",     type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "routes", type: "tuple[]", components: [
        { name: "from",   type: "address" },
        { name: "to",     type: "address" },
        { name: "stable", type: "bool" },
        { name: "factory", type: "address" },
      ]},
      { name: "to",       type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
    stateMutability: "nonpayable",
  },
] as const;

export const AERODROME_ROUTER_LP_ABI = [
  {
    name: "quoteAddLiquidity",
    type: "function",
    inputs: [
      { name: "tokenA",  type: "address" },
      { name: "tokenB",  type: "address" },
      { name: "stable",  type: "bool" },
      { name: "factory", type: "address" },
      { name: "amountADesired", type: "uint256" },
      { name: "amountBDesired", type: "uint256" },
    ],
    outputs: [
      { name: "amountA", type: "uint256" },
      { name: "amountB", type: "uint256" },
      { name: "liquidity", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    name: "addLiquidity",
    type: "function",
    inputs: [
      { name: "tokenA",   type: "address" },
      { name: "tokenB",   type: "address" },
      { name: "stable",   type: "bool" },
      { name: "amountADesired", type: "uint256" },
      { name: "amountBDesired", type: "uint256" },
      { name: "amountAMin",     type: "uint256" },
      { name: "amountBMin",     type: "uint256" },
      { name: "to",       type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [
      { name: "amountA",    type: "uint256" },
      { name: "amountB",    type: "uint256" },
      { name: "liquidity",  type: "uint256" },
    ],
    stateMutability: "nonpayable",
  },
] as const;

// Default Aerodrome factory for standard v2 pools (PoolFactory on Base mainnet).
// Note: full address ends in `...e40Da` — the trailing `a` was missing in an
// earlier version which caused every aerodrome_prepare_swap call to throw an
// invalid-address error and silently fall back to Uniswap.
export const AERODROME_DEFAULT_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as const satisfies Address;
const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SLIPSTREAM_ROUTER_BY_FACTORY = new Map<string, Address>([
  [
    "0xf8f2eb4940cfe7d13603dddd87f123820fc061ef",
    "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F",
  ],
  [
    "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a",
    "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5",
  ],
]);

type AeroV2Route = {
  from: Address;
  to: Address;
  stable: boolean;
  factory: Address;
};

const SLIPSTREAM_POOL_ABI = [
  {
    name: "tickSpacing",
    type: "function",
    inputs: [],
    outputs: [{ type: "int24" }],
    stateMutability: "view",
  },
  {
    name: "factory",
    type: "function",
    inputs: [],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
] as const;

const SLIPSTREAM_ROUTER_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    inputs: [{
      name: "params",
      type: "tuple",
      components: [
        { name: "tokenIn", type: "address" },
        { name: "tokenOut", type: "address" },
        { name: "tickSpacing", type: "int24" },
        { name: "recipient", type: "address" },
        { name: "deadline", type: "uint256" },
        { name: "amountIn", type: "uint256" },
        { name: "amountOutMinimum", type: "uint256" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
  },
] as const;

function aeroV2Route(from: Address, to: Address): AeroV2Route {
  const stable =
    STABLECOIN_ADDRESSES.has(from.toLowerCase()) &&
    STABLECOIN_ADDRESSES.has(to.toLowerCase());
  return { from, to, stable, factory: AERODROME_DEFAULT_FACTORY };
}

/** Aerodrome v2 route candidates — direct hop plus USDC bridge when needed. */
function enumerateAerodromeV2Routes(fromAddr: Address, toAddr: Address): AeroV2Route[][] {
  const configs: AeroV2Route[][] = [[aeroV2Route(fromAddr, toAddr)]];
  const usdc = USDC_BASE.toLowerCase();
  if (
    fromAddr.toLowerCase() !== usdc &&
    toAddr.toLowerCase() !== usdc &&
    fromAddr.toLowerCase() !== toAddr.toLowerCase()
  ) {
    configs.push([aeroV2Route(fromAddr, USDC_BASE), aeroV2Route(USDC_BASE, toAddr)]);
  }
  return configs;
}

async function fetchBestAerodromeV2Quote(
  amountIn: bigint,
  fromAddr: Address,
  toAddr: Address,
): Promise<{ amounts: bigint[]; routes: AeroV2Route[] } | null> {
  const publicClient = await getBasePublicClient();
  let best: { amounts: bigint[]; routes: AeroV2Route[] } | null = null;

  for (const routes of enumerateAerodromeV2Routes(fromAddr, toAddr)) {
    try {
      const amounts = await Promise.race([
        publicClient.readContract({
          address: AERODROME_ROUTER,
          abi: AERODROME_ROUTER_SWAP_ABI,
          functionName: "getAmountsOut",
          args: [amountIn, routes],
        }) as Promise<bigint[]>,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("quote timeout")), 8_000),
        ),
      ]);
      const out = amounts[amounts.length - 1] ?? 0n;
      if (out > 0n && (!best || out > best.amounts[best.amounts.length - 1]!)) {
        best = { amounts, routes };
      }
    } catch {
      // try next route config
    }
  }
  return best;
}

type SlipstreamUsdcPairMeta = {
  poolAddress: Address;
  routerAddress: Address;
  priceUsd: number;
  tickSpacing: number;
};

const slipstreamPairCache = new Map<string, SlipstreamUsdcPairMeta | null>();

/** Pool USD price for a Slipstream USDC pair (null when no liquid pool). */
export async function getSlipstreamUsdcPoolPriceUsd(
  tokenAddress: string,
): Promise<number | null> {
  const meta = await fetchSlipstreamUsdcPairMeta(tokenAddress);
  return meta?.priceUsd ?? null;
}

/** Aerodrome Slipstream pool paired with USDC (e.g. MXNB/USDC CL). */
async function fetchSlipstreamUsdcPairMeta(
  tokenAddress: string,
): Promise<SlipstreamUsdcPairMeta | null> {
  const key = tokenAddress.toLowerCase();
  if (slipstreamPairCache.has(key)) return slipstreamPairCache.get(key)!;

  const usdc = USDC_BASE.toLowerCase();
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) throw new Error(`DexScreener ${res.status}`);
    const json = await res.json() as {
      pairs?: Array<{
        chainId: string;
        dexId: string;
        pairAddress: string;
        priceUsd?: string;
        liquidity?: { usd?: number };
        baseToken: { address: string };
        quoteToken: { address: string };
      }>;
    };
    const candidates = (json.pairs ?? []).filter((p) => {
      if (p.chainId !== "base" || p.dexId !== "aerodrome") return false;
      const addrs = [p.baseToken.address, p.quoteToken.address].map((a) => a.toLowerCase());
      return addrs.includes(key) && addrs.includes(usdc);
    });
    candidates.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const best = candidates[0];
    if (!best?.pairAddress || !best.priceUsd) {
      slipstreamPairCache.set(key, null);
      return null;
    }
    const priceUsd = parseFloat(best.priceUsd);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      slipstreamPairCache.set(key, null);
      return null;
    }
    const publicClient = await getBasePublicClient();
    const poolAddress = best.pairAddress as Address;
    const [tickSpacing, factory] = await Promise.all([
      publicClient.readContract({
        address: poolAddress,
        abi: SLIPSTREAM_POOL_ABI,
        functionName: "tickSpacing",
      }),
      publicClient.readContract({
        address: poolAddress,
        abi: SLIPSTREAM_POOL_ABI,
        functionName: "factory",
      }),
    ]);
    const routerAddress = SLIPSTREAM_ROUTER_BY_FACTORY.get(factory.toLowerCase());
    if (!routerAddress) {
      slipstreamPairCache.set(key, null);
      return null;
    }
    const meta: SlipstreamUsdcPairMeta = {
      poolAddress,
      routerAddress,
      priceUsd,
      tickSpacing: Number(tickSpacing),
    };
    slipstreamPairCache.set(key, meta);
    return meta;
  } catch {
    slipstreamPairCache.set(key, null);
    return null;
  }
}

function estimateSlipstreamUsdcToTokenOut(
  usdcIn: bigint,
  priceUsd: number,
  toDecimals: number,
): bigint {
  const usdcHuman = Number(usdcIn) / 1e6;
  const tokenHuman = usdcHuman / priceUsd;
  const scale = 10 ** toDecimals;
  return BigInt(Math.floor(tokenHuman * scale));
}

/** Estimate USDC output for a token → USDC Slipstream swap using the pool's USD price. */
function estimateSlipstreamTokenToUsdcOut(
  tokenIn: bigint,
  priceUsd: number,
  fromDecimals: number,
): bigint {
  const tokenHuman = Number(tokenIn) / (10 ** fromDecimals);
  const usdcHuman = tokenHuman * priceUsd;
  return BigInt(Math.floor(usdcHuman * 1e6)); // USDC has 6 decimals
}

async function quoteEthToUsdcOutput(args: {
  rawAmountIn: bigint;
  walletAddress: string;
}): Promise<{ out: bigint; dex: "uniswap" | "aerodrome" } | null> {
  const [uniResult, aeroResult] = await Promise.allSettled([
    fetchUniswapQuoteOutput({
      fromIsEth: true,
      fromAddress: "ETH",
      toAddress: USDC_BASE,
      rawAmountIn: args.rawAmountIn,
      walletAddress: args.walletAddress,
    }),
    fetchBestAerodromeV2Quote(args.rawAmountIn, WETH_BASE, USDC_BASE),
  ]);
  const uniOut = uniResult.status === "fulfilled" ? uniResult.value : null;
  const aeroOut =
    aeroResult.status === "fulfilled" && aeroResult.value
      ? aeroResult.value.amounts[aeroResult.value.amounts.length - 1]!
      : null;

  if (uniOut == null && aeroOut == null) return null;
  if (aeroOut != null && (uniOut == null || aeroOut > uniOut)) {
    return { out: aeroOut, dex: "aerodrome" };
  }
  return { out: uniOut!, dex: "uniswap" };
}

async function quoteSplitEthToTokenViaUsdc(args: {
  rawAmountIn: bigint;
  toAddress: string;
  toDecimals: number;
  walletAddress: string;
}): Promise<{
  totalOut: bigint;
  leg1Out: bigint;
  leg2Out: bigint;
  leg1Dex: "uniswap" | "aerodrome";
  tickSpacing: number;
  routerAddress: Address;
} | null> {
  const slipMeta = await fetchSlipstreamUsdcPairMeta(args.toAddress);
  if (!slipMeta) return null;

  const leg1 = await quoteEthToUsdcOutput({
    rawAmountIn: args.rawAmountIn,
    walletAddress: args.walletAddress,
  });
  if (!leg1 || leg1.out <= 0n) return null;

  const leg2Out = estimateSlipstreamUsdcToTokenOut(
    leg1.out,
    slipMeta.priceUsd,
    args.toDecimals,
  );
  if (leg2Out <= 0n) return null;

  return {
    totalOut: leg2Out,
    leg1Out: leg1.out,
    leg2Out,
    leg1Dex: leg1.dex,
    tickSpacing: slipMeta.tickSpacing,
    routerAddress: slipMeta.routerAddress,
  };
}

async function buildSplitEthToTokenViaUsdc(args: {
  rawAmountIn: bigint;
  fromSymbol: string;
  toAddress: string;
  toSymbol: string;
  toDecimals: number;
  humanAmount: string;
  walletAddress: string;
  isUsd?: boolean;
  amountUsd?: string;
}): Promise<{ calls: WalletCall[]; label: string } | null> {
  const quote = await quoteSplitEthToTokenViaUsdc({
    rawAmountIn: args.rawAmountIn,
    toAddress: args.toAddress,
    toDecimals: args.toDecimals,
    walletAddress: args.walletAddress,
  });
  if (!quote) return null;

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const usdNote = args.isUsd && args.amountUsd ? ` ($${args.amountUsd})` : "";
  const leg2In = (quote.leg1Out * 98n) / 100n;
  const leg2Min = (quote.leg2Out * 95n) / 100n;
  const calls: WalletCall[] = [];

  if (quote.leg1Dex === "aerodrome") {
    const leg1Min = (quote.leg1Out * 99n) / 100n;
    const wethToUsdc = [aeroV2Route(WETH_BASE, USDC_BASE)];
    calls.push({
      to: AERODROME_ROUTER,
      value: toHex(args.rawAmountIn),
      data: encodeFunctionData({
        abi: AERODROME_ROUTER_SWAP_ABI,
        functionName: "swapExactETHForTokens",
        args: [leg1Min, wethToUsdc, args.walletAddress as Address, deadline],
      }),
      metadata: { description: "Swap ETH → USDC on Aerodrome", transactionType: "swap" },
    });
  } else {
    const leg1Calls = await buildTradeApiSwap({
      fromIsEth: true,
      fromAddress: "ETH",
      toAddress: USDC_BASE,
      rawAmountIn: args.rawAmountIn,
      walletAddress: args.walletAddress,
      label: "Swap ETH → USDC",
    });
    if (!leg1Calls) return null;
    calls.push(...leg1Calls);
  }

  calls.push(buildERC20Approve(USDC_BASE, quote.routerAddress, leg2In));
  const label = `Swap ${args.humanAmount} ${args.fromSymbol}${usdNote} → ${args.toSymbol} via Aerodrome Slipstream`;
  calls.push({
    to: quote.routerAddress,
    value: "0x0",
    data: encodeFunctionData({
      abi: SLIPSTREAM_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [{
        tokenIn: USDC_BASE,
        tokenOut: args.toAddress as Address,
        tickSpacing: quote.tickSpacing,
        recipient: args.walletAddress as Address,
        deadline,
        amountIn: leg2In,
        amountOutMinimum: leg2Min,
        sqrtPriceLimitX96: 0n,
      }],
    }),
    metadata: { description: label, transactionType: "swap" },
  });
  return { calls, label };
}

export async function buildSlipstreamUsdcToTokenSwap(args: {
  rawAmountIn: bigint;
  toAddress: string;
  toSymbol: string;
  toDecimals: number;
  humanAmount: string;
  fromSymbol: string;
  walletAddress: string;
  isUsd?: boolean;
  amountUsd?: string;
  /** When set, the swap must print at least this many tokens (e.g. exactly 1 share). */
  amountOutMinimum?: bigint;
}): Promise<{ calls: WalletCall[]; label: string; amountOutMinimum: bigint } | null> {
  const slipMeta = await fetchSlipstreamUsdcPairMeta(args.toAddress);
  if (!slipMeta) return null;

  const estimatedOut = estimateSlipstreamUsdcToTokenOut(
    args.rawAmountIn,
    slipMeta.priceUsd,
    args.toDecimals,
  );
  if (estimatedOut <= 0n) return null;

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const usdNote = args.isUsd && args.amountUsd ? ` ($${args.amountUsd})` : "";
  const amountOutMin =
    args.amountOutMinimum != null ? args.amountOutMinimum : (estimatedOut * 95n) / 100n;
  const label = `Swap ${args.humanAmount} ${args.fromSymbol}${usdNote} → ${args.toSymbol} on Aerodrome Slipstream`;

  const calls: WalletCall[] = [
    buildERC20Approve(USDC_BASE, slipMeta.routerAddress, args.rawAmountIn),
    {
      to: slipMeta.routerAddress,
      value: "0x0",
      data: encodeFunctionData({
        abi: SLIPSTREAM_ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [{
          tokenIn: USDC_BASE,
          tokenOut: args.toAddress as Address,
          tickSpacing: slipMeta.tickSpacing,
          recipient: args.walletAddress as Address,
          deadline,
          amountIn: args.rawAmountIn,
          amountOutMinimum: amountOutMin,
          sqrtPriceLimitX96: 0n,
        }],
      }),
      metadata: { description: label, transactionType: "swap" },
    },
  ];
  return { calls, label, amountOutMinimum: amountOutMin };
}

/**
 * Build Aerodrome Slipstream calldata for token → USDC (reverse of buildSlipstreamUsdcToTokenSwap).
 * Used for stablecoins like MXNB whose only liquid pool on Base is a Slipstream CL pool.
 */
async function buildSlipstreamTokenToUsdcSwap(args: {
  rawAmountIn: bigint;
  fromAddress: string;
  fromSymbol: string;
  fromDecimals: number;
  humanAmount: string;
  walletAddress: string;
  isUsd?: boolean;
  amountUsd?: string;
}): Promise<{ calls: WalletCall[]; label: string } | null> {
  const slipMeta = await fetchSlipstreamUsdcPairMeta(args.fromAddress);
  if (!slipMeta) return null;

  const estimatedOut = estimateSlipstreamTokenToUsdcOut(
    args.rawAmountIn,
    slipMeta.priceUsd,
    args.fromDecimals,
  );
  if (estimatedOut <= 0n) return null;

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const usdNote = args.isUsd && args.amountUsd ? ` ($${args.amountUsd})` : "";
  const amountOutMin = (estimatedOut * 95n) / 100n;
  const label = `Swap ${args.humanAmount} ${args.fromSymbol}${usdNote} → USDC on Aerodrome Slipstream`;

  const calls: WalletCall[] = [
    buildERC20Approve(args.fromAddress as Address, slipMeta.routerAddress, args.rawAmountIn),
    {
      to: slipMeta.routerAddress,
      value: "0x0",
      data: encodeFunctionData({
        abi: SLIPSTREAM_ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [{
          tokenIn: args.fromAddress as Address,
          tokenOut: USDC_BASE,
          tickSpacing: slipMeta.tickSpacing,
          recipient: args.walletAddress as Address,
          deadline,
          amountIn: args.rawAmountIn,
          amountOutMinimum: amountOutMin,
          sqrtPriceLimitX96: 0n,
        }],
      }),
      metadata: { description: label, transactionType: "swap" },
    },
  ];
  return { calls, label };
}

const KYBER_NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const KYBER_BASE_API = "https://aggregator-api.kyberswap.com/base/api/v1";

/** KyberSwap aggregator — single-tx routes for tokens without direct Uniswap/Aerodrome pools. */
async function fetchKyberRouteSummary(args: {
  fromIsEth: boolean;
  fromAddress: string;
  toAddress: string;
  rawAmountIn: bigint;
}): Promise<Record<string, unknown> | null> {
  const tokenIn = args.fromIsEth ? KYBER_NATIVE_ETH : args.fromAddress;
  const tokenOut = args.toAddress === "ETH" ? KYBER_NATIVE_ETH : args.toAddress;
  try {
    const url = `${KYBER_BASE_API}/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${args.rawAmountIn}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const json = await res.json() as { data?: { routeSummary?: Record<string, unknown> } };
    const summary = json.data?.routeSummary;
    if (!summary?.amountOut) return null;
    return summary;
  } catch {
    return null;
  }
}

async function fetchKyberQuoteOutput(args: {
  fromIsEth: boolean;
  fromAddress: string;
  toAddress: string;
  rawAmountIn: bigint;
}): Promise<bigint | null> {
  const summary = await fetchKyberRouteSummary(args);
  if (!summary?.amountOut) return null;
  try {
    const out = BigInt(String(summary.amountOut));
    return out > 0n ? out : null;
  } catch {
    return null;
  }
}

async function buildKyberSwap(args: {
  fromIsEth: boolean;
  fromAddress: string;
  toAddress: string;
  rawAmountIn: bigint;
  walletAddress: string;
  label: string;
}): Promise<{ calls: WalletCall[]; label: string } | null> {
  const summary = await fetchKyberRouteSummary({
    fromIsEth: args.fromIsEth,
    fromAddress: args.fromAddress,
    toAddress: args.toAddress,
    rawAmountIn: args.rawAmountIn,
  });
  if (!summary) return null;

  try {
    const buildRes = await fetch(`${KYBER_BASE_API}/route/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routeSummary: summary,
        sender: args.walletAddress,
        recipient: args.walletAddress,
        slippageTolerance: 50,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!buildRes.ok) return null;
    const json = await buildRes.json() as {
      data?: {
        routerAddress?: string;
        data?: string;
        transactionValue?: string;
      };
    };
    const built = json.data;
    if (!built?.routerAddress || !built?.data) return null;

    const swapValue = normalizeHexValue(built.transactionValue);
    const calls: WalletCall[] = [];

    // For ERC-20 inputs the Kyber router needs allowance before it can pull tokens.
    // ETH-native inputs (swapValue > 0) don't require an approval.
    if (!args.fromIsEth) {
      calls.push(buildERC20Approve(
        args.fromAddress as Address,
        built.routerAddress as Address,
        args.rawAmountIn,
      ));
    }

    calls.push({
      to: built.routerAddress as `0x${string}`,
      data: built.data as `0x${string}`,
      value: swapValue,
      metadata: { description: args.label, transactionType: "swap" },
    });
    return { calls, label: args.label };
  } catch {
    return null;
  }
}

/** Build an ERC-20 approve call */
export function buildERC20Approve(token: Address, spender: Address, amount: bigint): WalletCall {
  return {
    to: token,
    value: "0x0",
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, amount] }),
    metadata: { description: `Approve ${spender.slice(0, 8)}… to spend tokens`, transactionType: "approve" },
  };
}

export interface AerodromeRoutedSwapArgs {
  fromAddress: string;
  fromSymbol: string;
  fromDecimals: number;
  toAddress: string;
  toSymbol: string;
  humanAmount: string;
  walletAddress: string;
  isUsd?: boolean;
  amountUsd?: string;
}

/** Build Aerodrome swap calldata and apply the configured service fee exactly once. */
export async function buildAerodromeRoutedSwap(
  args: AerodromeRoutedSwapArgs,
): Promise<{ calls: WalletCall[]; label: string } | null> {
  const grossRawAmount = parseUnits(
    args.humanAmount,
    args.fromSymbol.toUpperCase() === "ETH" ? 18 : args.fromDecimals,
  );
  return applySwapFeeToBuild({
    grossRawAmount,
    fromAddress: args.fromSymbol.toUpperCase() === "ETH" ? "ETH" : args.fromAddress,
    buildMainSwap: (netRawAmount) =>
      buildAerodromeRoutedSwapWithoutFee({
        ...args,
        humanAmount: formatUnits(
          netRawAmount,
          args.fromSymbol.toUpperCase() === "ETH" ? 18 : args.fromDecimals,
        ),
        isUsd: false,
        amountUsd: undefined,
      }),
  });
}

/** Build Aerodrome swap calldata without applying a service fee. */
async function buildAerodromeRoutedSwapWithoutFee(
  args: AerodromeRoutedSwapArgs,
): Promise<{ calls: WalletCall[]; label: string } | null> {
  const walletAddress = args.walletAddress;
  if (!walletAddress || walletAddress === "0x0000000000000000000000000000000000000000") {
    return null;
  }
  const fromSymbol = args.fromSymbol.toUpperCase();
  const toSymbol = args.toSymbol.toUpperCase();
  const isFromETH = fromSymbol === "ETH";
  const isToETH = toSymbol === "ETH";
  const fromAddr = (isFromETH ? WETH_BASE : args.fromAddress) as Address;
  const toAddr = (isToETH ? WETH_BASE : args.toAddress) as Address;

  let sanitized = args.humanAmount;
  if (args.isUsd && args.amountUsd) {
    const priceLookupAddr = isFromETH ? WETH_BASE : args.fromAddress;
    const priceUsd = await fetchTokenPriceUsd(priceLookupAddr);
    if (!priceUsd) return null;
    sanitized = (parseFloat(args.amountUsd) / priceUsd).toFixed(Math.min(args.fromDecimals, 8));
  }

  const amountIn = parseUnits(sanitized, isFromETH ? 18 : args.fromDecimals);
  const usdNote = args.isUsd && args.amountUsd ? ` ($${args.amountUsd})` : "";

  const bestQuote = await fetchBestAerodromeV2Quote(amountIn, fromAddr, toAddr);
  const routes = bestQuote?.routes ?? [aeroV2Route(fromAddr, toAddr)];

  let amountOutMin = BigInt(0);
  if (bestQuote) {
    const out = bestQuote.amounts[bestQuote.amounts.length - 1] ?? 0n;
    amountOutMin = (out * BigInt(9900)) / BigInt(10000);
  }
  if (!bestQuote || amountOutMin === 0n) {
    if (fromAddr === USDC_BASE && !isToETH) {
      return buildSlipstreamUsdcToTokenSwap({
        rawAmountIn: amountIn,
        toAddress: args.toAddress,
        toSymbol: args.toSymbol,
        toDecimals: args.toDecimals,
        humanAmount: sanitized,
        fromSymbol: args.fromSymbol,
        walletAddress,
        isUsd: args.isUsd,
        amountUsd: args.amountUsd,
      });
    }
    return null;
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const calls: WalletCall[] = [];

  if (isFromETH) {
    calls.push({
      to: AERODROME_ROUTER,
      value: toHex(amountIn),
      data: encodeFunctionData({
        abi: AERODROME_ROUTER_SWAP_ABI,
        functionName: "swapExactETHForTokens",
        args: [amountOutMin, routes, walletAddress as Address, deadline],
      }),
      metadata: {
        description: `Swap ${sanitized} ETH${usdNote} → ${toSymbol} on Aerodrome`,
        transactionType: "swap",
      },
    });
  } else if (isToETH) {
    calls.push(buildERC20Approve(fromAddr, AERODROME_ROUTER, amountIn));
    calls.push({
      to: AERODROME_ROUTER,
      value: "0x0",
      data: encodeFunctionData({
        abi: AERODROME_ROUTER_SWAP_ABI,
        functionName: "swapExactTokensForETH",
        args: [amountIn, amountOutMin, routes, walletAddress as Address, deadline],
      }),
      metadata: {
        description: `Swap ${sanitized} ${fromSymbol}${usdNote} → ETH on Aerodrome`,
        transactionType: "swap",
      },
    });
  } else {
    calls.push(buildERC20Approve(fromAddr, AERODROME_ROUTER, amountIn));
    calls.push({
      to: AERODROME_ROUTER,
      value: "0x0",
      data: encodeFunctionData({
        abi: AERODROME_ROUTER_SWAP_ABI,
        functionName: "swapExactTokensForTokens",
        args: [amountIn, amountOutMin, routes, walletAddress as Address, deadline],
      }),
      metadata: {
        description: `Swap ${sanitized} ${fromSymbol}${usdNote} → ${toSymbol} on Aerodrome`,
        transactionType: "swap",
      },
    });
  }

  const label = calls[calls.length - 1]?.metadata?.description ?? `Swap on Aerodrome`;
  return { calls, label };
}

function extractUniswapQuoteOutputAmount(quoteData: unknown): bigint | null {
  if (!quoteData || typeof quoteData !== "object") return null;
  const root = quoteData as Record<string, unknown>;
  const quote = (root.quote ?? root) as Record<string, unknown>;
  const output = quote.output as Record<string, unknown> | undefined;
  const raw = output?.amount ?? quote.amountOut ?? root.amountOut;
  if (raw == null) return null;
  try {
    const n = BigInt(String(raw));
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

/** Uniswap Trade API /quote only — output amount for best-venue comparison. */
async function fetchUniswapQuoteOutput(args: {
  fromIsEth: boolean;
  fromAddress: string;
  toAddress: string;
  rawAmountIn: bigint;
  walletAddress: string;
}): Promise<bigint | null> {
  const { fromIsEth, fromAddress, toAddress, rawAmountIn, walletAddress } = args;
  const tokenInParam = fromIsEth ? ETH_NATIVE_ADDR : fromAddress;
  const tokenOutParam = toAddress === "ETH" ? ETH_NATIVE_ADDR : toAddress;
  // Output-only indicative quote — the zero address is an acceptable swapper, so
  // fall back to it for any blank/whitespace/malformed wallet address.
  const trimmedWallet = walletAddress.trim();
  const swapper = ETH_ADDRESS_RE.test(trimmedWallet) ? trimmedWallet : ETH_NATIVE_ADDR;

  try {
    const quoteBody = {
      type: "EXACT_INPUT",
      amount: rawAmountIn.toString(),
      tokenIn: tokenInParam,
      tokenOut: tokenOutParam,
      tokenInChainId: 8453,
      tokenOutChainId: 8453,
      swapper,
      autoSlippage: "DEFAULT",
      protocols: ["V4", "V3", "V2"],
      routingPreference: "BEST_PRICE",
    };
    const quoteRes = await fetch(`${TRADE_API_BASE}/quote`, {
      method: "POST",
      headers: TRADE_HEADERS,
      body: JSON.stringify(quoteBody),
      signal: AbortSignal.timeout(8000),
    });
    if (!quoteRes.ok) return null;
    const quoteData = await quoteRes.json();
    return extractUniswapQuoteOutputAmount(quoteData);
  } catch {
    return null;
  }
}

async function getBasePublicClient() {
  const { createPublicClient, http } = await import("viem");
  const { base } = await import("viem/chains");
  return createPublicClient({
    chain: base,
    transport: http(
      process.env.BASE_RPC_URL ??
        `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY ?? ""}`,
    ),
  });
}

function aerodromeRoutesForPair(fromAddr: Address, toAddr: Address) {
  return enumerateAerodromeV2Routes(fromAddr, toAddr)[0]!;
}

/** Aerodrome router getAmountsOut — output amount for best-venue comparison. */
async function fetchAerodromeQuoteOutput(args: {
  fromIsEth: boolean;
  fromAddress: string;
  toAddress: string;
  fromSymbol: string;
  toSymbol: string;
  rawAmountIn: bigint;
}): Promise<bigint | null> {
  const fromSymbol = args.fromSymbol.toUpperCase();
  const toSymbol = args.toSymbol.toUpperCase();
  const isFromETH = fromSymbol === "ETH";
  const isToETH = toSymbol === "ETH";
  const fromAddr = (isFromETH ? WETH_ADDRESS : args.fromAddress) as Address;
  const toAddr = (isToETH ? WETH_ADDRESS : args.toAddress) as Address;

  const best = await fetchBestAerodromeV2Quote(args.rawAmountIn, fromAddr, toAddr);
  if (!best) return null;
  const out = best.amounts[best.amounts.length - 1] ?? 0n;
  return out > 0n ? out : null;
}

export interface BestSwapQuoteArgs {
  fromAddress: string;
  fromIsEth: boolean;
  fromDecimals: number;
  fromSymbol: string;
  toAddress: string;
  toSymbol: string;
  toDecimals: number;
  rawAmountIn: bigint;
  humanAmount: string;
  walletAddress: string;
  label: string;
  isUsd?: boolean;
  amountUsd?: string;
}

export type BestSwapQuoteResult = {
  calls: WalletCall[];
  label: string;
  dex: "uniswap" | "aerodrome";
  /** Expected token-out (atomic) from the winning venue quote. */
  rawAmountOut: bigint;
};

/** Build the best available route and apply the configured service fee exactly once. */
export async function getBestSwapQuote(
  args: BestSwapQuoteArgs,
): Promise<BestSwapQuoteResult | null> {
  return applySwapFeeToBuild({
    grossRawAmount: args.rawAmountIn,
    fromAddress: args.fromIsEth ? "ETH" : args.fromAddress,
    buildMainSwap: (netRawAmount) =>
      getBestSwapQuoteWithoutFee({
        ...args,
        rawAmountIn: netRawAmount,
        humanAmount: formatUnits(netRawAmount, args.fromIsEth ? 18 : args.fromDecimals),
        isUsd: false,
        amountUsd: undefined,
      }),
  });
}

/**
 * Query Uniswap Trade API and Aerodrome getAmountsOut in parallel; build calldata
 * for whichever venue returns the larger output (ties favor Uniswap).
 */
async function getBestSwapQuoteWithoutFee(
  args: BestSwapQuoteArgs,
): Promise<BestSwapQuoteResult | null> {
  const walletAddress = args.walletAddress?.trim() ?? "";
  if (!ETH_ADDRESS_RE.test(walletAddress) || walletAddress === ETH_NATIVE_ADDR) {
    return null;
  }

  const usdcLower = USDC_BASE.toLowerCase();
  const isFromUsdc = args.fromAddress.toLowerCase() === usdcLower;
  const isToUsdc = args.toAddress.toLowerCase() === usdcLower;

  const [uniResult, aeroResult, splitResult, slipResult, slipReverseResult, kyberResult] = await Promise.allSettled([
    fetchUniswapQuoteOutput({
      fromIsEth: args.fromIsEth,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      rawAmountIn: args.rawAmountIn,
      walletAddress,
    }),
    fetchAerodromeQuoteOutput({
      fromIsEth: args.fromIsEth,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      fromSymbol: args.fromSymbol,
      toSymbol: args.toSymbol,
      rawAmountIn: args.rawAmountIn,
    }),
    !isToUsdc && args.fromIsEth
      ? quoteSplitEthToTokenViaUsdc({
          rawAmountIn: args.rawAmountIn,
          toAddress: args.toAddress,
          toDecimals: args.toDecimals,
          walletAddress,
        })
      : Promise.resolve(null),
    isFromUsdc && !isToUsdc
      ? (async () => {
          const slipMeta = await fetchSlipstreamUsdcPairMeta(args.toAddress);
          if (!slipMeta) return null;
          const out = estimateSlipstreamUsdcToTokenOut(
            args.rawAmountIn,
            slipMeta.priceUsd,
            args.toDecimals,
          );
          return out > 0n ? out : null;
        })()
      : Promise.resolve(null),
    // Reverse Slipstream path: token → USDC (e.g. MXNB → USDC).
    // The MXNB/USDC pool is Slipstream-only; the V2 Aerodrome router can't reach it,
    // so we must use the Slipstream router's exactInputSingle in the reverse direction.
    isToUsdc && !args.fromIsEth && !isFromUsdc
      ? (async () => {
          const slipMeta = await fetchSlipstreamUsdcPairMeta(args.fromAddress);
          if (!slipMeta) return null;
          const out = estimateSlipstreamTokenToUsdcOut(
            args.rawAmountIn,
            slipMeta.priceUsd,
            args.fromDecimals,
          );
          return out > 0n ? out : null;
        })()
      : Promise.resolve(null),
    fetchKyberQuoteOutput({
      fromIsEth: args.fromIsEth,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      rawAmountIn: args.rawAmountIn,
    }),
  ]);

  const uniOut = uniResult.status === "fulfilled" ? uniResult.value : null;
  const aeroOut = aeroResult.status === "fulfilled" ? aeroResult.value : null;
  const splitOut =
    splitResult.status === "fulfilled" && splitResult.value
      ? splitResult.value.totalOut
      : null;
  const slipOut = slipResult.status === "fulfilled" ? slipResult.value : null;
  const slipReverseOut = slipReverseResult.status === "fulfilled" ? slipReverseResult.value : null;
  const kyberOut = kyberResult.status === "fulfilled" ? kyberResult.value : null;

  type Venue = "uniswap" | "aerodrome" | "split" | "slipstream" | "slipstream-reverse" | "kyber";
  const venueTieRank: Record<Venue, number> = {
    kyber: 5,
    uniswap: 4,
    aerodrome: 3,
    slipstream: 2,
    "slipstream-reverse": 2,
    split: 1,
  };
  const candidates: Array<{ out: bigint; venue: Venue }> = [];
  if (uniOut != null) candidates.push({ out: uniOut, venue: "uniswap" });
  if (aeroOut != null) candidates.push({ out: aeroOut, venue: "aerodrome" });
  if (splitOut != null) candidates.push({ out: splitOut, venue: "split" });
  if (slipOut != null) candidates.push({ out: slipOut, venue: "slipstream" });
  if (slipReverseOut != null) candidates.push({ out: slipReverseOut, venue: "slipstream-reverse" });
  if (kyberOut != null) candidates.push({ out: kyberOut, venue: "kyber" });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.out !== b.out) return a.out > b.out ? -1 : 1;
    return venueTieRank[b.venue] - venueTieRank[a.venue];
  });
  const winner = candidates[0]!;

  if (winner.venue === "kyber") {
    const built = await buildKyberSwap({
      fromIsEth: args.fromIsEth,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      rawAmountIn: args.rawAmountIn,
      walletAddress,
      label: args.label,
    });
    if (built) return { ...built, dex: "uniswap", rawAmountOut: winner.out };
  }

  if (winner.venue === "split") {
    const built = await buildSplitEthToTokenViaUsdc({
      rawAmountIn: args.rawAmountIn,
      fromSymbol: args.fromSymbol,
      toAddress: args.toAddress,
      toSymbol: args.toSymbol,
      toDecimals: args.toDecimals,
      humanAmount: args.humanAmount,
      walletAddress,
      isUsd: args.isUsd,
      amountUsd: args.amountUsd,
    });
    if (built) return { ...built, dex: "aerodrome", rawAmountOut: winner.out };
  }

  if (winner.venue === "slipstream") {
    const built = await buildSlipstreamUsdcToTokenSwap({
      rawAmountIn: args.rawAmountIn,
      toAddress: args.toAddress,
      toSymbol: args.toSymbol,
      toDecimals: args.toDecimals,
      humanAmount: args.humanAmount,
      fromSymbol: args.fromSymbol,
      walletAddress,
      isUsd: args.isUsd,
      amountUsd: args.amountUsd,
    });
    if (built) return { ...built, dex: "aerodrome", rawAmountOut: winner.out };
  }

  if (winner.venue === "slipstream-reverse") {
    const built = await buildSlipstreamTokenToUsdcSwap({
      rawAmountIn: args.rawAmountIn,
      fromAddress: args.fromAddress,
      fromSymbol: args.fromSymbol,
      fromDecimals: args.fromDecimals,
      humanAmount: args.humanAmount,
      walletAddress,
      isUsd: args.isUsd,
      amountUsd: args.amountUsd,
    });
    if (built) return { ...built, dex: "aerodrome", rawAmountOut: winner.out };
  }

  if (winner.venue === "aerodrome") {
    const built = await buildAerodromeRoutedSwapWithoutFee({
      fromAddress: args.fromAddress,
      fromSymbol: args.fromSymbol,
      fromDecimals: args.fromDecimals,
      toAddress: args.toAddress,
      toSymbol: args.toSymbol,
      humanAmount: args.humanAmount,
      walletAddress,
      isUsd: args.isUsd,
      amountUsd: args.amountUsd,
    });
    if (built) return { ...built, dex: "aerodrome", rawAmountOut: winner.out };
  }

  const calls = await buildTradeApiSwap({
    fromIsEth: args.fromIsEth,
    fromAddress: args.fromAddress,
    toAddress: args.toAddress,
    rawAmountIn: args.rawAmountIn,
    walletAddress,
    label: args.label,
  });
  if (calls) return { calls, label: args.label, dex: "uniswap", rawAmountOut: winner.out };

  return null;
}
