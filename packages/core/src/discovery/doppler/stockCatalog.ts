/**
 * Single source of truth for Coinbase B20 offers on iStonks.
 *
 * Flip `launchable` when a market exists. Deploy the agent — chat, prepare,
 * and the site all read from here. Do not hardcode tickers in prompts.
 *
 * Addresses and feeds:
 * https://docs.base.org/specifications/b20/tokenized-stocks-on-base
 */

import { getAddress, type Address } from "viem";

/**
 * Coinbase B20 equity tokens are 8 decimals. Passing 18 into Doppler
 * `withCurves({ numeraireDecimals })` prices the curve 10^10 too high.
 */
export const B20_STOCK_DECIMALS = 8;

export type StockOffer = {
  /** Display ticker with the `c` suffix (AAPLc). */
  symbol: string;
  name: string;
  address: Address;
  /** Chainlink proxy. Null when Coinbase has not published a feed; quotes use the pool. */
  feedAddress: Address | null;
  decimals: number;
  /** On the official Base product list (base.org/stocks). */
  listed: boolean;
  /** We will pair Doppler launches against this. */
  launchable: boolean;
  /**
   * Liquid Aerodrome Slipstream USDC pool exists — user can spot-buy / gift.
   * Independent of `launchable` (iStonks pairs).
   */
  spotBuyable: boolean;
};

/**
 * Product catalog. Edit `launchable` to open/close a pair — nothing else.
 * `spotBuyable` = Aerodrome Slipstream USDC books deep enough to fill a send
 * (about $20k+). COIN / CRCL / INTC stay off. Thin books stay off.
 */
export const STOCK_CATALOG: readonly StockOffer[] = [
  {
    symbol: "AAPLc",
    name: "Apple",
    address: "0xb200000000000000000000C2e324d24d7eEcd1fb",
    feedAddress: "0x787f13dEa48Db0897CbCDD985de77809D837F988",
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: true,
    spotBuyable: true,
  },
  {
    symbol: "AMZNc",
    name: "Amazon",
    address: "0xb200000000000000000000d9192b6B456483C2E8",
    feedAddress: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295",
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "ARMc",
    name: "Arm",
    address: "0xB20000000000000000000026215D755356E5043f",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "BUDc",
    name: "AB InBev",
    address: "0xB200000000000000000000c36ce081Dd09e86cA2",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "COINc",
    name: "Coinbase",
    address: "0xb200000000000000000000c85a31389D71F3ecfb",
    feedAddress: "0x408e44f504A7371a345F03a73dDC96A4b48e8aa7",
    decimals: B20_STOCK_DECIMALS,
    listed: false,
    launchable: false,
    spotBuyable: false,
  },
  {
    symbol: "CRCLc",
    name: "Circle",
    address: "0xB20000000000000000000019f6E7C675b73C2e4D",
    feedAddress: "0x0231cF2635D1E17bB5c2462cc7504Ba1fBd61f33",
    decimals: B20_STOCK_DECIMALS,
    listed: false,
    launchable: false,
    spotBuyable: false,
  },
  {
    symbol: "GOOGLc",
    name: "Alphabet",
    address: "0xb2000000000000000000002D0BA3164cc74f58B7",
    feedAddress: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2",
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: true,
    spotBuyable: true,
  },
  {
    symbol: "HSAIc",
    name: "Hesai",
    address: "0xb200000000000000000000f3049F4aa834b23b64",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "INTCc",
    name: "Intel",
    address: "0xB2000000000000000000004AFF16039bA04bdFBc",
    feedAddress: "0xAB657C39bac0D5886250D70849e2E3E008F2EECB",
    decimals: B20_STOCK_DECIMALS,
    listed: false,
    launchable: false,
    spotBuyable: false,
  },
  {
    symbol: "LLYc",
    name: "Eli Lilly",
    address: "0xB200000000000000000000f1a0F91e34892E4718",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "METAc",
    name: "Meta",
    address: "0xb2000000000000000000008bC8786B856E61707C",
    feedAddress: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D",
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: true,
    spotBuyable: true,
  },
  {
    symbol: "MSFTc",
    name: "Microsoft",
    address: "0xB200000000000000000000Ab99cFa739E253872B",
    feedAddress: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c",
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "MSTRc",
    name: "Strategy",
    address: "0xb2000000000000000000004884b426556b92883d",
    feedAddress: "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a",
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "MUc",
    name: "Micron",
    address: "0xb200000000000000000000Fd2f87532B90095211",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "NIOc",
    name: "NIO",
    address: "0xb2000000000000000000002D2B5dc53c61f1bA06",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "NOKc",
    name: "Nokia",
    address: "0xB2000000000000000000005ac674f707E357409c",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "NVDAc",
    name: "NVIDIA",
    address: "0xb20000000000000000000078ee7ce2fE4908108C",
    feedAddress: "0x04689a41629776563E6822F76f2e57D148d28513",
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: true,
    spotBuyable: true,
  },
  {
    symbol: "NVOc",
    name: "Novo Nordisk",
    address: "0xb2000000000000000000008D5328e9208773dC58",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "PDDc",
    name: "PDD",
    address: "0xB200000000000000000000c8A7223510467D8563",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "PLTRc",
    name: "Palantir",
    address: "0xb2000000000000000000007d16372840dF4dAbbe",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "PYPLc",
    name: "PayPal",
    address: "0xb200000000000000000000450ad3abE5d4846c6E",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "RBLXc",
    name: "Roblox",
    address: "0xB2000000000000000000005bd7AE89b9E6189Bb5",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "SANc",
    name: "Santander",
    address: "0xB20000000000000000000017BB66E9301E913A99",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "SKHYc",
    name: "SK hynix",
    address: "0xb200000000000000000000187f7071D6E321a7d2",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "SNDKc",
    name: "SanDisk",
    address: "0xb200000000000000000000397293Cb8cda9a10c5",
    feedAddress: "0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA",
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "SPCXc",
    name: "SpaceX",
    address: "0xb2000000000000000000007b9fcbd005511aCBd5",
    feedAddress: "0x6A634B235903C4ad6376892180d6fF8612e3Fa68",
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "TSLAc",
    name: "Tesla",
    address: "0xb2000000000000000000001e800a7f5189430cD0",
    feedAddress: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4",
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "ULc",
    name: "Unilever",
    address: "0xB200000000000000000000349ef3Aa93a0897476",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "VALEc",
    name: "Vale",
    address: "0xB20000000000000000000063376b142C0764B489",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
] as const;

export function listCatalog(): StockOffer[] {
  return STOCK_CATALOG.map((e) => ({
    ...e,
    address: getAddress(e.address),
    feedAddress: e.feedAddress ? getAddress(e.feedAddress) : null,
  }));
}

export function listLaunchableOffers(): StockOffer[] {
  return listCatalog().filter((e) => e.launchable);
}

/** Offers with a liquid USDC Slipstream pool (spot buy / gift). */
export function listSpotBuyableOffers(): StockOffer[] {
  return listCatalog().filter((e) => e.spotBuyable);
}

export function getCatalogOffer(symbol: string): StockOffer | null {
  const key = symbol.trim();
  return listCatalog().find((e) => e.symbol === key) ?? null;
}

export function formatLaunchableSymbols(): string {
  const live = listLaunchableOffers().map((e) => e.symbol);
  return live.length > 0 ? live.join(", ") : "(none configured)";
}

export function formatSpotBuyableSymbols(): string {
  const live = listSpotBuyableOffers().map((e) => e.symbol);
  return live.length > 0 ? live.join(", ") : "(none configured)";
}

/** "Apple (AAPL), Eli Lilly (LLY), …" for prompts and tool descriptions. */
export function formatSpotBuyableForPrompt(): string {
  return listSpotBuyableOffers()
    .map((e) => `${e.name} (${e.symbol.replace(/c$/, "")})`)
    .join(", ");
}

/** Plain names for “try Apple, …” errors. Stays in sync with `spotBuyable`. */
export function formatSpotBuyableNames(): string {
  const names = listSpotBuyableOffers().map((e) => e.name);
  if (names.length === 0) return "a listed stock";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}
