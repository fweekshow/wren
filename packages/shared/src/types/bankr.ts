/** Sort mode for Bankr `/discover` launch feeds. */
export type BankrLaunchSort = "trending" | "new" | "mixed" | "mcap";

/** A token returned by the Bankr launch feed. */
export interface LaunchToken {
  name: string;
  symbol: string;
  address: string;
  deployer?: string;
  marketCapUsd?: number;
  createdAt?: string;
  priceChange1h?: number;
  priceChange24h?: number;
  vol1h?: number;
  vol24h?: number;
  txCount24h?: number;
  deployedAt?: string;
}

/** Response from bankr-backend `/launches` (flat list or mixed sections). */
export interface BankrLaunchesResult {
  sort: BankrLaunchSort;
  tokens: LaunchToken[];
  fresh?: LaunchToken[];
  trending?: LaunchToken[];
}

/** Result of a Bankr (Doppler protocol) token deploy. */
export interface LaunchResult {
  ok: boolean;
  /** Deployed ERC-20 contract address on Base. */
  tokenAddress?: string;
  /** Deploy transaction hash — the verifiable proof-of-launch (Basescan /tx/...). */
  txHash?: string;
  /** Uniswap v4 pool ID for the token's bonding curve. */
  poolId?: string;
  error?: string;
  status?: number;
}

/** Arguments accepted by the Bankr deploy endpoint. */
export interface DeployTokenArgs {
  name: string;
  symbol?: string;
  feeRecipient: string;
  description?: string;
  image?: string;
}
