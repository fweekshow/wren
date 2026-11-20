// ─── discovery/ai.ts ─────────────────────────────────────────────────────────
// Pure barrel re-exporter. All logic lives in sub-modules under ai/.
// Callers keep importing from "@/discovery/ai.js" unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export { deployBankrToken, getTrendingTokens } from "@basemate/bankr-client";

export type {
  AggregatedAvantisReportOptions,
  AIResponse,
  AvantisCloseIntent,
  AvantisEnvelope,
  AvantisPairMeta,
  AvantisPositionWalletReport,
  AvantisPositionWalletTarget,
  AvantisUserData,
  AvantisUserTrade,
  CopyTradeCtxPayload,
  LaunchResult,
  LaunchToken,
  RoutingEvalRecorder,
  TpslUpdateGuideState,
  WalletCall,
} from "@/discovery/ai/types.js";

export {
  isStablecoinAddress,
  resolveTokenAsync,
} from "@/discovery/ai/tokens.js";

export {
  assertSwapUsdWithinLimit,
  coerceUsdAmountFromUserMessage,
  extractUsdAmountFromMessage,
  isBareUsdBuyMessage,
  perpNotionalUsdc,
  resolveProtocolVolumeUsdc,
  resolveUsdQuotedSwapAmount,
  userNamedEthSpend,
} from "@/discovery/ai/amounts.js";

export {
  detectWalletIntent,
  extractYieldAmountFromMessage,
  extractYieldTokenFromMessage,
  isPortfolioBalanceIntent,
  isPerpInfoOrAdviceQuestion,
  isSupportIntent,
  isWorldCupOpenBetsIntent,
  isYieldCompareIntent,
  parseSimplePerp,
  parseSimpleUsdBuy,
  parseSimpleUsdSend,
  parseSimpleTokenSend,
  parseBareSendRecipient,
  extractPendingSendFromHistory,
  parsePerpProfileSetup,
  isPostCardAck,
} from "@/discovery/ai/intents.js";

export {
  buildAerodromeRoutedSwap,
  buildDirectSwap,
  buildRoutedSwap,
  getBestSwapQuote,
} from "@/discovery/ai/tools/swap.js";

export {
  MOONWELL_PORTFOLIO_URL,
  MORPHO_PORTFOLIO_URL,
  AAVE_PORTFOLIO_URL,
} from "@/discovery/ai/toolbox.js";

export { DiscoveryAI } from "@/discovery/ai/core.js";
