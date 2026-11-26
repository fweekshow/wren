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
 * `spotBuyable` = Aero CL USDC books deep enough that $10k round-trips with
 * under ~2.5% impact. Source of truth: base.org/markets/stocks ("Impact on
 * $10K"). The seeded ~$50k Oct-9 pools (HSAI, NIO, NOK, …) show ~10% impact
 * and stay off, as do registry-only listings with no pool. Re-check that
 * page when Coinbase lists more. COIN's address is not in Coinbase's registry.
 */
export const STOCK_CATALOG: readonly StockOffer[] = [
  {
    symbol: "AAOIc",
    name: "Applied Optoelectronics",
    address: "0xb200000000000000000000cf36D05963A3E2205c",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
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
    symbol: "ADBEc",
    name: "Adobe",
    address: "0xB20000000000000000000034533Ed3961f222Cd4",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "AMDc",
    name: "AMD",
    address: "0xB2000000000000000000000d8Ce462E99ee7A47B",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
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
    symbol: "ANTc",
    name: "Anthropic",
    address: "0xb20000000000000000000016e38FD364d271Ba28",
    feedAddress: "0xeEDc7412E991a3F2BD693eb2aC7fB0F27d4660dA",
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
    spotBuyable: false,
  },
  {
    symbol: "AVGOc",
    name: "Broadcom",
    address: "0xB200000000000000000000Fc737aeA6196aB5a4c",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "BEc",
    name: "Bloom Energy",
    address: "0xb20000000000000000000016f9dfe862feBA122b",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "BRK.Bc",
    name: "Berkshire Hathaway",
    address: "0xb20000000000000000000024170488e788CBbCb4",
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
    spotBuyable: false,
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
    spotBuyable: true,
  },
  {
    symbol: "CRWVc",
    name: "CoreWeave",
    address: "0xB200000000000000000000F111184A74720787E6",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "GMEc",
    name: "GameStop",
    address: "0xb2000000000000000000007790ed6E48e06eD935",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
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
    symbol: "HIMSc",
    name: "Hims & Hers",
    address: "0xB20000000000000000000043a599976181Bcf336",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "HOODc",
    name: "Robinhood",
    address: "0xb2000000000000000000006F944897540579D3f2",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
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
    spotBuyable: false,
  },
  {
    symbol: "INTCc",
    name: "Intel",
    address: "0xB2000000000000000000004AFF16039bA04bdFBc",
    feedAddress: "0xAB657C39bac0D5886250D70849e2E3E008F2EECB",
    decimals: B20_STOCK_DECIMALS,
    listed: false,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "KOc",
    name: "Coca-Cola",
    address: "0xb200000000000000000000ffef181DB6dC5ed6A3",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "LITEc",
    name: "Lumentum",
    address: "0xB200000000000000000000eDA6C2c6F11E0F838f",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
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
    symbol: "MCDc",
    name: "McDonald's",
    address: "0xb200000000000000000000d2f4cf2f7DEBB244BB",
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
    symbol: "MRNAc",
    name: "Moderna",
    address: "0xB200000000000000000000e215e9B76ecBA02468",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "MRVLc",
    name: "Marvell",
    address: "0xB200000000000000000000eC3c4c7395Cc609813",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
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
    symbol: "NFLXc",
    name: "Netflix",
    address: "0xb20000000000000000000058B8c947e44011dFE6",
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
    spotBuyable: false,
  },
  {
    symbol: "NOKc",
    name: "Nokia",
    address: "0xB2000000000000000000005ac674f707E357409c",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: false,
  },
  {
    symbol: "NOWc",
    name: "ServiceNow",
    address: "0xB20000000000000000000082Cd2C7801305808Df",
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
    spotBuyable: false,
  },
  {
    symbol: "ORCLc",
    name: "Oracle",
    address: "0xb200000000000000000000347AFbA223D7B6b63C",
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
    spotBuyable: false,
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
    spotBuyable: false,
  },
  {
    symbol: "RBLXc",
    name: "Roblox",
    address: "0xB2000000000000000000005bd7AE89b9E6189Bb5",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: false,
  },
  {
    symbol: "SANc",
    name: "Santander",
    address: "0xB20000000000000000000017BB66E9301E913A99",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: false,
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
    symbol: "SNOWc",
    name: "Snowflake",
    address: "0xB2000000000000000000004AcDC9A922FCfBCc7f",
    feedAddress: null,
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
    symbol: "TTWOc",
    name: "Take-Two",
    address: "0xB200000000000000000000f720C26062Bc3067Da",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: true,
  },
  {
    symbol: "UBERc",
    name: "Uber",
    address: "0xb200000000000000000000cAE20cb1446462e24c",
    feedAddress: null,
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
    spotBuyable: false,
  },
  {
    symbol: "VALEc",
    name: "Vale",
    address: "0xB20000000000000000000063376b142C0764B489",
    feedAddress: null,
    decimals: B20_STOCK_DECIMALS,
    listed: true,
    launchable: false,
    spotBuyable: false,
  },
  {
    symbol: "WDCc",
    name: "Western Digital",
    address: "0xb2000000000000000000008fde21a1F5c69FeC0b",
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
