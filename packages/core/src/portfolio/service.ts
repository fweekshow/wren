import { createPublicClient, formatUnits, http, type Address } from "viem";
import { base } from "viem/chains";

import { resolveAllWalletsForUser } from "@/account-linking/index.js";
import { fetchDexScreenerPriceUsd } from "@/price-alerts/providers/dexscreener.js";
import { fetchWalletHoldings } from "@/copy-trading/portfolio/balances.js";
import { UserAdapter } from "@/discovery/adapters/user.adapter.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { resolveBasemateServerWallet } from "@/discovery/strategy/wallet.js";
import {
  getPortfolioSnapshot,
  savePortfolioSnapshot,
} from "./snapshot.js";

import {
  fetchMoonwellDirectSupplies,
  fetchMoonwellVaultSupplies,
  MOONWELL_MTOKEN_ADDRESSES,
  MOONWELL_UNDERLYING_TOKENS,
  MOONWELL_VAULT_ADDRESSES,
  moonwellUnderlyingSymbol,
} from "./moonwell.js";
import type {
  ImessagePortfolioPayload,
  PortfolioCoin,
  PortfolioPerpPosition,
  PortfolioStakingPosition,
} from "./types.js";
import { resolveBaseRpcUrl } from "@/chain/base-rpc.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const MIN_COIN_VALUE_USD = 0.01;
/** Signed-in app dashboard hides dust below $0.01 (except pinned assets below). */
const APP_DASHBOARD_MIN_COIN_VALUE_USD = MIN_COIN_VALUE_USD;
/** Symbols always shown regardless of USD value (core assets users expect). */
const ALWAYS_SHOW_COIN_SYMBOLS = new Set(["ETH", "WETH", "USDC", "BASEMATE"]);
/** The BASEMATE token — always pinned on the dashboard, even at a zero balance. */
const BASEMATE_TOKEN = {
  symbol: "BASEMATE",
  name: "Basemate",
  address: "0x07E61D8a4e197dfC269e90D7ECe1dF0D26702bA3",
};
const RAY = BigInt("1000000000000000000000000000");

const client = createPublicClient({
  chain: base,
  transport: http(resolveBaseRpcUrl()),
});

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

const MORPHO_VAULT_ABI = [
  ...ERC20_ABI,
  {
    name: "convertToAssets",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "assets", type: "uint256" }],
  },
] as const;

const AAVE_DATA_PROVIDER = "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A" as const satisfies Address;
const AAVE_BASE_ASSETS: Record<string, { address: Address; decimals: number }> = {
  USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  CBBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
  WSTETH: { address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", decimals: 18 },
  CBETH: { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18 },
  USDS: { address: "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc", decimals: 18 },
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
  {
    name: "getUserReserveData",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "asset", type: "address" },
      { name: "user", type: "address" },
    ],
    outputs: [
      { name: "currentATokenBalance", type: "uint256" },
      { name: "currentStableDebt", type: "uint256" },
      { name: "currentVariableDebt", type: "uint256" },
      { name: "principalStableDebt", type: "uint256" },
      { name: "scaledVariableDebt", type: "uint256" },
      { name: "stableBorrowRate", type: "uint256" },
      { name: "liquidityRate", type: "uint256" },
      { name: "stableRateLastUpdated", type: "uint40" },
      { name: "usageAsCollateralEnabled", type: "bool" },
    ],
  },
  {
    name: "getReserveTokensAddresses",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "aTokenAddress", type: "address" },
      { name: "stableDebtTokenAddress", type: "address" },
      { name: "variableDebtTokenAddress", type: "address" },
    ],
  },
] as const;

interface MorphoVault {
  address: string;
  name: string;
  assetSymbol: string;
  assetDecimals: number;
  assetAddress: string | null;
  apy: number | null;
}

interface MorphoUserPosition {
  assets?: unknown;
  assetsUsd?: unknown;
  state?: { assets?: unknown; assetsUsd?: unknown };
  vault?: {
    address?: string;
    name?: string;
    symbol?: string;
    avgNetApy?: number | null;
    netApy?: number | null;
    asset?: { symbol?: string; decimals?: number; address?: string | null } | null;
    state?: { netApy?: number | null } | null;
  } | null;
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveNumber(value: unknown): number | null {
  const n = numberOrNull(value);
  return n != null && n > 0 ? n : null;
}

function tradeUsdValue(trade: { sizeUsd?: unknown; collateral?: unknown }): number {
  return positiveNumber(trade.sizeUsd) ?? positiveNumber(trade.collateral) ?? 0;
}

function mapAvantisTrade(
  walletAddress: string,
  trade: {
    pair?: string | null;
    side?: "long" | "short" | null;
    leverage?: number | null;
    collateral?: unknown;
    sizeUsd?: unknown;
    pnlUsd?: unknown;
    takeProfit?: string | null;
    stopLoss?: string | null;
    openPrice?: string | null;
    limitPrice?: string | null;
    pairIndex?: number;
    tradeIndex?: number;
  },
  kind: PortfolioPerpPosition["kind"],
): PortfolioPerpPosition {
  const id = `${walletAddress}:${kind}:${trade.pairIndex}:${trade.tradeIndex}`;
  return {
    id,
    walletAddress,
    kind,
    pair: trade.pair,
    side: trade.side ?? null,
    leverage: trade.leverage ?? null,
    collateralUsd: numberOrNull(trade.collateral),
    sizeUsd: numberOrNull(trade.sizeUsd),
    valueUsd: tradeUsdValue(trade),
    pnlUsd: numberOrNull(trade.pnlUsd),
    takeProfit: trade.takeProfit ?? null,
    stopLoss: trade.stopLoss ?? null,
    openPrice: trade.openPrice ?? null,
    limitPrice: trade.limitPrice ?? null,
    pairIndex: Number.isFinite(trade.pairIndex) ? trade.pairIndex : null,
    tradeIndex: Number.isFinite(trade.tradeIndex) ? trade.tradeIndex : null,
  };
}

async function fetchCoins(
  wallets: string[],
  minValueUsd: number = MIN_COIN_VALUE_USD,
): Promise<PortfolioCoin[]> {
  const rows = await Promise.all(
    wallets.map(async (walletAddress) => {
      // Always fetch at the low dust floor so small ETH/USDC balances are still
      // returned by the upstream provider, then apply the display threshold here.
      const holdings = await fetchWalletHoldings(walletAddress, {
        minValueUsd: MIN_COIN_VALUE_USD,
      });
      return holdings
        .filter(
          (holding) =>
            holding.valueUsd >= minValueUsd ||
            (holding.priceUsd === null && Number(holding.amount) > 0) ||
            ALWAYS_SHOW_COIN_SYMBOLS.has(holding.symbol.toUpperCase()),
        )
        .filter(
          (holding) =>
            !holding.tokenAddress ||
            !MOONWELL_MTOKEN_ADDRESSES.has(holding.tokenAddress.toLowerCase()),
        )
        .map(
          (holding): PortfolioCoin => ({
            id: `${walletAddress}:${holding.tokenAddress ?? "ETH"}`,
            walletAddress,
            symbol: holding.symbol,
            name: holding.name,
            imageUrl: null,
            tokenAddress: holding.tokenAddress,
            amount: holding.amount,
            priceUsd: holding.priceUsd,
            valueUsd: holding.valueUsd,
          }),
        );
    }),
  );
  return rows.flat().sort((a, b) => b.valueUsd - a.valueUsd);
}

async function fetchPerps(_wallets: string[]): Promise<PortfolioPerpPosition[]> {
  return [];
}

async function fetchTokenPriceUsd(address: string | null, symbol: string): Promise<number | null> {
  const normalized = symbol.toUpperCase();
  if (["USDC", "USDBC", "DAI", "USDS", "EURC"].includes(normalized)) return 1;
  if (!address) return null;
  try {
    return await fetchDexScreenerPriceUsd(address, { timeoutMs: 5_000 });
  } catch {
    return null;
  }
}

async function morphoGraphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) throw new Error(`Morpho API ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(json.errors[0]?.message ?? "Morpho API error");
  return json.data as T;
}

export async function fetchMorphoVaults(): Promise<MorphoVault[]> {
  const data = await morphoGraphql<{
    vaults?: {
      items?: Array<{
        address: string;
        name: string;
        asset?: { symbol?: string; decimals?: number; address?: string };
        state?: { netApy?: number };
      }>;
    };
    vaultV2s?: {
      items?: Array<{
        address: string;
        name: string;
        asset?: { symbol?: string; decimals?: number; address?: string };
        netApy?: number;
      }>;
    };
  }>(`query {
    vaults(first: 50, where: { listed: true, chainId_in: [8453] }, orderBy: TotalAssetsUsd, orderDirection: Desc) {
      items { address name asset { symbol decimals address } state { netApy } }
    }
    vaultV2s(first: 100, where: { listed: true, chainId_in: [8453] }, orderBy: TotalAssetsUsd, orderDirection: Desc) {
      items { address name asset { symbol decimals address } netApy }
    }
  }`);

  return [
    ...(data.vaults?.items ?? []).map((vault) => ({
      address: vault.address,
      name: vault.name,
      assetSymbol: vault.asset?.symbol ?? "?",
      assetDecimals: vault.asset?.decimals ?? 18,
      assetAddress: vault.asset?.address ?? null,
      apy: vault.state?.netApy == null ? null : vault.state.netApy * 100,
    })),
    ...(data.vaultV2s?.items ?? []).map((vault) => ({
      address: vault.address,
      name: vault.name,
      assetSymbol: vault.asset?.symbol ?? "?",
      assetDecimals: vault.asset?.decimals ?? 18,
      assetAddress: vault.asset?.address ?? null,
      apy: vault.netApy == null ? null : vault.netApy * 100,
    })),
  ];
}

function formatMorphoAssets(value: unknown, decimals: number): number | null {
  if (value == null) return null;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(formatUnits(BigInt(value), decimals));
  }
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0) {
    return Number(formatUnits(BigInt(value), decimals));
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stakingAssetDecimals(symbol: string, explicit?: number | null): number {
  if (explicit != null && Number.isFinite(explicit)) return explicit;
  const normalized = symbol.toUpperCase();
  return (
    MOONWELL_UNDERLYING_TOKENS[normalized]?.decimals ?? AAVE_BASE_ASSETS[normalized]?.decimals ?? 18
  );
}

function mapMorphoUserPosition(
  walletAddress: string,
  position: MorphoUserPosition,
  kind: "vault" | "vault-v2",
): PortfolioStakingPosition | null {
  const vault = position.vault;
  const address = vault?.address;
  if (!address) return null;
  if (MOONWELL_VAULT_ADDRESSES.has(address.toLowerCase())) return null;

  const asset = vault.asset;
  const assetSymbol = asset?.symbol ?? vault.symbol ?? "?";
  const assetDecimals = asset?.decimals ?? 18;
  const rawAssets = kind === "vault-v2" ? position.assets : position.state?.assets;
  const amount = formatMorphoAssets(rawAssets, assetDecimals);
  if (amount == null || amount <= 0) return null;

  const valueUsd = numberOrNull(
    kind === "vault-v2" ? position.assetsUsd : position.state?.assetsUsd,
  );
  const rawApy = kind === "vault-v2" ? vault.avgNetApy : (vault.state?.netApy ?? vault.netApy);
  const apy = rawApy == null ? null : rawApy * 100;

  return {
    id: `${walletAddress}:morpho:${address.toLowerCase()}`,
    walletAddress,
    protocol: "morpho",
    asset: assetSymbol,
    name: vault.name ?? `Morpho ${assetSymbol}`,
    amount,
    decimals: assetDecimals,
    valueUsd,
    apy,
    healthFactor: null,
  };
}

export async function fetchMorphoUserStaking(
  walletAddress: string,
): Promise<PortfolioStakingPosition[]> {
  const data = await morphoGraphql<{
    userByAddress?: {
      vaultV2Positions?: MorphoUserPosition[];
      vaultPositions?: MorphoUserPosition[];
    } | null;
  }>(
    `query GetUserVaultPositions($address: String!, $chainId: Int!) {
      userByAddress(address: $address, chainId: $chainId) {
        vaultV2Positions {
          assets
          assetsUsd
          vault {
            address
            name
            symbol
            avgNetApy
            asset { symbol decimals address }
          }
        }
        vaultPositions {
          state { assets assetsUsd }
          vault {
            address
            name
            symbol
            asset { symbol decimals address }
            state { netApy }
          }
        }
      }
    }`,
    { address: walletAddress, chainId: 8453 },
  );

  return [
    ...(data.userByAddress?.vaultV2Positions ?? []).map((position) =>
      mapMorphoUserPosition(walletAddress, position, "vault-v2"),
    ),
    ...(data.userByAddress?.vaultPositions ?? []).map((position) =>
      mapMorphoUserPosition(walletAddress, position, "vault"),
    ),
  ].filter((row): row is PortfolioStakingPosition => Boolean(row));
}

async function fetchMorphoVaultScanStaking(
  walletAddress: string,
): Promise<PortfolioStakingPosition[]> {
  const vaults = await fetchMorphoVaults();
  const rows = await Promise.all(
    vaults.map(async (vault): Promise<PortfolioStakingPosition | null> => {
      try {
        if (MOONWELL_VAULT_ADDRESSES.has(vault.address.toLowerCase())) return null;
        const shares = await client.readContract({
          address: vault.address as Address,
          abi: MORPHO_VAULT_ABI,
          functionName: "balanceOf",
          args: [walletAddress as Address],
        });
        if (shares <= 0n) return null;
        const assets = await client.readContract({
          address: vault.address as Address,
          abi: MORPHO_VAULT_ABI,
          functionName: "convertToAssets",
          args: [shares],
        });
        const amount = Number(formatUnits(assets, vault.assetDecimals));
        if (!Number.isFinite(amount) || amount <= 0) return null;
        const priceUsd = await fetchTokenPriceUsd(vault.assetAddress, vault.assetSymbol);
        return {
          id: `${walletAddress}:morpho:${vault.address.toLowerCase()}`,
          walletAddress,
          protocol: "morpho" as const,
          asset: vault.assetSymbol,
          name: vault.name,
          amount,
          decimals: vault.assetDecimals,
          valueUsd: priceUsd == null ? null : amount * priceUsd,
          apy: vault.apy,
          healthFactor: null,
        };
      } catch {
        return null;
      }
    }),
  );
  return rows.filter((row): row is PortfolioStakingPosition => Boolean(row));
}

async function fetchMorphoStaking(walletAddress: string): Promise<PortfolioStakingPosition[]> {
  try {
    return await fetchMorphoUserStaking(walletAddress);
  } catch (err) {
    console.warn("⚠️ portfolio Morpho user positions lookup failed:", err);
    return fetchMorphoVaultScanStaking(walletAddress);
  }
}

function moonwellAmountFields(
  amount: unknown,
  symbol: string,
): { amount: number; decimals: number } {
  const fallbackDecimals = stakingAssetDecimals(symbol);
  if (!amount || typeof amount !== "object") {
    return { amount: 0, decimals: fallbackDecimals };
  }

  const obj = amount as { value?: unknown; formatted?: unknown; decimals?: unknown };
  const decimals =
    typeof obj.decimals === "number" && Number.isFinite(obj.decimals)
      ? obj.decimals
      : fallbackDecimals;

  const formatted = obj.formatted;
  if (typeof formatted === "number" && Number.isFinite(formatted)) {
    return { amount: formatted, decimals };
  }
  if (typeof formatted === "string") {
    const n = Number(formatted);
    if (Number.isFinite(n)) return { amount: n, decimals };
  }

  const value = obj.value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return { amount: Number(formatUnits(BigInt(value), decimals)), decimals };
  }
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    return { amount: Number(formatUnits(BigInt(value), decimals)), decimals };
  }
  if (typeof value === "number") return { amount: value, decimals };
  if (typeof value === "string") {
    const n = Number(value);
    return { amount: Number.isFinite(n) ? n : 0, decimals };
  }
  return { amount: 0, decimals };
}

function moonwellPositionSymbol(pos: unknown): string {
  const market = (pos as { market?: unknown } | null)?.market as
    | Record<string, unknown>
    | undefined;
  const underlying = market?.underlyingToken;
  const candidates = [
    typeof underlying === "object" && underlying
      ? (underlying as Record<string, unknown>).symbol
      : undefined,
    typeof underlying === "string" ? underlying : undefined,
    market?.assetSymbol,
    market?.underlyingSymbol,
    market?.symbol,
    market?.name,
  ];
  const raw = candidates.find((v): v is string => typeof v === "string" && v.length > 0) ?? "?";
  return moonwellUnderlyingSymbol(raw);
}

function upsertMoonwellMarketRow(
  rowsByAsset: Map<string, PortfolioStakingPosition>,
  row: PortfolioStakingPosition,
): void {
  const key = row.asset.toUpperCase();
  const existing = rowsByAsset.get(key);
  if (!existing) {
    rowsByAsset.set(key, row);
    return;
  }
  const existingVal = existing.valueUsd ?? 0;
  const newVal = row.valueUsd ?? 0;
  if (newVal > existingVal) rowsByAsset.set(key, row);
}

export async function fetchMoonwellStaking(
  walletAddress: string,
): Promise<PortfolioStakingPosition[]> {
  const marketRows = new Map<string, PortfolioStakingPosition>();
  const vaultRows: PortfolioStakingPosition[] = [];
  let totalSuppliedUsd = 0;
  let totalBorrowedUsd = 0;
  let totalCollateralUsd = 0;
  let positions: unknown[] = [];

  try {
    const { createMoonwellClient } = await import("@moonwell-fi/moonwell-sdk");
    const sdk = createMoonwellClient({
      networks: { base: { rpcUrls: [process.env.BASE_RPC_URL ?? "https://mainnet.base.org"] } },
    });
    positions = await Promise.race([
      sdk.getUserPositions({ userAddress: walletAddress as `0x${string}`, chainId: 8453 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("moonwell timeout")), 12_000),
      ),
    ]);
  } catch (err) {
    console.warn("⚠️ portfolio Moonwell SDK lookup failed:", err);
  }

  const sdkApyBySymbol = new Map<string, number | null>();
  for (const pos of positions) {
    const symbol = moonwellPositionSymbol(pos);
    const supplyUsd = Number((pos as { suppliedUsd?: unknown }).suppliedUsd ?? 0);
    const borrowUsd = Number((pos as { borrowedUsd?: unknown }).borrowedUsd ?? 0);
    const collateralUsd = Number((pos as { collateralUsd?: unknown }).collateralUsd ?? 0);
    const apy = numberOrNull(
      (pos as { supplyApy?: unknown; netSupplyApy?: unknown }).netSupplyApy ??
        (pos as { supplyApy?: unknown }).supplyApy,
    );
    sdkApyBySymbol.set(symbol, apy);
    totalSuppliedUsd += Number.isFinite(supplyUsd) ? supplyUsd : 0;
    totalBorrowedUsd += Number.isFinite(borrowUsd) ? borrowUsd : 0;
    totalCollateralUsd += Number.isFinite(collateralUsd) ? collateralUsd : 0;
    if (Number.isFinite(supplyUsd) && supplyUsd > 0.001) {
      const { amount, decimals } = moonwellAmountFields(
        (pos as { supplied?: unknown }).supplied,
        symbol,
      );
      upsertMoonwellMarketRow(marketRows, {
        id: `${walletAddress}:moonwell:${symbol}`,
        walletAddress,
        protocol: "moonwell",
        asset: symbol,
        name: `Moonwell ${symbol}`,
        amount,
        decimals,
        valueUsd: supplyUsd,
        apy,
        healthFactor: null,
      });
    }
  }

  const existingSymbols = new Set(marketRows.keys());
  try {
    const directSupplies = await Promise.race([
      fetchMoonwellDirectSupplies(walletAddress as Address),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("moonwell direct timeout")), 12_000),
      ),
    ]);

    for (const supply of directSupplies) {
      const symbol = supply.symbol.toUpperCase();
      if (existingSymbols.has(symbol)) continue;

      const amount = supply.underlyingAmount ?? supply.mTokenBalance;
      if (!Number.isFinite(amount) || amount <= 0) continue;

      const underlying = MOONWELL_UNDERLYING_TOKENS[symbol];
      const priceUsd = await fetchTokenPriceUsd(underlying?.address ?? null, symbol);
      const valueUsd = priceUsd == null ? null : amount * priceUsd;
      if (valueUsd != null) totalSuppliedUsd += valueUsd;

      upsertMoonwellMarketRow(marketRows, {
        id: `${walletAddress}:moonwell:${symbol}`,
        walletAddress,
        protocol: "moonwell",
        asset: symbol,
        name: `Moonwell ${symbol}`,
        amount,
        decimals: stakingAssetDecimals(symbol, underlying?.decimals),
        valueUsd,
        apy: sdkApyBySymbol.get(symbol) ?? null,
        healthFactor: null,
      });
      existingSymbols.add(symbol);
    }
  } catch (err) {
    console.warn("⚠️ portfolio Moonwell direct mToken lookup failed:", err);
  }

  try {
    const vaultSupplies = await Promise.race([
      fetchMoonwellVaultSupplies(walletAddress as Address),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("moonwell vault timeout")), 12_000),
      ),
    ]);

    for (const supply of vaultSupplies) {
      const symbol = supply.symbol.toUpperCase();
      const underlying = MOONWELL_UNDERLYING_TOKENS[symbol];
      const priceUsd = await fetchTokenPriceUsd(underlying?.address ?? null, symbol);
      const valueUsd = priceUsd == null ? null : supply.underlyingAmount * priceUsd;
      if (valueUsd != null) totalSuppliedUsd += valueUsd;

      vaultRows.push({
        id: `${walletAddress}:moonwell-vault:${supply.vaultAddress.toLowerCase()}`,
        walletAddress,
        protocol: "moonwell",
        asset: symbol,
        name: supply.vaultName,
        amount: supply.underlyingAmount,
        decimals: stakingAssetDecimals(symbol, underlying?.decimals),
        valueUsd,
        apy: null,
        healthFactor: null,
      });
    }
  } catch (err) {
    console.warn("⚠️ portfolio Moonwell vault lookup failed:", err);
  }

  const rows = [...marketRows.values(), ...vaultRows];
  const healthFactor =
    totalBorrowedUsd > 0
      ? (totalCollateralUsd > 0 ? totalCollateralUsd : totalSuppliedUsd) / totalBorrowedUsd
      : null;
  return rows.map((row) => (row.id.includes(":moonwell-vault:") ? row : { ...row, healthFactor }));
}

async function fetchAaveStaking(walletAddress: string): Promise<PortfolioStakingPosition[]> {
  const rows = await Promise.all(
    Object.entries(AAVE_BASE_ASSETS).map(
      async ([symbol, asset]): Promise<PortfolioStakingPosition | null> => {
        try {
          const [userReserve, reserve, reserveTokens] = await Promise.all([
            client.readContract({
              address: AAVE_DATA_PROVIDER,
              abi: AAVE_DATA_PROVIDER_ABI,
              functionName: "getUserReserveData",
              args: [asset.address, walletAddress as Address],
            }),
            client.readContract({
              address: AAVE_DATA_PROVIDER,
              abi: AAVE_DATA_PROVIDER_ABI,
              functionName: "getReserveData",
              args: [asset.address],
            }),
            client.readContract({
              address: AAVE_DATA_PROVIDER,
              abi: AAVE_DATA_PROVIDER_ABI,
              functionName: "getReserveTokensAddresses",
              args: [asset.address],
            }),
          ]);
          let balance = userReserve[0] as bigint;
          if (balance <= 0n) {
            const aTokenBalance = await client
              .readContract({
                address: reserveTokens[0] as Address,
                abi: ERC20_ABI,
                functionName: "balanceOf",
                args: [walletAddress as Address],
              })
              .catch(() => 0n);
            balance = aTokenBalance;
          }
          if (balance <= 0n) return null;
          const amount = Number(formatUnits(balance, asset.decimals));
          if (!Number.isFinite(amount) || amount <= 0) return null;
          const priceUsd = await fetchTokenPriceUsd(asset.address, symbol);
          const liquidityRate = reserve[5] as bigint;
          const aprBps = Number((liquidityRate * BigInt(10000)) / RAY);
          const apy = aprBps > 0 ? aprBps / 100 : null;
          return {
            id: `${walletAddress}:aave:${symbol}`,
            walletAddress,
            protocol: "aave" as const,
            asset: symbol,
            name: `Aave ${symbol}`,
            amount,
            decimals: asset.decimals,
            valueUsd: priceUsd == null ? null : amount * priceUsd,
            apy,
            healthFactor: null,
          };
        } catch {
          return null;
        }
      },
    ),
  );
  return rows.filter((row): row is PortfolioStakingPosition => Boolean(row));
}

async function fetchStaking(wallets: string[]): Promise<PortfolioStakingPosition[]> {
  const rows = await Promise.all(
    wallets.map(async (walletAddress) => {
      const [morpho, moonwell, aave] = await Promise.allSettled([
        fetchMorphoStaking(walletAddress),
        fetchMoonwellStaking(walletAddress),
        fetchAaveStaking(walletAddress),
      ]);
      return [morpho, moonwell, aave].flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      );
    }),
  );
  return rows.flat().sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
}

async function assemblePortfolioPayload(input: {
  userId: string;
  serverWallet: string;
  walletList: string[];
  walletLabels: Map<string, string>;
  coinMinValueUsd?: number;
}): Promise<ImessagePortfolioPayload> {
  const { userId, serverWallet, walletList, walletLabels, coinMinValueUsd } = input;
  const errors: ImessagePortfolioPayload["errors"] = [];
  const [coinsResult, perpsResult, stakingResult] = await Promise.allSettled([
    fetchCoins(walletList, coinMinValueUsd),
    fetchPerps(walletList),
    fetchStaking(walletList),
  ]);

  const coins = coinsResult.status === "fulfilled" ? coinsResult.value : [];
  const perpetuals = perpsResult.status === "fulfilled" ? perpsResult.value : [];
  const staking = stakingResult.status === "fulfilled" ? stakingResult.value : [];

  if (coinsResult.status === "rejected") {
    console.warn("⚠️ portfolio coin fetch failed:", coinsResult.reason);
    errors.push({ section: "coins", message: String(coinsResult.reason) });
  }
  if (perpsResult.status === "rejected") {
    console.warn("⚠️ portfolio perp fetch failed:", perpsResult.reason);
    errors.push({ section: "perpetuals", message: String(perpsResult.reason) });
  }
  if (stakingResult.status === "rejected") {
    console.warn("⚠️ portfolio staking fetch failed:", stakingResult.reason);
    errors.push({ section: "staking", message: String(stakingResult.reason) });
  }

  const coinsUsd = coins.reduce((sum, coin) => sum + coin.valueUsd, 0);
  const perpsUsd = perpetuals.reduce((sum, position) => sum + position.valueUsd, 0);
  const stakingUsd = staking.reduce((sum, position) => sum + (position.valueUsd ?? 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    user: {
      id: userId,
      wallets: walletList,
      walletLabels: Object.fromEntries(walletLabels),
      serverWallet,
    },
    totals: {
      coinsUsd,
      perpsUsd,
      stakingUsd,
      totalUsd: coinsUsd + perpsUsd + stakingUsd,
    },
    coins,
    perpetuals,
    staking,
    errors,
  };
}

export async function buildImessagePortfolio(
  senderId: string,
): Promise<ImessagePortfolioPayload | null> {
  let embeddedAddress: string | null = null;
  try {
    const embedded = await WalletAdapter.getEmbeddedWallet(senderId);
    if (
      embedded?.address &&
      ADDRESS_RE.test(embedded.address) &&
      embedded.address !== ZERO_ADDRESS
    ) {
      embeddedAddress = embedded.address.toLowerCase();
    }
  } catch (err) {
    console.warn("⚠️ portfolio embedded wallet lookup failed:", err);
  }

  if (!embeddedAddress) return null;

  return assemblePortfolioPayload({
    userId: senderId,
    serverWallet: embeddedAddress,
    walletList: [embeddedAddress],
    walletLabels: new Map([[embeddedAddress, "Basemate account"]]),
  });
}

/** XMTP / Base App portfolio — inbox id + linked wallets + Basemate perp wallet. */
export async function buildXmtpPortfolio(
  inboxId: string,
  primaryWallet?: string | null,
): Promise<ImessagePortfolioPayload | null> {
  const selfWallet =
    (primaryWallet && primaryWallet !== ZERO_ADDRESS ? primaryWallet.toLowerCase() : null) ??
    (await UserAdapter.getWalletAddress(inboxId));
  if (!selfWallet) return null;

  const wallets = new Set(await resolveAllWalletsForUser("xmtp", inboxId, selfWallet));
  const walletLabels = new Map<string, string>();
  walletLabels.set(selfWallet, "Main wallet");

  const serverWallet = await resolveBasemateServerWallet("xmtp", inboxId).catch(() => null);
  if (serverWallet?.walletAddress) {
    const perp = serverWallet.walletAddress.toLowerCase();
    wallets.add(perp);
    walletLabels.set(perp, "Perp wallet");
  }

  const walletList = [...wallets];
  for (const walletAddress of walletList) {
    if (!walletLabels.has(walletAddress)) walletLabels.set(walletAddress, "Linked wallet");
  }

  return assemblePortfolioPayload({
    userId: inboxId,
    serverWallet: serverWallet?.walletAddress ?? selfWallet,
    walletList,
    walletLabels,
  });
}

/** Resolve portfolio for API / signed links — iMessage sender id or XMTP inbox id. */
export async function buildPortfolioForUser(
  userId: string,
): Promise<ImessagePortfolioPayload | null> {
  const imessage = await buildImessagePortfolio(userId);
  if (imessage) return imessage;
  return buildXmtpPortfolio(userId);
}

/**
 * Signed-in app dashboard (basemate.app) portfolio — the Basemate embedded
 * wallet ONLY. Like buildImessagePortfolio, this deliberately skips every
 * linked wallet so only the user's Basemate account is shown. Dust below $0.01 is
 * hidden except pinned core assets (ETH/USDC/BASEMATE).
 */
const DASHBOARD_REFRESH_MS = 60_000;
const dashboardRefreshInFlight = new Map<string, Promise<ImessagePortfolioPayload>>();

function pinBasemate(payload: ImessagePortfolioPayload, embeddedAddress: string): ImessagePortfolioPayload {
  const hasBasemate = payload.coins.some(
    (coin) => coin.symbol.toUpperCase() === BASEMATE_TOKEN.symbol,
  );
  if (hasBasemate) return payload;
  payload.coins.unshift({
    id: `${embeddedAddress}:${BASEMATE_TOKEN.address.toLowerCase()}`,
    walletAddress: embeddedAddress,
    symbol: BASEMATE_TOKEN.symbol,
    name: BASEMATE_TOKEN.name,
    imageUrl: null,
    tokenAddress: BASEMATE_TOKEN.address.toLowerCase(),
    amount: "0",
    priceUsd: null,
    valueUsd: 0,
  });
  return payload;
}


async function refreshDashboardPortfolio(
  senderId: string,
  embeddedAddress: string,
): Promise<ImessagePortfolioPayload> {
  const assembled = await assemblePortfolioPayload({
    userId: senderId,
    serverWallet: embeddedAddress,
    walletList: [embeddedAddress],
    walletLabels: new Map([[embeddedAddress, "Basemate account"]]),
    coinMinValueUsd: APP_DASHBOARD_MIN_COIN_VALUE_USD,
  });
  const payload = pinBasemate(
    assembled,
    embeddedAddress,
  );
  await savePortfolioSnapshot(senderId, payload);
  return payload;
}

export async function buildPortfolioForAppDashboard(
  senderId: string,
): Promise<ImessagePortfolioPayload | null> {
  let embeddedAddress: string | null = null;
  try {
    const embedded = await WalletAdapter.getEmbeddedWallet(senderId);
    if (
      embedded?.address &&
      ADDRESS_RE.test(embedded.address) &&
      embedded.address !== ZERO_ADDRESS
    ) {
      embeddedAddress = embedded.address.toLowerCase();
    }
  } catch (err) {
    console.warn("⚠️ dashboard portfolio embedded wallet lookup failed:", err);
  }
  if (!embeddedAddress) return null;

  const snapshot = await getPortfolioSnapshot(senderId);
  if (snapshot) {
    const stale = Date.now() - snapshot.at.getTime() > DASHBOARD_REFRESH_MS;
    if (!stale) return snapshot.payload;

    let refresh = dashboardRefreshInFlight.get(senderId);
    if (!refresh) {
      refresh = refreshDashboardPortfolio(senderId, embeddedAddress).finally(() =>
        dashboardRefreshInFlight.delete(senderId),
      );
      dashboardRefreshInFlight.set(senderId, refresh);
    }
    try {
      return await refresh;
    } catch (err) {
      console.warn("⚠️ dashboard portfolio refresh failed; serving stale snapshot:", err);
      return snapshot.payload;
    }
  }

  return refreshDashboardPortfolio(senderId, embeddedAddress);
}
