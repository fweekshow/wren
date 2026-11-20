/**
 * Curated verified stables for send + Interest surfaces.
 */
import { BASE_TOKENS } from "@/discovery/ai/tokens.js";

export type StableStatus = "verified" | "watch" | "blocked";

export type VerifiedStable = {
  symbol: string;
  name: string;
  peg: string;
  address: string | null;
  decimals: number;
  issuer: string;
  corridorRole: "send" | "receive" | "both" | "reserve";
  status: StableStatus;
  yieldProtocol?: "moonwell" | null;
};

export const VERIFIED_STABLES: VerifiedStable[] = [
  {
    symbol: "USDC",
    name: "USD Coin",
    peg: "USD",
    address: BASE_TOKENS.USDC.address,
    decimals: BASE_TOKENS.USDC.decimals,
    issuer: "Circle",
    corridorRole: "both",
    status: "verified",
    yieldProtocol: "moonwell",
  },
  {
    symbol: "EURC",
    name: "Euro Coin",
    peg: "EUR",
    address: BASE_TOKENS.EURC.address,
    decimals: BASE_TOKENS.EURC.decimals,
    issuer: "Circle",
    corridorRole: "both",
    status: "verified",
    yieldProtocol: null,
  },
  {
    symbol: "MXNB",
    name: "Mexican Peso",
    peg: "MXN",
    address: BASE_TOKENS.MXNB.address,
    decimals: BASE_TOKENS.MXNB.decimals,
    issuer: "Bitso",
    corridorRole: "send",
    status: "verified",
    yieldProtocol: null,
  },
  {
    symbol: "BRZ",
    name: "Brazilian Real",
    peg: "BRL",
    address: BASE_TOKENS.BRZ.address,
    decimals: BASE_TOKENS.BRZ.decimals,
    issuer: "Transfero",
    corridorRole: "send",
    status: "verified",
    yieldProtocol: null,
  },
  {
    symbol: "ZARP",
    name: "South African Rand",
    peg: "ZAR",
    address: BASE_TOKENS.ZARP.address,
    decimals: BASE_TOKENS.ZARP.decimals,
    issuer: "Stablecoin ZA",
    corridorRole: "send",
    status: "verified",
    yieldProtocol: null,
  },
  {
    symbol: "XSGD",
    name: "Singapore Dollar",
    peg: "SGD",
    address: BASE_TOKENS.XSGD.address,
    decimals: BASE_TOKENS.XSGD.decimals,
    issuer: "StraitsX",
    corridorRole: "send",
    status: "verified",
    yieldProtocol: null,
  },
  {
    symbol: "IDRX",
    name: "Indonesia Rupiah",
    peg: "IDR",
    address: BASE_TOKENS.IDRX.address,
    decimals: BASE_TOKENS.IDRX.decimals,
    issuer: "IDRX",
    corridorRole: "send",
    status: "verified",
    yieldProtocol: null,
  },
  {
    symbol: "MYRC",
    name: "Malaysian Ringgit",
    peg: "MYR",
    address: BASE_TOKENS.MYRC.address,
    decimals: BASE_TOKENS.MYRC.decimals,
    issuer: "BLOX",
    corridorRole: "send",
    status: "verified",
    yieldProtocol: null,
  },
  {
    symbol: "AUDD",
    name: "Australian Dollar",
    peg: "AUD",
    address: BASE_TOKENS.AUDD.address,
    decimals: BASE_TOKENS.AUDD.decimals,
    issuer: "Novatti",
    corridorRole: "send",
    status: "verified",
    yieldProtocol: null,
  },
  {
    symbol: "TGBP",
    name: "British Pound",
    peg: "GBP",
    address: BASE_TOKENS.TGBP.address,
    decimals: BASE_TOKENS.TGBP.decimals,
    issuer: "TBV",
    corridorRole: "send",
    status: "verified",
    yieldProtocol: null,
  },
  {
    symbol: "VCHF",
    name: "Swiss Franc",
    peg: "CHF",
    address: BASE_TOKENS.VCHF.address,
    decimals: BASE_TOKENS.VCHF.decimals,
    issuer: "AllUnity",
    corridorRole: "send",
    status: "verified",
    yieldProtocol: null,
  },
  {
    symbol: "SEKAU",
    name: "Swedish Krona",
    peg: "SEK",
    address: BASE_TOKENS.SEKAU.address,
    decimals: BASE_TOKENS.SEKAU.decimals,
    issuer: "AllUnity",
    corridorRole: "send",
    status: "verified",
    yieldProtocol: null,
  },
  {
    symbol: "PHPC",
    name: "Philippine Peso",
    peg: "PHP",
    address: null,
    decimals: 18,
    issuer: "PHPC",
    corridorRole: "receive",
    status: "watch",
    yieldProtocol: null,
  },
  {
    symbol: "JPYC",
    name: "Japanese Yen",
    peg: "JPY",
    address: null,
    decimals: 18,
    issuer: "JPYC",
    corridorRole: "receive",
    status: "watch",
    yieldProtocol: null,
  },
];

export function verifiedStableBySymbol(symbol: string): VerifiedStable | undefined {
  const s = symbol.trim().toUpperCase();
  return VERIFIED_STABLES.find((v) => v.symbol.toUpperCase() === s);
}

export function defaultSendStable(): VerifiedStable {
  return VERIFIED_STABLES[0]!;
}
