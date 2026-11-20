/**
 * Runtime layer over stockCatalog: aliases, Chainlink, pause/staleness.
 * Product “is this on?” decisions live in stockCatalog.ts — not here.
 */

import { createPublicClient, erc20Abi, getAddress, http, isAddress, type Address } from "viem";
import { base } from "viem/chains";

import { resolveBaseRpcUrl } from "@/chain/base-rpc.js";

import {
  getCatalogOffer,
  listCatalog,
  listLaunchableOffers,
  type StockOffer,
} from "@/discovery/doppler/stockCatalog.js";

export const B20_ORACLE_REGISTRY = "0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD" as Address;
export const CHAINLINK_FEED_DECIMALS = 8;
/** B20 asset variant allows 6–18 decimals; Coinbase stocks are 8. */
export const B20_NUMERAIRE_DECIMALS_MIN = 6;
export const B20_NUMERAIRE_DECIMALS_MAX = 18;

const ERC20_DECIMALS_ABI = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

const CHAINLINK_AGGREGATOR_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

const ORACLE_REGISTRY_ABI = [
  {
    type: "function",
    name: "isPaused",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "bool" }],
  },
] as const;

export type StockTokenEntry = {
  symbol: string;
  address: Address;
  decimals: number;
  feedAddress: Address | null;
  name: string;
  listed: boolean;
  launchable: boolean;
  /** Liquid USDC Slipstream pool — spot buy / gift. */
  spotBuyable: boolean;
};

const STOCK_ALIASES: Record<string, string> = {
  AAPL: "AAPLc",
  APPLE: "AAPLc",
  AAPLC: "AAPLc",
  AMZN: "AMZNc",
  AMAZON: "AMZNc",
  AMZNC: "AMZNc",
  ARM: "ARMc",
  ARMC: "ARMc",
  BUD: "BUDc",
  ABINBEV: "BUDc",
  "AB INBEV": "BUDc",
  BUDWEISER: "BUDc",
  BUDC: "BUDc",
  COIN: "COINc",
  COINBASE: "COINc",
  COINC: "COINc",
  CRCL: "CRCLc",
  CIRCLE: "CRCLc",
  CRCLC: "CRCLc",
  GOOGL: "GOOGLc",
  GOOGLE: "GOOGLc",
  ALPHABET: "GOOGLc",
  GOOGLC: "GOOGLc",
  CGOOGL: "GOOGLc",
  HSAI: "HSAIc",
  HESAI: "HSAIc",
  HSAIC: "HSAIc",
  INTC: "INTCc",
  INTEL: "INTCc",
  INTCC: "INTCc",
  LLY: "LLYc",
  LILLY: "LLYc",
  "ELI LILLY": "LLYc",
  ELILILLY: "LLYc",
  LLYC: "LLYc",
  META: "METAc",
  FACEBOOK: "METAc",
  METAC: "METAc",
  MSFT: "MSFTc",
  MICROSOFT: "MSFTc",
  MSFTC: "MSFTc",
  MSTR: "MSTRc",
  MICROSTRATEGY: "MSTRc",
  STRATEGY: "MSTRc",
  MSTRC: "MSTRc",
  MU: "MUc",
  MICRON: "MUc",
  MUC: "MUc",
  NIO: "NIOc",
  NIOC: "NIOc",
  NOK: "NOKc",
  NOKIA: "NOKc",
  NOKC: "NOKc",
  NVDA: "NVDAc",
  NVIDIA: "NVDAc",
  NVDAC: "NVDAc",
  NVO: "NVOc",
  NOVO: "NVOc",
  "NOVO NORDISK": "NVOc",
  NOVONORDISK: "NVOc",
  NVOC: "NVOc",
  PDD: "PDDc",
  PDDC: "PDDc",
  PLTR: "PLTRc",
  PALANTIR: "PLTRc",
  PLTRC: "PLTRc",
  PYPL: "PYPLc",
  PAYPAL: "PYPLc",
  PYPLC: "PYPLc",
  RBLX: "RBLXc",
  ROBLOX: "RBLXc",
  RBLXC: "RBLXc",
  SAN: "SANc",
  SANTANDER: "SANc",
  SANC: "SANc",
  SKHY: "SKHYc",
  HYNIX: "SKHYc",
  "SK HYNIX": "SKHYc",
  SKHYNIX: "SKHYc",
  SKHYC: "SKHYc",
  SNDK: "SNDKc",
  SANDISK: "SNDKc",
  SNDKC: "SNDKc",
  SPCX: "SPCXc",
  SPACEX: "SPCXc",
  SPCXC: "SPCXc",
  TSLA: "TSLAc",
  TESLA: "TSLAc",
  TSLAC: "TSLAc",
  UL: "ULc",
  UNILEVER: "ULc",
  ULC: "ULc",
  VALE: "VALEc",
  VALEC: "VALEc",
};

let cachedMap: Map<string, StockTokenEntry> | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

function asAddress(raw: string): Address | null {
  const trimmed = raw.trim();
  if (!isAddress(trimmed, { strict: false })) return null;
  return getAddress(trimmed);
}

function offerToEntry(offer: StockOffer): StockTokenEntry {
  return {
    symbol: offer.symbol,
    address: getAddress(offer.address),
    decimals: offer.decimals,
    feedAddress: offer.feedAddress ? getAddress(offer.feedAddress) : null,
    name: offer.name,
    listed: offer.listed,
    launchable: offer.launchable,
    spotBuyable: offer.spotBuyable,
  };
}

export function normalizeStockSymbol(raw: string): string {
  const cleaned = raw.trim().replace(/^\$/, "").toUpperCase();
  if (!cleaned) return "";
  return STOCK_ALIASES[cleaned] ?? cleaned;
}

function parseEnvOverride(): StockTokenEntry[] {
  const raw = process.env.STOCK_TOKENS_JSON?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      console.warn("⚠️ STOCK_TOKENS_JSON must be a JSON array — ignoring");
      return [];
    }
    const out: StockTokenEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const symbol = typeof row.symbol === "string" ? normalizeStockSymbol(row.symbol) : "";
      const address = typeof row.address === "string" ? asAddress(row.address) : null;
      const feedAddress =
        typeof row.feedAddress === "string" ? asAddress(row.feedAddress) : null;
      const decimals =
        typeof row.decimals === "number"
          ? row.decimals
          : typeof row.decimals === "string"
            ? Number(row.decimals)
            : Number.NaN;
      if (
        !symbol ||
        !address ||
        !feedAddress ||
        !Number.isInteger(decimals) ||
        decimals < B20_NUMERAIRE_DECIMALS_MIN ||
        decimals > B20_NUMERAIRE_DECIMALS_MAX
      ) {
        console.warn("⚠️ STOCK_TOKENS_JSON entry skipped (invalid symbol/address/feed/decimals):", row);
        continue;
      }
      const catalog = getCatalogOffer(symbol);
      out.push({
        symbol,
        address,
        decimals,
        feedAddress,
        name: typeof row.name === "string" ? row.name : catalog?.name ?? symbol,
        listed: typeof row.listed === "boolean" ? row.listed : catalog?.listed ?? true,
        launchable:
          typeof row.launchable === "boolean"
            ? row.launchable
            : catalog?.launchable ?? false,
        spotBuyable:
          typeof row.spotBuyable === "boolean"
            ? row.spotBuyable
            : catalog?.spotBuyable ?? false,
      });
    }
    return out;
  } catch (err) {
    console.warn("⚠️ STOCK_TOKENS_JSON parse failed:", err);
    return [];
  }
}

export function getStockTokenMap(opts?: { forceReload?: boolean }): Map<string, StockTokenEntry> {
  const now = Date.now();
  if (cachedMap && !opts?.forceReload && now - cachedAt < CACHE_TTL_MS) return cachedMap;
  const map = new Map<string, StockTokenEntry>();
  for (const e of listCatalog()) {
    map.set(e.symbol, offerToEntry(e));
  }
  for (const e of parseEnvOverride()) {
    map.set(e.symbol, e);
  }
  cachedMap = map;
  cachedAt = now;
  return map;
}

export function resetStockTokenCache(): void {
  cachedMap = null;
  cachedAt = 0;
}

export function listStockTokens(): StockTokenEntry[] {
  return [...getStockTokenMap().values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Launchable pairs from the catalog (product switch). */
export function listLaunchableStockTokens(): StockTokenEntry[] {
  return listStockTokens().filter((t) => t.launchable);
}

/** Spot-buyable B20 tokens with liquid USDC Slipstream pools. */
export function listSpotBuyableStockTokens(): StockTokenEntry[] {
  return listStockTokens().filter((t) => t.spotBuyable);
}

/** @deprecated Prefer listLaunchableStockTokens */
export function listTradeableStockTokens(): StockTokenEntry[] {
  return listLaunchableStockTokens();
}

/** Chat/UI name for normies: AAPLc / Apple / AAPL → "Apple stock". */
export function formatStockPlainName(raw: string): string | null {
  const entry = resolveStockToken(raw);
  if (!entry?.name) return null;
  const name = entry.name.trim();
  if (!name) return null;
  return /stock$/i.test(name) ? name : `${name} stock`;
}

export function resolveStockToken(raw: string): StockTokenEntry | null {
  const symbol = normalizeStockSymbol(raw);
  if (!symbol) return null;
  const map = getStockTokenMap();
  if (map.has(symbol)) return map.get(symbol) ?? null;
  const withC = symbol.endsWith("C") ? `${symbol.slice(0, -1)}c` : `${symbol}c`;
  return map.get(withC) ?? null;
}

export function isKnownStockPairCandidate(raw: string): boolean {
  return resolveStockToken(raw) != null;
}

export function isLaunchableStock(raw: string): boolean {
  const entry = resolveStockToken(raw);
  return Boolean(entry?.launchable);
}

/** True when the symbol has a liquid USDC Slipstream pool for spot buy / gift. */
export function isSpotBuyableStock(raw: string): boolean {
  const entry = resolveStockToken(raw);
  return Boolean(entry?.spotBuyable);
}

/** @deprecated Prefer isLaunchableStock */
export function isKnownTradeableStock(raw: string): boolean {
  return isLaunchableStock(raw);
}

function publicClient() {
  return createPublicClient({ chain: base, transport: http(resolveBaseRpcUrl()) });
}

export function isUsEquityMarketHours(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  if (weekday === "Sat" || weekday === "Sun") return false;
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

export type NumerairePriceResult = {
  priceUsd: number;
  updatedAt: Date;
  ageMs: number;
  paused: boolean;
  inMarketHours: boolean;
};

const MIN_TRADEABLE_SUPPLY = 1n;

export async function assertTradeableNumeraire(entry: StockTokenEntry): Promise<void> {
  if (!entry.launchable) {
    const live = listLaunchableOffers()
      .map((t) => t.symbol)
      .join(", ");
    throw new Error(
      `$${entry.symbol} isn't launchable yet — pair against ${live || "a live B20"} instead.`,
    );
  }
  const client = publicClient();
  const supply = await client.readContract({
    address: entry.address,
    abi: erc20Abi,
    functionName: "totalSupply",
  });
  if (supply <= MIN_TRADEABLE_SUPPLY) {
    const live = listLaunchableStockTokens()
      .map((t) => t.symbol)
      .join(", ");
    throw new Error(
      `$${entry.symbol} has no circulating supply yet — a launch against it would be a locked empty pool. pair against ${live || "a live B20"} instead.`,
    );
  }
}

export async function resolveStockNumerairePriceUsd(entry: StockTokenEntry): Promise<number> {
  const result = await resolveStockNumerairePrice(entry);
  return result.priceUsd;
}

export async function resolveStockNumerairePrice(
  entry: StockTokenEntry,
): Promise<NumerairePriceResult> {
  const client = publicClient();
  let paused = false;
  try {
    paused = Boolean(
      await client.readContract({
        address: B20_ORACLE_REGISTRY,
        abi: ORACLE_REGISTRY_ABI,
        functionName: "isPaused",
        args: [entry.address],
      }),
    );
  } catch {
    // Registry pause is best-effort — feed staleness still applies.
  }
  if (paused) {
    throw new Error(
      `$${entry.symbol} Chainlink feed is paused for a corporate action — try again after it resumes.`,
    );
  }
  if (!entry.feedAddress) {
    throw new Error(`$${entry.symbol} has no Chainlink feed`);
  }
  const feedAddress = entry.feedAddress;

  const [round, feedDecimals] = await Promise.all([
    client.readContract({
      address: feedAddress,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "latestRoundData",
    }),
    client
      .readContract({
        address: feedAddress,
        abi: CHAINLINK_AGGREGATOR_ABI,
        functionName: "decimals",
      })
      .catch(() => CHAINLINK_FEED_DECIMALS),
  ]);

  const [roundId, answer, , updatedAtRaw, answeredInRound] = round;
  if (typeof answer !== "bigint" || answer <= 0n) {
    throw new Error(`$${entry.symbol} Chainlink feed returned a non-positive answer`);
  }
  if (roundId === 0n || updatedAtRaw === 0n) {
    throw new Error(`$${entry.symbol} Chainlink feed returned an empty round`);
  }
  if (answeredInRound < roundId) {
    throw new Error(`$${entry.symbol} Chainlink feed answeredInRound is behind roundId`);
  }

  const decimals = Number(feedDecimals);
  if (decimals !== CHAINLINK_FEED_DECIMALS) {
    console.warn(
      `⚠️ ${entry.symbol} feed decimals are ${decimals}, expected ${CHAINLINK_FEED_DECIMALS}`,
    );
  }
  const priceUsd = Number(answer) / 10 ** decimals;
  if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) {
    throw new Error(`$${entry.symbol} feed price is not a finite number`);
  }

  const updatedAtSec = Number(updatedAtRaw);
  const updatedAt = new Date(updatedAtSec * 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  if (updatedAtSec > nowSec + 60) {
    throw new Error(`$${entry.symbol} Chainlink updatedAt is in the future`);
  }
  const ageMs = Math.max(0, Date.now() - updatedAt.getTime());
  const inMarketHours = isUsEquityMarketHours();
  const maxAgeMs = inMarketHours ? 26 * 60 * 60 * 1000 : 96 * 60 * 60 * 1000;
  if (ageMs > maxAgeMs) {
    throw new Error(
      `$${entry.symbol} Chainlink feed is stale (${Math.round(ageMs / 3_600_000)}h old)`,
    );
  }

  return { priceUsd, updatedAt, ageMs, paused, inMarketHours };
}

export async function readTokenDecimals(address: Address): Promise<number> {
  const value = await publicClient().readContract({
    address,
    abi: ERC20_DECIMALS_ABI,
    functionName: "decimals",
  });
  return Number(value);
}

/**
 * Fail launch if catalog decimals do not match the token on-chain.
 * A silent 18-vs-8 mismatch prices the Doppler curve 10^10 too high.
 */
export function assertStockNumeraireDecimals(args: {
  symbol: string;
  catalogDecimals: number;
  onChainDecimals: number;
}): number {
  const { symbol, catalogDecimals, onChainDecimals } = args;
  if (
    !Number.isInteger(onChainDecimals) ||
    onChainDecimals < B20_NUMERAIRE_DECIMALS_MIN ||
    onChainDecimals > B20_NUMERAIRE_DECIMALS_MAX
  ) {
    throw new Error(
      `$${symbol} on-chain decimals ${onChainDecimals} are outside the B20 range ` +
        `${B20_NUMERAIRE_DECIMALS_MIN}–${B20_NUMERAIRE_DECIMALS_MAX}`,
    );
  }
  if (onChainDecimals !== catalogDecimals) {
    throw new Error(
      `$${symbol} catalog decimals are ${catalogDecimals} but the token is ${onChainDecimals} on-chain — ` +
        `refusing to launch with a mis-scaled curve`,
    );
  }
  return onChainDecimals;
}

export async function pinStockNumeraireDecimals(entry: StockTokenEntry): Promise<StockTokenEntry> {
  const onChainDecimals = await readTokenDecimals(entry.address);
  const decimals = assertStockNumeraireDecimals({
    symbol: entry.symbol,
    catalogDecimals: entry.decimals,
    onChainDecimals,
  });
  return { ...entry, decimals };
}
