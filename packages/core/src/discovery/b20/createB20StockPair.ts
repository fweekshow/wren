/**
 * Encode a native B20 + Uniswap V4 stock-pair launch as wallet_sendCalls.
 * Predicts the B20 address off-chain, then batches create + approve + init + LP.
 * Never submits from a server key.
 */

import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  maxUint256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

import type { WalletCall } from "@basemate/shared";

import {
  resolveStockNumerairePriceUsd,
  resolveStockToken,
  type StockTokenEntry,
} from "@/discovery/doppler/stockRegistry.js";

import {
  B20_FACTORY_ABI,
  IB20_ABI,
  PERMIT2_ABI,
  V4_POOL_MANAGER_ABI,
  V4_POSITION_MANAGER_ABI,
} from "./abis.js";
import {
  B20_ASSET_CREATE_PARAMS_VERSION,
  B20_ASSET_DECIMALS,
  B20_DEFAULT_INITIAL_SUPPLY,
  B20_DEFAULT_LAUNCH_MCAP_USD,
  B20_FACTORY,
  B20_VARIANT_ASSET,
  MINT_ROLE,
  PERMIT2,
  V4_ACTION_MINT_POSITION,
  V4_ACTION_SETTLE_PAIR,
  V4_FEE_MEDIUM,
  V4_POOL_MANAGER,
  V4_POSITION_MANAGER,
  V4_TICK_SPACING_MEDIUM,
  ZERO_ADDRESS,
  b20LpRecipient,
} from "./addresses.js";
import {
  encodeSqrtRatioX96,
  getLiquidityForAmount0,
  getLiquidityForAmount1,
  getTickAtSqrtRatio,
  pickSingleSidedRange,
  tickToSqrtPriceX96,
  usdToTokenRaw,
} from "./math.js";

export type PrepareB20StockPairInput = {
  name: string;
  symbol: string;
  /** ERC-7572 contractURI (HTTPS metadata JSON). */
  contractURI?: string;
  userAddress: Address;
  pairSymbol: string;
  pair?: StockTokenEntry;
  salt?: Hex;
  initialSupply?: bigint;
  launchMcapUsd?: number;
  numerairePriceUsd?: number;
  /** Test override — skip getB20Address RPC. */
  predictedToken?: Address;
};

export type PrepareB20StockPairResult = {
  calls: WalletCall[];
  predictedToken: Address;
  pair: StockTokenEntry;
  numerairePriceUsd: number;
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  salt: Hex;
  chainId: `0x${string}`;
};

export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

function toHexValue(value: bigint): `0x${string}` {
  return `0x${value.toString(16)}` as `0x${string}`;
}

function publicClient() {
  const rpc = process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";
  return createPublicClient({ chain: base, transport: http(rpc) });
}

export function cleanTicker(raw: string): string {
  const clean = raw.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10).toUpperCase();
  if (clean.length < 2) throw new Error("ticker must be 2–10 letters/numbers");
  return clean;
}

export function sortCurrencies(a: Address, b: Address): [Address, Address] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

/** Canonical B20AssetCreateParams blob (version-prefixed). */
export function encodeAssetCreateParams(
  name: string,
  symbol: string,
  initialAdmin: Address,
  decimals = B20_ASSET_DECIMALS,
): Hex {
  return encodeAbiParameters(
    [
      { type: "uint8" },
      { type: "string" },
      { type: "string" },
      { type: "address" },
      { type: "uint8" },
    ],
    [B20_ASSET_CREATE_PARAMS_VERSION, name, symbol, initialAdmin, decimals],
  );
}

export function buildInitCalls(input: {
  userAddress: Address;
  totalSupply: bigint;
  contractURI?: string;
}): Hex[] {
  const calls: Hex[] = [
    encodeFunctionData({
      abi: IB20_ABI,
      functionName: "grantRole",
      args: [MINT_ROLE, input.userAddress],
    }),
    encodeFunctionData({
      abi: IB20_ABI,
      functionName: "updateSupplyCap",
      args: [input.totalSupply],
    }),
    encodeFunctionData({
      abi: IB20_ABI,
      functionName: "mint",
      args: [input.userAddress, input.totalSupply],
    }),
  ];
  if (input.contractURI) {
    calls.push(
      encodeFunctionData({
        abi: IB20_ABI,
        functionName: "updateContractURI",
        args: [input.contractURI],
      }),
    );
  }
  return calls;
}

export function makeLaunchSalt(userAddress: Address, symbol: string, entropy?: string): Hex {
  return keccak256(
    toHex(`${userAddress}:${symbol}:${entropy ?? Date.now().toString()}`),
  );
}

export async function predictB20Address(
  userAddress: Address,
  salt: Hex,
): Promise<Address> {
  return publicClient().readContract({
    address: B20_FACTORY,
    abi: B20_FACTORY_ABI,
    functionName: "getB20Address",
    args: [B20_VARIANT_ASSET, userAddress, salt],
  });
}

function encodeMintPositionParams(input: {
  poolKey: PoolKey;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amount0Max: bigint;
  amount1Max: bigint;
  recipient: Address;
}): Hex {
  return encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "uint24" },
      { type: "int24" },
      { type: "address" },
      { type: "int24" },
      { type: "int24" },
      { type: "uint256" },
      { type: "uint128" },
      { type: "uint128" },
      { type: "address" },
      { type: "bytes" },
    ],
    [
      input.poolKey.currency0,
      input.poolKey.currency1,
      input.poolKey.fee,
      input.poolKey.tickSpacing,
      input.poolKey.hooks,
      input.tickLower,
      input.tickUpper,
      input.liquidity,
      input.amount0Max,
      input.amount1Max,
      input.recipient,
      "0x",
    ],
  );
}

export function buildB20StockPairCalls(input: {
  name: string;
  symbol: string;
  userAddress: Address;
  predictedToken: Address;
  pair: StockTokenEntry;
  salt: Hex;
  totalSupply: bigint;
  launchMcapUsd: number;
  numerairePriceUsd: number;
  contractURI?: string;
  lpRecipient?: Address;
  nowSec?: number;
}): { calls: WalletCall[]; sqrtPriceX96: bigint; tickLower: number; tickUpper: number } {
  const [currency0, currency1] = sortCurrencies(input.predictedToken, input.pair.address);
  const newIsCurrency0 = currency0.toLowerCase() === input.predictedToken.toLowerCase();

  const stockForMcap = usdToTokenRaw(
    input.launchMcapUsd,
    input.numerairePriceUsd,
    input.pair.decimals,
  );

  const amount0Price = newIsCurrency0 ? input.totalSupply : stockForMcap;
  const amount1Price = newIsCurrency0 ? stockForMcap : input.totalSupply;
  const sqrtPriceX96 = encodeSqrtRatioX96(amount1Price, amount0Price);
  const currentTick = getTickAtSqrtRatio(sqrtPriceX96);
  const { tickLower, tickUpper } = pickSingleSidedRange({
    newIsCurrency0,
    currentTick,
  });

  const sqrtLower = tickToSqrtPriceX96(tickLower);
  const sqrtUpper = tickToSqrtPriceX96(tickUpper);
  const liquidity = newIsCurrency0
    ? getLiquidityForAmount0(sqrtPriceX96, sqrtUpper, input.totalSupply)
    : getLiquidityForAmount1(sqrtLower, sqrtPriceX96, input.totalSupply);
  if (liquidity <= 0n) throw new Error("computed zero liquidity for launch range");

  const amount0Max = newIsCurrency0 ? input.totalSupply : 0n;
  const amount1Max = newIsCurrency0 ? 0n : input.totalSupply;
  const lpRecipient = input.lpRecipient ?? b20LpRecipient(input.userAddress);
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const permitExpiry = BigInt(nowSec + 365 * 24 * 60 * 60);
  const deadline = BigInt(nowSec + 24 * 60 * 60);

  const poolKey: PoolKey = {
    currency0,
    currency1,
    fee: V4_FEE_MEDIUM,
    tickSpacing: V4_TICK_SPACING_MEDIUM,
    hooks: ZERO_ADDRESS,
  };

  const unlockData = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [
      concatHex([
        toHex(V4_ACTION_MINT_POSITION, { size: 1 }),
        toHex(V4_ACTION_SETTLE_PAIR, { size: 1 }),
      ]),
      [
        encodeMintPositionParams({
          poolKey,
          tickLower,
          tickUpper,
          liquidity,
          amount0Max,
          amount1Max,
          recipient: lpRecipient,
        }),
        encodeAbiParameters(
          [{ type: "address" }, { type: "address" }],
          [currency0, currency1],
        ),
      ],
    ],
  );

  const createData = encodeFunctionData({
    abi: B20_FACTORY_ABI,
    functionName: "createB20",
    args: [
      B20_VARIANT_ASSET,
      input.salt,
      encodeAssetCreateParams(input.name, input.symbol, input.userAddress),
      buildInitCalls({
        userAddress: input.userAddress,
        totalSupply: input.totalSupply,
        contractURI: input.contractURI,
      }),
    ],
  });

  const calls: WalletCall[] = [
    {
      to: B20_FACTORY,
      data: createData,
      value: "0x0",
      metadata: {
        description: `Create $${input.symbol} (B20)`,
        transactionType: "b20_create",
        tokenSymbol: input.symbol,
        pairSymbol: input.pair.symbol,
      },
    },
    {
      to: input.predictedToken,
      data: encodeFunctionData({
        abi: IB20_ABI,
        functionName: "approve",
        args: [PERMIT2, maxUint256],
      }),
      value: "0x0",
      metadata: {
        description: `Approve Permit2 for $${input.symbol}`,
        transactionType: "b20_approve_permit2",
      },
    },
    {
      to: PERMIT2,
      data: encodeFunctionData({
        abi: PERMIT2_ABI,
        functionName: "approve",
        args: [
          input.predictedToken,
          V4_POSITION_MANAGER,
          (1n << 160n) - 1n,
          permitExpiry,
        ],
      }),
      value: "0x0",
      metadata: {
        description: "Permit Position Manager to pull launch supply",
        transactionType: "permit2_approve",
      },
    },
    {
      to: V4_POOL_MANAGER,
      data: encodeFunctionData({
        abi: V4_POOL_MANAGER_ABI,
        functionName: "initialize",
        args: [poolKey, sqrtPriceX96],
      }),
      value: "0x0",
      metadata: {
        description: `Init $${input.symbol}/$${input.pair.symbol} V4 pool`,
        transactionType: "v4_init",
      },
    },
    {
      to: V4_POSITION_MANAGER,
      data: encodeFunctionData({
        abi: V4_POSITION_MANAGER_ABI,
        functionName: "modifyLiquidities",
        args: [unlockData, deadline],
      }),
      value: "0x0",
      metadata: {
        description: `Seed $${input.symbol} liquidity`,
        transactionType: "v4_liquidity",
      },
    },
  ];

  return { calls, sqrtPriceX96, tickLower, tickUpper };
}

export async function prepareB20StockPairLaunch(
  input: PrepareB20StockPairInput,
): Promise<PrepareB20StockPairResult> {
  const pair = input.pair ?? resolveStockToken(input.pairSymbol);
  if (!pair) {
    throw new Error(
      `unknown stock pair "$${input.pairSymbol}" — configure it in STOCK_TOKENS_JSON`,
    );
  }

  const name = input.name.slice(0, 50);
  const symbol = cleanTicker(input.symbol);
  const totalSupply = input.initialSupply ?? B20_DEFAULT_INITIAL_SUPPLY;
  const launchMcapUsd = input.launchMcapUsd ?? B20_DEFAULT_LAUNCH_MCAP_USD;
  const salt = input.salt ?? makeLaunchSalt(input.userAddress, symbol);

  const numerairePriceUsd =
    input.numerairePriceUsd ?? (await resolveStockNumerairePriceUsd(pair));
  if (!(numerairePriceUsd > 0) || !Number.isFinite(numerairePriceUsd)) {
    throw new Error(`invalid numeraire price for $${pair.symbol}`);
  }

  const predictedToken =
    input.predictedToken ?? (await predictB20Address(input.userAddress, salt));

  const built = buildB20StockPairCalls({
    name,
    symbol,
    userAddress: input.userAddress,
    predictedToken,
    pair,
    salt,
    totalSupply,
    launchMcapUsd,
    numerairePriceUsd,
    contractURI: input.contractURI,
  });

  return {
    calls: built.calls,
    predictedToken,
    pair,
    numerairePriceUsd,
    sqrtPriceX96: built.sqrtPriceX96,
    tickLower: built.tickLower,
    tickUpper: built.tickUpper,
    salt,
    chainId: `0x${base.id.toString(16)}`,
  };
}
