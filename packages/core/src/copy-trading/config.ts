import "@/load-env.js";
import process from "node:process";

/**
 * Copy-trading configuration. All values are env-overridable so the feature can
 * be tuned per deployment without code changes. Sensible production defaults are
 * provided so the module boots even when only REDIS_URL is set.
 */
export interface CopyTradingConfig {
  /** Redis connection string for BullMQ. */
  redisUrl: string;
  /** Master switch — false disables all copy-trading workers/queues. */
  enabled: boolean;
  /** Alchemy API key used for Address Activity webhooks + balance discovery. */
  alchemyApiKey: string;
  /** Alchemy Notify auth token (for registering webhook addresses via API). */
  alchemyAuthToken: string;
  /** The Alchemy webhook id whose tracked-address set we manage. */
  alchemyWebhookId: string;
  /** Signing key Alchemy uses to HMAC-sign webhook payloads (verifies authenticity). */
  alchemyWebhookSigningKey: string;
  /** Base RPC endpoint for on-chain reads/confirmations. */
  baseRpcUrl: string;
  /** Reward taken from realized profit on withdrawal, in basis points (100 = 1%). */
  rewardBps: number;
  /** Hard cap on any single copied trade in USD. */
  maxTradeUsd: number;
  /** Floor on any single copied trade in USD — sizes below this are skipped. */
  copyTradeFloorUsd: number;
  /** Max fraction of copy-wallet portfolio deployable on one trade (0–1). */
  portfolioDeployPct: number;
  /** Suggested minimum total portfolio to start copying (UX / deposit prompts). */
  minPortfolioUsd: number;
  /** Minimum USDC a copy wallet must hold to keep copying. */
  minUsdcFloor: number;
  /** Minimum ETH (in USD) a copy wallet must hold (for gas) to keep copying. */
  minEthUsd: number;
  /** Minimum DEX liquidity (USD) for a token to be copyable. */
  minLiquidityUsd: number;
  /** Default max slippage (bps) when a strategy doesn't override it. */
  defaultMaxSlippageBps: number;
  /** Per-execution timeout (ms) before a job is considered stuck and retried. */
  executionTimeoutMs: number;
  /** BullMQ retry attempts before a job is moved to the dead-letter queue. */
  maxExecutionAttempts: number;
}

const num = (value: string | undefined, fallback: number): number => {
  const parsed = value == null ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const alchemyWebhookSigningKey = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY?.trim() || "";
const redisUrl = process.env.REDIS_URL?.trim() || "";

export const copyTradingConfig: CopyTradingConfig = {
  redisUrl,
  // Copy-trading only runs when a queue backend is configured. This keeps the
  // existing apps booting unchanged in environments without Redis.
  enabled: process.env.COPY_TRADING_ENABLED
    ? process.env.COPY_TRADING_ENABLED === "true" || process.env.COPY_TRADING_ENABLED === "1"
    : Boolean(redisUrl),
  alchemyApiKey: process.env.ALCHEMY_API_KEY?.trim() || "",
  alchemyAuthToken: process.env.ALCHEMY_AUTH_TOKEN?.trim() || "",
  alchemyWebhookId: process.env.ALCHEMY_WEBHOOK_ID?.trim() || "",
  alchemyWebhookSigningKey,
  baseRpcUrl: process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org",
  rewardBps: num(process.env.COPY_TRADING_REWARD_BPS, 100),
  maxTradeUsd: num(process.env.COPY_TRADING_MAX_TRADE_USD, 10_000),
  copyTradeFloorUsd: num(process.env.COPY_TRADING_TRADE_FLOOR_USD, 0.1),
  portfolioDeployPct: num(process.env.COPY_TRADING_PORTFOLIO_DEPLOY_PCT, 0.3),
  minPortfolioUsd: num(process.env.COPY_TRADING_MIN_PORTFOLIO_USD, 10),
  minUsdcFloor: num(process.env.COPY_TRADING_MIN_USDC_FLOOR, 2),
  minEthUsd: num(process.env.COPY_TRADING_MIN_ETH_USD, 3),
  minLiquidityUsd: num(process.env.COPY_TRADING_MIN_LIQUIDITY_USD, 50_000),
  defaultMaxSlippageBps: num(process.env.COPY_TRADING_MAX_SLIPPAGE_BPS, 200),
  executionTimeoutMs: num(process.env.COPY_TRADING_EXECUTION_TIMEOUT_MS, 90_000),
  maxExecutionAttempts: num(process.env.COPY_TRADING_MAX_EXECUTION_ATTEMPTS, 4),
};
