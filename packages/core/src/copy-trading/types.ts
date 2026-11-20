import type { CopyTradeCtxPayload } from "@/discovery/ai.js";

export type CopyPlatform = "xmtp" | "telegram" | "imessage" | "whatsapp";
export type CopyTradeSignal = CopyTradeCtxPayload;

export type StrategyStatus = "active" | "paused" | "archived";

/**
 * Emitted by the Trade Detection Worker when a tracked trader (leader) makes a
 * copyable on-chain trade. Consumed by the Copy Engine which fans it out to
 * per-follower execution jobs. Carries enough context to be fully replayable.
 */
export interface TradeDetectedEvent {
  /** Leader wallet that made the trade (lowercased). */
  leaderWallet: string;
  /** Originating transaction hash on Base (idempotency anchor). */
  leaderTxHash: string;
  /** Block number the trade landed in. */
  blockNumber: number;
  /** Unix ms timestamp the trade was detected. */
  detectedAt: number;
  /** Reconstructed copyable signal (swap/perp) sized to the leader's trade. */
  signal: CopyTradeSignal;
  /**
   * Leader portfolio value (USD) at detection time, used to convert the
   * leader's absolute trade size into a portfolio percentage.
   */
  leaderPortfolioUsd: number;
  /** USD notional of the leader's trade. */
  tradeUsd: number;
}

/**
 * One unit of work for the Execution Worker: copy a single detected leader
 * trade into a single follower's copy wallet. Idempotency key guarantees a
 * duplicate job can never create a duplicate on-chain trade.
 */
export interface ExecutionJob {
  /** Stable idempotency key: `${strategyId}:${leaderTxHash}`. */
  idempotencyKey: string;
  strategyId: number;
  followerUserKey: string;
  followerPlatform: CopyPlatform;
  leaderWallet: string;
  leaderTxHash: string;
  /** CDP account name of the strategy's dedicated copy wallet. */
  copyWalletName: string;
  copyWalletAddress: string;
  /** Signal re-sized to this follower's proportional allocation. */
  signal: CopyTradeSignal;
  /** Copy notional in USD (post proportional sizing + caps). */
  copyUsd: number;
  maxSlippageBps: number;
}
