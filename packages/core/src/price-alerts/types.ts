import type {
  AlertDirection,
  AlertMetric,
  AlertTokenSource,
} from "@/discovery/adapters/priceAlert.adapter.js";

export type { AlertDirection, AlertMetric, AlertTokenSource };

/** A token resolved to a concrete price source + identifiers. */
export interface ResolvedToken {
  source: AlertTokenSource;
  /** CoinGecko coin id (e.g. "ethereum"); null for DexScreener tokens. */
  tokenId: string | null;
  /** On-chain contract address; null for CoinGecko-only assets. */
  tokenAddress: string | null;
  /** Chain slug (e.g. "base"); null for CoinGecko-only assets. */
  chainId: string | null;
  symbol: string;
  name: string | null;
}

/** A candidate when a symbol matches more than one token. */
export interface TokenCandidate extends ResolvedToken {
  liquidityUsd: number | null;
}

/** Live market readings for a token. */
export interface TokenQuote {
  priceUsd: number | null;
  marketCapUsd: number | null;
}

/** Output of parsing a natural-language alert request. */
export interface ParsedAlertIntent {
  /** Raw token reference the user typed (symbol or address). */
  tokenQuery: string;
  /** Contract address if the user supplied one. */
  contractAddress: string | null;
  metric: AlertMetric;
  targetValue: number;
  /** null means "infer from the current value at creation time". */
  direction: AlertDirection | null;
}

export type TokenResolution =
  | { kind: "resolved"; token: ResolvedToken; quote: TokenQuote }
  | { kind: "ambiguous"; candidates: TokenCandidate[] }
  | { kind: "unpriced"; token: ResolvedToken }
  | { kind: "not_found" };
