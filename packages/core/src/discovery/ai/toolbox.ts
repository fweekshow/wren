// ─── toolbox.ts ──────────────────────────────────────────────────────────────
// This file is the consolidated Toolbox module, split out from the monolithic
// discovery/ai.ts as part of Phase 3 AI Engine Decomposition (PR 3.7).
// The class Toolbox and all its domain handlers live here; DiscoveryAI imports
// Toolbox from this module.
// ─────────────────────────────────────────────────────────────────────────────

import OpenAI from "openai";
import { encodeFunctionData, formatUnits, getAddress, http, isAddress, namehash, parseUnits, toCoinType, toHex, type Address } from "viem";
import {
  getBankrLaunches,
  getTrendingTokens,
} from "@basemate/bankr-client";
import type { BankrLaunchSort, BankrLaunchesResult } from "@basemate/shared";
import { sanitizeAmount } from "@basemate/shared";

export { deployBankrToken, getTrendingTokens } from "@basemate/bankr-client";

import { shortWalletLabel } from "@/account-linking/index.js";
import {
  fetchBasePortfolioHoldings,
  type PortfolioHolding,
} from "@/portfolio-reviews/balances.js";
import { buildSignedPortfolioUrl, tryBuildSignedPortfolioUrl } from "@/portfolio/access.js";
import { isPortfolioViewIntent } from "@/messaging/intentEngine.js";
import { buildImessagePortfolio, buildXmtpPortfolio } from "@/portfolio/service.js";
import type { ImessagePortfolioPayload } from "@/portfolio/types.js";
import {
  formatCoinsSummaryForImessage,
  formatPerpsSummaryForImessage,
  formatStakingSummaryForImessage,
} from "@/portfolio/summary.js";
import {
  fetchMoonwellDirectSupplies,
  MOONWELL_MTOKEN_ABI,
  MOONWELL_MTOKENS,
  moonwellUnderlyingSymbol,
} from "@/portfolio/moonwell.js";
import { NSGroupAdapter, type NSGroup } from "@/discovery/adapters/nsGroup.adapter.js";
import { ConversationMemoryAdapter } from "@/discovery/adapters/conversationMemory.adapter.js";
import { UserMemoryAdapter } from "@/discovery/adapters/userMemory.adapter.js";
import { UserAdapter } from "@/discovery/adapters/user.adapter.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import {
  checkInboundContentGuardrails,
  sanitizeOutboundContent,
} from "@/discovery/contentGuardrails.js";
import { RecommendationAdapter } from "@/discovery/adapters/recommendation.adapter.js";
import {
  isAllowedSendRecipient,
  resolveSendRecipient,
  type ConversationMembersLike,
  type ResolveSendRecipientCtx,
} from "@/discovery/services/sendRecipient.service.js";
import {
  StrategyAdapter,
  type StrategyTradeAttribution,
} from "@/discovery/adapters/strategy.adapter.js";
import {
  resolveBasemateServerWallet,
  type StrategyWalletPlatform,
} from "@/discovery/strategy/wallet.js";
import { getConversationHistory, type ConversationHistorySource } from "@/xmtp/utils/history.js";
import { isMenuNavigationIntent } from "@/xmtp/utils/menuNavigationIntent.util.js";
import {
  createBankrLlmClient,
  DEFAULT_CHAT_MODEL,
  getAdvisoryModel,
  logLlmTurn,
  openAiChatParams,
  providerForModel,
} from "@/llm/config.js";
// Types and prompts are extracted into focused modules; ai.ts re-exports them
// to maintain the existing public import path for all callers.
import {
  type AggregatedAvantisReportOptions,
  type AIResponse,
  type AvantisCloseIntent,
  type AvantisCloseWalletScope,
  type AvantisCloseWalletTarget,
  type AvantisEnvelope,
  type AvantisIndexedTradeArgs,
  type AvantisPairIndexLookup,
  type AvantisPairMeta,
  type AvantisOrderType,
  type AvantisPositionWalletReport,
  type AvantisPositionWalletTarget,
  type AvantisSerializedOrderType,
  type AvantisTargetResolution,
  type AvantisUserData,
  type AvantisUserTrade,
  type CopyTradeCtxPayload,
  type LaunchResult,
  type LaunchToken,
  type MoonwellWithdrawIntent,
  type RoutingEvalRecorder,
  type TpslUpdateGuideState,
  type WalletCall,
  type XmtpMemberLike,
  type AvantisOpenUrlArgs,
} from "@/discovery/ai/types.js";

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

import { FEW_SHOT_EXAMPLES, getSystemPrompt, SYSTEM_PROMPT } from "@/discovery/ai/prompts.js";
import {
  AVANTIS_STOCK_SYMBOLS,
  BASE_TOKENS,
  extractPriceLookup,
  fetchTokenPriceUsd,
  isStablecoinAddress,
  MAJOR_PRICE_ALIASES,
  PRICE_QUERY_STOP_WORDS,
  resolveToken,
  resolveTokenAsync,
  STABLECOIN_ADDRESSES,
  TOKEN_SYMBOL_ALIASES,
} from "@/discovery/ai/tokens.js";
import {
  assertSwapUsdWithinLimit,
  coerceUsdAmountFromUserMessage,
  extractUsdAmountFromMessage,
  isBareUsdBuyMessage,
  MAX_SWAP_USD,
  normalizeHexValue,
  perpNotionalUsdc,
  resolveProtocolVolumeUsdc,
  resolveUsdQuotedSwapAmount,
  usdToTokenAmount,
  userNamedEthSpend,
  WETH_BASE_ADDRESS,
} from "@/discovery/ai/amounts.js";

const resolveYieldProtocolVolumeUsdc = resolveProtocolVolumeUsdc;

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

import { getTools } from "@/discovery/ai/tools/index.js";

import {
  portfolioUserKey as _portfolioUserKey,
  buildChannelPortfolio as _buildChannelPortfolio,
  get_portfolio_summary as _get_portfolio_summary,
  get_staking_summary as _get_staking_summary,
} from "@/discovery/ai/tools/portfolio.handlers.js";
import {
  custodialWalletOrError as _custodialWalletOrError,
  get_wallet_balance as _get_wallet_balance,
  fund_wallet as _fund_wallet,
  sweep_funds as _sweep_funds,
  withdraw_funds as _withdraw_funds,
  offramp_to_fiat as _offramp_to_fiat,
  send_token as _send_token,
  send_token_bundle as _send_token_bundle,
  resolve_name as _resolve_name,
} from "@/discovery/ai/tools/wallet.handlers.js";
import { gift_stock as _gift_stock } from "@/discovery/ai/tools/giftStock.handlers.js";
import {
  get_recent_activity as _get_recent_activity,
  get_recent_sends as _get_recent_sends,
  get_payment_mode as _get_payment_mode,
  set_payment_mode as _set_payment_mode,
} from "@/discovery/ai/tools/app.handlers.js";
import { appLink, type AppSection } from "@/discovery/ai/appLinks.js";
import {
  price_alert_create as _price_alert_create,
  price_alert_list as _price_alert_list,
  price_alert_cancel as _price_alert_cancel,
  contact_list as _contact_list,
  schedule_portfolio_review as _schedule_portfolio_review,
} from "@/discovery/ai/tools/messaging.handlers.js";
import {
  uniswap_prepare_swap as _uniswap_prepare_swap,
  morpho_get_vaults as _morpho_get_vaults,
  morpho_prepare_deposit as _morpho_prepare_deposit,
  morpho_get_position as _morpho_get_position,
  morpho_prepare_withdraw as _morpho_prepare_withdraw,
  aave_prepare_supply as _aave_prepare_supply,
  moonwell_get_position as _moonwell_get_position,
  moonwell_prepare_withdraw as _moonwell_prepare_withdraw,
  moonwell_prepare_supply as _moonwell_prepare_supply,
  aerodrome_get_pools as _aerodrome_get_pools,
  aerodrome_prepare_swap as _aerodrome_prepare_swap,
  aerodrome_prepare_add_liquidity as _aerodrome_prepare_add_liquidity,
  yield_compare as _yield_compare,
} from "@/discovery/ai/tools/yield.handlers.js";
import {
  flash_prepare_order as _flash_prepare_order,
  flash_list_orders as _flash_list_orders,
  flash_cancel_order as _flash_cancel_order,
} from "@/discovery/ai/tools/flash.handlers.js";

import {
  detectWalletIntent,
  extractMoonwellWithdrawAsset,
  extractYieldAmountFromMessage,
  extractYieldTokenFromMessage,
  isEarnPositionReadIntent,
  isPortfolioBalanceIntent,
  isPerpInfoOrAdviceQuestion,
  isSupportIntent,
  isWorldCupOpenBetsIntent,
  isYieldCompareIntent,
  MOONWELL_MTOKEN_KEY_SET,
  parseMoonwellWithdrawIntent,
  parseMorphoWithdrawIntent,
  parseSimplePerp,
  parseSimpleUsdBuy,
  parseGiftStock,
  parseSimpleUsdSend,
  parseSimpleTokenSend,
  parseBareSendRecipient,
  extractPendingSendFromHistory,
  parsePerpProfileSetup,
  pickCardNudge,
  isPostCardAck,
} from "@/discovery/ai/intents.js";

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
  parseGiftStock,
  parseSimpleUsdSend,
  parseSimpleTokenSend,
  parseBareSendRecipient,
  extractPendingSendFromHistory,
  parsePerpProfileSetup,
  isPostCardAck,
} from "@/discovery/ai/intents.js";

import {
  AERODROME_DEFAULT_FACTORY,
  AERODROME_ROUTER,
  AERODROME_ROUTER_LP_ABI,
  buildAerodromeRoutedSwap,
  buildDirectSwap,
  buildERC20Approve,
  buildRoutedSwap,
  ERC20_ABI,
  getBestSwapQuote,
} from "@/discovery/ai/tools/swap.js";

export {
  buildAerodromeRoutedSwap,
  buildDirectSwap,
  buildRoutedSwap,
  getBestSwapQuote,
} from "@/discovery/ai/tools/swap.js";

import {
  BASE_USDC_ADDRESS,
  getBalances,
  getUsdcBalance,
  isCdpEnabled,
  withdraw as cdpWithdraw,
} from "@/wallet/cdp.js";
import {
  formatSweepPreview,
  resolveCustodialSweepWallets,
} from "@/wallet/sweep.js";
import { buildOfframpUrl, buildOnrampUrl } from "@/wallet/onramp.js";
// OPERATIONAL prompt, SYSTEM_PROMPT, FEW_SHOT_EXAMPLES, getSystemPrompt —
// moved to src/discovery/ai/prompts.ts; imported above.

export const MODEL = DEFAULT_CHAT_MODEL;
const DEFAULT_SUPPORT_GROUP_IMAGE_URL =
  "https://res.cloudinary.com/dg5qvbxjp/image/upload/v1780479134/ChatGPT_Image_Jun_3_2026_at_04_32_01_PM_aosmag.png";

function supportGroupImageUrl(): string {
  return process.env.SUPPORT_GROUP_IMAGE_URL?.trim() || DEFAULT_SUPPORT_GROUP_IMAGE_URL;
}

// WalletCall moved to src/discovery/ai/types.ts; re-exported above.

// normalizeHexValue — moved to src/discovery/ai/amounts.ts.

// ── Uniswap Trade API (proxy-approval flow, no Permit2) ──────────────────────
// Same flow used by the Base MCP Uniswap plugin. The x-permit2-disabled header
// switches the API from Permit2 (off-chain EIP-712 signature, unsupported in
// wallet_sendCalls) to a plain ERC-20 approve + swap pair.
// Portfolio / dashboard links shown after yield deposits so users can track their position.
export const MOONWELL_PORTFOLIO_URL = "https://moonwell.fi/portfolio";
export const MORPHO_PORTFOLIO_URL   = "https://morpho.org";
export const AAVE_PORTFOLIO_URL     = "https://app.aave.com";

// getSystemPrompt, FEW_SHOT_EXAMPLES — moved to src/discovery/ai/prompts.ts; imported above.

function fmtUsdCompact(n: number | undefined): string {
  if (n == null || Number.isNaN(n)) return "";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPctShort(n: number | undefined): string {
  if (n == null) return "flat";
  const sign = n >= 0 ? "+" : "";
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 0 : 1;
  return `${sign}${n.toFixed(digits)}%`;
}

function fmtLaunchAge(iso: string | undefined): string {
  if (!iso) return "";
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) return "just now";
    const mins = Math.floor(ms / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  } catch {
    return "";
  }
}

function formatLaunchLine(t: LaunchToken, rank: number, sort: BankrLaunchSort): string {
  const symbol = t.symbol.toUpperCase();
  const mcap = t.marketCapUsd != null ? fmtUsdCompact(t.marketCapUsd) : null;
  const stats: string[] = [];

  if (sort === "trending" || sort === "mixed") {
    stats.push(`${fmtPctShort(t.priceChange24h)} 24h`);
    if (mcap) stats.push(`${mcap} mcap`);
    else if (t.vol24h != null && t.vol24h > 0) stats.push(`${fmtUsdCompact(t.vol24h)} vol`);
  } else if (sort === "new") {
    const age = fmtLaunchAge(t.deployedAt ?? t.createdAt);
    if (age) stats.push(age);
    if (mcap) stats.push(`${mcap} mcap`);
    else stats.push(fmtPctShort(t.priceChange24h));
  } else if (sort === "mcap") {
    if (mcap) stats.push(`${mcap} mcap`);
    stats.push(fmtPctShort(t.priceChange24h));
  }

  return `${rank}. ${symbol} — ${stats.join(" · ")}`;
}

function formatBankrLaunchesText(result: BankrLaunchesResult): string {
  if (result.sort === "mixed" && result.fresh && result.trending) {
    const sections: string[] = [
      "Trending Bankr Tokens",
      "",
      "Fresh (last 6h)",
    ];
    if (result.fresh.length === 0) {
      sections.push("Nothing new right now.");
    } else {
      for (const [i, t] of result.fresh.entries()) {
        sections.push(formatLaunchLine(t, i + 1, "new"));
      }
    }
    sections.push("", "Trending");
    for (const [i, t] of result.trending.entries()) {
      sections.push(formatLaunchLine(t, i + 1, "trending"));
    }
    return sections.join("\n");
  }

  const header =
    result.sort === "trending"
      ? "Trending Bankr Tokens"
      : result.sort === "new"
        ? "New Bankr Tokens"
        : result.sort === "mcap"
          ? "Top Bankr Tokens by Market Cap"
          : "Trending Bankr Tokens";

  const subtitle =
    result.sort === "trending"
      ? "Projects gaining momentum on Base."
      : result.sort === "new"
        ? "Recently launched via Bankr."
        : result.sort === "mcap"
          ? "Sorted by market cap."
          : "";

  const lines = result.tokens.map((t, i) => formatLaunchLine(t, i + 1, result.sort));
  return [header, subtitle, "", ...lines].filter(Boolean).join("\n");
}

// CopyTradeCtxPayload — moved to src/discovery/ai/types.ts.

// AIResponse, RoutingEvalRecorder — moved to src/discovery/ai/types.ts.

export function recordRoutingEvalTool(
  ctx: RespondCtx,
  tool: string,
  args: Record<string, unknown> = {},
): void {
  ctx.routingEvalRecorder?.invocations.push({ tool, args });
}



export interface RespondCtx {
  inboxId: string;
  walletAddress: string;
  /**
   * All wallet addresses to analyze for this user — their own wallet plus any
   * wallets from accounts they've linked on other platforms. When present with
   * more than one entry, self-targeted Avantis position lists aggregate across
   * them (per-wallet sections + a combined total).
   */
  linkedWallets?: string[];
  isGroup?: boolean;
  conversationId?: string;
  /** Raw XMTP conversation — sync + members() (debug / future features; sends use basename or 0x only) */
  conversation?: ConversationMembersLike & {
    send(text: string): Promise<void>;
    sync(): Promise<void>;
    messages(opts: { limit: number; direction: number }): Promise<unknown[]>;
  };
  /** XMTP client — inboxStateFromInboxIds for passkey/smart-wallet members */
  client?: ResolveSendRecipientCtx["client"];
  /** Agent's XMTP inbox id (for history bootstrap). */
  agentInboxId?: string;
  /** The current user message text. Used to guard against perp fields (collateral/leverage) bleeding in from earlier conversation history. */
  userMessage?: string;
  /** Current message id — excluded when bootstrapping history from XMTP. */
  currentMessageId?: string;
  /**
   * True when `walletAddress` is a basemate-custodied CDP server wallet (iMessage).
   * Gates the custodial wallet tools (balance / fund / withdraw / offramp). On
   * XMTP/Base App the wallet is the user's own non-custodial wallet, so these
   * tools must NOT be exposed there.
   */
  custodialWallet?: boolean;
  /** Stable CDP account name for the custodial wallet (signing key lookup). */
  custodialAccountName?: string;
  /** End-user IP for onramp session tokens (optional; falls back to config). */
  clientIp?: string;
  /** Routing eval only — see packages/core/src/discovery/eval/run-routing-eval.ts */
  routingEvalRecorder?: RoutingEvalRecorder;
  /** Mid perp wizard — typed reply routed through the model (Phase 3). */
  perpWizard?: PerpWizardContext;
  /** iMessage intent engine already selected the route; skip regex pre-routes. */
  disableDeterministicRouting?: boolean;
  /** Platform identity for the user's Basemate server wallet. */
  copyPlatform?: StrategyWalletPlatform;
  /** Platform-scoped user id for server wallet lookup. Defaults to inboxId. */
  copyUserKey?: string;
  /** Eval/dev escape hatch for probes that intentionally exercise off-topic messages. */
  skipContentGuardrails?: boolean;
  /** Channel hint for positions report footers (Open Positions menu vs text close). */
  positionsChannel?: "xmtp" | "imessage" | "whatsapp";
  /**
   * Resolved intent action from the iMessage intent engine.
   * Injected into the system prompt USER CONTEXT block so the LLM knows what
   * the fast-path classifier already determined — reduces ambiguity and
   * hallucination on borderline messages (e.g. "yield" hint for withdraw requests).
   */
  intentAction?: string;
  /** Intent-derived target name (contact or ENS) when the intent engine resolved one. */
  intentTargetName?: string | null;
  /** Intent-derived token symbol(s) when the intent engine parsed one (e.g. "BRETT", "ETH"). */
  intentAsset?: string | null;
  /** Intent-derived amount when the intent engine parsed one (e.g. "5", "all"). */
  intentAmount?: string | null;
}

export const DEFAULT_REPLY =
  "aw i didn't quite catch that one — but i'm all yours! tell me what you're thinking and we'll figure it out together 💙";

export function historyTextForControl(control: AIResponse): string {
  if (control.type === "menu") return control.description ?? "opened capabilities menu";
  if ("text" in control && control.text) return control.text;
  return DEFAULT_REPLY;
}

/** Tool-driven responses that should not wait for another LLM synthesis round. */
export function isTerminalAiResponse(control: AIResponse): boolean {
  switch (control.type) {
    case "markdown":
    case "pnl_card_ready":
    case "pnl_position_picker":
    case "menu":
    case "transaction":
    case "flash_order":
    case "approve":
    case "communities":
    case "launches":
    case "disambiguate":
    case "amount_select":
    case "perp_guide":
    case "launch_guide":
    case "tpsl_update_guide":
    case "wallet_info":
    case "onramp_link":
    case "offramp_link":
    case "withdraw_result":
    case "perp_setup_redirect":
    case "perp_min_fix":
    case "worldcup_matches":
    case "worldcup_bet_wizard":
    case "text":
      return true;
    default:
      return false;
  }
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

/** Trim trailing zeros from a decimal string and cap to 6 dp for display. */
export function trimAmount(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n
    .toFixed(6)
    .replace(/\.?0+$/, "");
}

/** Abbreviate a 0x address for display, e.g. 0x1234…abcd. */
export function shortenAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

/** Informational "what can you do?" — not explicit menu/help navigation. */
export function isCapabilitiesInfoQuestion(message: string): boolean {
  const m = message.trim().toLowerCase().replace(/^@\S+\s*/, "");
  return /\b(what can you do|what do you do|what are you able|what are your capabilities|how can you help|what can you help|what do you help with|what features|what stuff can you|tell me what you can)\b/.test(
    m,
  );
}

export function routeMenuOpener(message: string, _hasHistory = false): AIResponse | null {
  // Only pre-route explicit navigation commands (bare "menu", "help", "options").
  // Everything else — greetings, small talk, vague one-word openers — now flows
  // to the LLM so Basemate answers in its own warm voice (see SOUL), never a
  // flat canned line.
  if (isMenuNavigationIntent(message)) {
    return { type: "menu" };
  }
  return null;
}

/** User explicitly wants trending group chats — not the default for bare "what's trending". */
function isTrendingGroupsIntent(message: string): boolean {
  const m = message.trim().toLowerCase().replace(/^@\S+\s*/, "");
  if (
    /\b(trending|hot|popular|top)\s+(groups?|communities|chats?|channels?|guilds?)\b/.test(m)
  ) {
    return true;
  }
  return (
    /\b(groups?|communities|chats?|channels?|guilds?)\b/.test(m) &&
    /\b(trending|hot|popular|top)\b/.test(m)
  );
}

/** Bare "what's trending" and token/market hotness — default over get_trending groups. */
function isTrendingTokensIntent(message: string): boolean {
  const m = message.trim().toLowerCase().replace(/^@\S+\s*/, "");
  if (isTrendingGroupsIntent(message)) return false;
  if (
    /\b(token|tokens|coin|coins|ticker|memecoin|memecoins|bankr|launch|launches)\b/.test(m) &&
    /\b(trending|hot|pumping|movers|fresh|new)\b/.test(m)
  ) {
    return true;
  }
  return (
    /\bwhat'?s?\s+trending\b/.test(m) ||
    /\bwhats\s+trending\b/.test(m) ||
    /\bwhat\s+is\s+trending\b/.test(m) ||
    /^trending\b/.test(m) ||
    /\bwhat'?s?\s+hot\b/.test(m) ||
    /\bhot\s+(right\s+now|now|on\s+base)\b/.test(m) ||
    /\bshow\s+(me\s+)?trending\b/.test(m)
  );
}








export function finalizeTextResponse(
  text: string,
  userMessage: string,
): Extract<AIResponse, { type: "text" }> | Extract<AIResponse, { type: "menu" }> {
  const guarded = sanitizeOutboundContent(text.trim());
  const cleaned = stripMarkdown(guarded) || DEFAULT_REPLY;
  if (isCapabilitiesInfoQuestion(userMessage)) {
    return { type: "menu", description: cleaned };
  }
  return { type: "text", text: cleaned };
}

// ─── Morpho known vault addresses on Base mainnet ────────────────────────────
// Used as fallback when the GraphQL API is down or returns no results.

// Live Morpho vault data is fetched from blue-api.morpho.org and cached for
// MORPHO_CACHE_TTL_MS. No hardcoded fallback — if the API is down, the
// affected tools return an honest error instead of stale mock data.

// ─── Tool handlers ────────────────────────────────────────────────────────────

export interface ToolResult {
  data: unknown;
  // Set when the tool produced a UI-routable response
  control?: AIResponse;
}

/**
 * Append a /app dashboard deep link to a text-bearing tool result so a user who
 * asks about their balance / yield / activity / sends / payment mode gets both
 * the answer in chat and a tap-through to the exact page.
 *
 * No-op on XMTP (Base App has its own wallet UI, not the /app dashboard), when
 * the control carries no `text` to extend, or when the link is already present.
 */
export function appendAppLink(
  result: ToolResult | null,
  section: AppSection,
  ctx: RespondCtx,
): ToolResult | null {
  if (!result || !result.control) return result;
  if (ctx.copyPlatform === "xmtp") return result;
  const control = result.control;
  if (!("text" in control) || typeof control.text !== "string" || !control.text) {
    return result;
  }
  const link = appLink(section);
  if (control.text.includes(link)) return result;
  const nextControl = {
    ...control,
    text: `${control.text}\n\nsee it in your dashboard 👉 ${link}`,
  } as typeof control;
  return { ...result, control: nextControl };
}


/**
 * Turns a raw Avantis API error message (already lowercased) into user-facing text.
 * Priority: market-closed / trading-hours → paused/halted → known limits → fallback to raw msg.
 */

export class Toolbox {
  constructor(private ctx: RespondCtx) {}

  // ── Capabilities menu ───────────────────────────────────────────────────────

  async show_capabilities_menu(): Promise<ToolResult> {
    return { data: { ok: true }, control: { type: "menu" } };
  }

  async describe_capabilities(args: { summary: string }): Promise<ToolResult> {
    const summary = stripMarkdown(args.summary?.trim() || DEFAULT_REPLY);
    return {
      data: { ok: true },
      control: { type: "menu", description: summary },
    };
  }

  async offer_support(args: { message: string }): Promise<ToolResult> {
    const groupId = process.env.SUPPORT_GROUP_ID?.trim();
    const fallbackText =
      "support channel isn't wired up yet — ping the team and we'll get you sorted";
    if (!groupId) {
      return { data: { ok: false }, control: { type: "text", text: fallbackText } };
    }
    const group = await NSGroupAdapter.getGroupById(groupId);
    if (!group) {
      return {
        data: { ok: false },
        control: { type: "text", text: "couldn't find the support group right now — try again in a bit" },
      };
    }
    const text = stripMarkdown(args.message?.trim() || "sorry you're hitting this — tap below to join support");
    return {
      data: { ok: true, group: group.name },
      control: {
        type: "communities",
        text,
        groups: [{ ...group, image_url: supportGroupImageUrl() }],
      },
    };
  }

  // ── Custodial wallet (CDP server wallets) ────────────────────────────────────

  /** Guard: returns the custodial wallet context, or a text ToolResult to bail with. */
  private custodialWalletOrError():
    | { ok: true; address: string; accountName: string | undefined }
    | { ok: false; result: ToolResult } {
    return _custodialWalletOrError(this.ctx);
  }

  private portfolioUserKey(): string | null {
    return _portfolioUserKey(this.ctx);
  }

  private async buildChannelPortfolio(): Promise<ImessagePortfolioPayload | null> {
    return _buildChannelPortfolio(this.ctx);
  }

  async get_portfolio_summary(): Promise<ToolResult | null> {
    return appendAppLink(await _get_portfolio_summary(this.ctx), "home", this.ctx);
  }

  async get_staking_summary(): Promise<ToolResult | null> {
    return appendAppLink(await _get_staking_summary(this.ctx), "earn", this.ctx);
  }

  async get_wallet_balance(): Promise<ToolResult> {
    const r = await _get_wallet_balance(this.ctx);
    return appendAppLink(r, "home", this.ctx) ?? r;
  }

  // ── Dashboard reads (chat answer + /app deep link) ──────────────────────────

  async get_recent_activity(): Promise<ToolResult> {
    return _get_recent_activity(this.ctx);
  }

  async get_recent_sends(): Promise<ToolResult> {
    return _get_recent_sends(this.ctx);
  }

  async get_payment_mode(): Promise<ToolResult> {
    return _get_payment_mode(this.ctx);
  }

  async set_payment_mode(args: { mode: "automatic" | "manual" }): Promise<ToolResult> {
    return _set_payment_mode(this.ctx, args);
  }

  async fund_wallet(args: { amountUsd?: number }): Promise<ToolResult> {
    return _fund_wallet(this.ctx, args);
  }

  async sweep_funds(args: { to?: string } = {}): Promise<ToolResult> {
    return _sweep_funds(this.ctx, args);
  }

  async withdraw_funds(args: { to: string; amount: string; asset?: string }): Promise<ToolResult> {
    return _withdraw_funds(this.ctx, args);
  }

  async offramp_to_fiat(args: { amount?: string }): Promise<ToolResult> {
    return _offramp_to_fiat(this.ctx, args);
  }

  // ── Discovery ───────────────────────────────────────────────────────────────

  async search_communities(args: { query: string; limit?: number }): Promise<ToolResult> {
    const limit = Math.min(args.limit ?? 5, 10);
    const query = args.query.trim().toLowerCase();
    if (!query) {
      return { data: { groups: [] } };
    }
    const all = await NSGroupAdapter.getSuggestableGroups();
    const matched = all
      .map((g) => ({ g, score: scoreGroup(g, query) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ g }) => g);
    return {
      data: matched.map((g) => ({ name: g.name, description: g.description ?? null })),
      control: matched.length
        ? {
            type: "communities",
            text: `Found ${matched.length} ${matched.length === 1 ? "match" : "matches"} for "${args.query}":`,
            groups: matched,
          }
        : undefined,
    };
  }

  async get_trending(args: { limit?: number }): Promise<ToolResult> {
    const limit = Math.min(args.limit ?? 3, 10);
    try {
      const { TrendingService } = await import("@/discovery/services/trending.js");
      const svc = new TrendingService();
      // Fetch a wider pool so we can still return `limit` after filtering
      // out groups the agent isn't actually a member of.
      const slots = await svc.getTrendingSlots(Math.max(limit * 3, 10));
      if (slots.length > 0) {
        const memberIds = await NSGroupAdapter.getAgentGroupIdSet();
        const filtered = slots
          .filter((s) => memberIds.has(s.group.groupId))
          .slice(0, limit);
        if (filtered.length > 0) {
          const groups: NSGroup[] = filtered.map((s) => ({
            id: s.group.groupId,
            group_id: s.group.groupId,
            name: s.group.name,
            description: s.group.description,
            image_url: s.group.imageUrl,
            total_members: s.group.memberCount,
            total_messages: s.group.messageCount,
            tags: s.group.topics,
          }));
          return {
            data: groups.map((g) => ({ name: g.name, description: g.description })),
            control: {
              type: "communities",
              text: `Top ${groups.length} trending right now:`,
              groups,
            },
          };
        }
      }
    } catch (err) {
      console.warn("⚠️ trending service failed, falling back to active groups:", err);
    }
    const fallback = (await NSGroupAdapter.getActiveGroups(24)).slice(0, limit);
    return {
      data: fallback.map((g) => ({ name: g.name, description: g.description })),
      control: fallback.length
        ? {
            type: "communities",
            text: `Top ${fallback.length} trending right now:`,
            groups: fallback,
          }
        : undefined,
    };
  }

  async recommend_for_user(): Promise<ToolResult> {
    let interests: string[] = [];
    try {
      interests = await RecommendationAdapter.getUserInterests(this.ctx.inboxId);
    } catch {
      // ignore — fallback to trending
    }
    if (interests.length === 0) {
      return this.get_trending({ limit: 3 });
    }
    const all = await NSGroupAdapter.getSuggestableGroups();
    const scored = all
      .map((g) => {
        const score = interests.reduce((acc, kw) => acc + scoreGroup(g, kw), 0);
        return { g, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ g }) => g);
    if (scored.length === 0) return this.get_trending({ limit: 3 });
    return {
      data: scored.map((g) => ({ name: g.name, description: g.description })),
      control: {
        type: "communities",
        text: `Based on what you've been into, you'd probably like:`,
        groups: scored,
      },
    };
  }

  // ── DeFi ───────────────────────────────────────────────────────────────────

  async send_token(args: {
    to: string;
    asset: string;
    amount: string;
    isUsd?: boolean;
    all?: boolean;
    memo?: string;
  }): Promise<ToolResult> {
    const { isKnownStockPairCandidate } = await import("@/discovery/doppler/stockRegistry.js");
    if (isKnownStockPairCandidate(args.asset)) {
      return _gift_stock(this.ctx, {
        to: args.to,
        stock: args.asset,
        amount: args.amount,
        isUsd: args.isUsd,
        memo: args.memo,
      });
    }

    // LLM backstop: bare "$N" defaults to USDC in prompts, so the model often
    // drops "Apple stock" and calls send_token(USDC). Recover from the raw
    // user message when it was clearly a B20 stock gift.
    const assetLooksStable = /^(usdc|usd|usdt|dai|stables?|dollars?|bucks?)$/i.test(
      args.asset.trim(),
    );
    if (assetLooksStable && !args.all) {
      const gift = parseGiftStock(this.ctx.userMessage ?? "");
      if (gift) {
        return _gift_stock(this.ctx, {
          to: gift.to,
          stock: gift.stock,
          amount: gift.amount,
          isUsd: gift.isUsd,
          memo: args.memo,
        });
      }
    }

    return _send_token(this.ctx, args);
  }

  /** Multiple token transfers in one wallet_sendCalls (e.g. USDC + ETH gas top-up). */
  async send_token_bundle(args: {
    to: string;
    transfers: Array<{ asset: string; amount: string; isUsd?: boolean }>;
    label?: string;
  }): Promise<ToolResult> {
    return _send_token_bundle(this.ctx, args);
  }

  async gift_stock(args: {
    to: string;
    stock: string;
    amount: string;
    isUsd?: boolean;
    memo?: string;
  }): Promise<ToolResult> {
    return _gift_stock(this.ctx, args);
  }

  async resolve_name(args: { name: string }): Promise<ToolResult> {
    return _resolve_name(this.ctx, args);
  }

  async price_alert_create(args: {
    token: string;
    targetValue: number;
    direction: "above" | "below";
    metric?: "price_usd" | "market_cap_usd";
  }): Promise<ToolResult> {
    return _price_alert_create(this.ctx, args);
  }

  async price_alert_list(): Promise<ToolResult> {
    return _price_alert_list(this.ctx);
  }

  async price_alert_cancel(args: { alertId?: number } = {}): Promise<ToolResult> {
    return _price_alert_cancel(this.ctx, args);
  }

  async contact_list(): Promise<ToolResult> {
    return _contact_list(this.ctx);
  }

  async schedule_portfolio_review(): Promise<ToolResult> {
    return _schedule_portfolio_review(this.ctx);
  }

  async uniswap_prepare_swap(args: {
    fromAsset: string;
    toAsset: string;
    amount: string;
    isUsd?: boolean;
  }): Promise<ToolResult> {
    return _uniswap_prepare_swap(this.ctx, args);
  }

  async flash_prepare_order(args: {
    targetAsset: string;
    contraAsset: string;
    side: "buy" | "sell";
    qty: string;
    orderType: "market" | "limit" | "twap" | "stop" | "stop-loss" | "take-profit" | "bracket";
    limitNotionalPrice?: string;
    triggerNotionalPrice?: string;
    triggerType?: "upper" | "lower";
    durationSeconds?: number;
    twapBucketCount?: number;
    maxSlippage?: string;
  }): Promise<ToolResult> {
    return _flash_prepare_order(this.ctx, args);
  }

  async flash_list_orders(): Promise<ToolResult> {
    return _flash_list_orders(this.ctx);
  }

  async flash_cancel_order(args: { orderId: string }): Promise<ToolResult> {
    return _flash_cancel_order(this.ctx, args);
  }

  async morpho_get_vaults(args: { asset?: string; limit?: number }): Promise<ToolResult> {
    return _morpho_get_vaults(this.ctx, args);
  }

  async morpho_prepare_deposit(args: {
    asset: string;
    amount?: string;
    isUsd?: boolean;
    vaultName?: string;
  }): Promise<ToolResult> {
    return _morpho_prepare_deposit(this.ctx, args);
  }

  async morpho_get_position(args: { asset?: string } = {}): Promise<ToolResult> {
    const r = await _morpho_get_position(this.ctx, args);
    return appendAppLink(r, "earn", this.ctx) ?? r;
  }

  async morpho_prepare_withdraw(args: {
    asset?: string;
    amount?: string;
    isUsd?: boolean;
    all?: boolean;
    vaultName?: string;
  } = {}): Promise<ToolResult> {
    return _morpho_prepare_withdraw(this.ctx, args);
  }

  /**
   * Aave V3 supply on Base. Standard 2-step approve + Pool.supply call.
   * Pool address: 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5.
   */
  async aave_prepare_supply(args: {
    asset: string;
    amount?: string;
    isUsd?: boolean;
  }): Promise<ToolResult> {
    return _aave_prepare_supply(this.ctx, args);
  }

  async moonwell_get_position(): Promise<ToolResult> {
    const r = await _moonwell_get_position(this.ctx);
    return appendAppLink(r, "earn", this.ctx) ?? r;
  }

  async moonwell_prepare_withdraw(args: {
    asset?: string;
    amount?: string;
    isUsd?: boolean;
    all?: boolean;
  } = {}): Promise<ToolResult> {
    return _moonwell_prepare_withdraw(this.ctx, args);
  }

  async moonwell_prepare_supply(args: { asset: string; amount?: string; isUsd?: boolean }): Promise<ToolResult> {
    return _moonwell_prepare_supply(this.ctx, args);
  }

  async get_market_price(args: {
    asset: string;
    assetType?: "token" | "stock" | "auto";
  }): Promise<ToolResult> {
    const rawAsset = args.asset?.trim();
    if (!rawAsset) {
      return {
        data: { error: "missing asset" },
        control: { type: "text", text: "which token or stock should i price?" },
      };
    }

    const rawSymbol = rawAsset.toUpperCase().replace(/^\$/, "");
    const asset = rawAsset.startsWith("0x") ? rawAsset : MAJOR_PRICE_ALIASES[rawSymbol] ?? rawSymbol;
    const wantsStock = args.assetType === "stock" || AVANTIS_STOCK_SYMBOLS.has(asset);
    const wantsToken = args.assetType === "token";
    const isKnownMajor = Boolean(MAJOR_PRICE_ALIASES[rawSymbol] || MAJOR_PRICE_ALIASES[asset]);

    if (!wantsToken && isKnownMajor) {
      const mark = await fetchAvantisMarkPrice(asset);
      if (mark) {
        const text = `${asset} is around ${formatMarketPrice(mark)} right now via Avantis mark price.`;
        return { data: { asset, priceUsd: mark, source: "avantis" }, control: { type: "text", text } };
      }
      return {
        data: { error: "major price unavailable", asset },
        control: {
          type: "text",
          text: `i couldn't price ${asset} right now — try again in a sec.`,
        },
      };
    }

    if (!wantsToken && (wantsStock || AVANTIS_STOCK_SYMBOLS.has(asset))) {
      const mark = await fetchAvantisMarkPrice(asset);
      if (mark) {
        const text = `${asset} is around ${formatMarketPrice(mark)} right now via Avantis mark price.`;
        return { data: { asset, priceUsd: mark, source: "avantis" }, control: { type: "text", text } };
      }
    }

    const token = await resolveTokenAsync(asset);
    if (token.resolved) {
      const priceLookupAddr = token.address === "ETH" ? WETH_BASE_ADDRESS : token.address;
      const price = isStablecoinAddress(priceLookupAddr) ? 1 : await fetchTokenPriceUsd(priceLookupAddr);
      if (price) {
        const label = token.symbol || asset;
        const text = `${label.toUpperCase()} is around ${formatMarketPrice(price)} right now on Base.`;
        return {
          data: { asset: label, address: token.address, priceUsd: price, source: "dexscreener" },
          control: { type: "text", text },
        };
      }
    }

    if (!wantsToken) {
      const mark = await fetchAvantisMarkPrice(asset);
      if (mark) {
        const text = `${asset} is around ${formatMarketPrice(mark)} right now via Avantis mark price.`;
        return { data: { asset, priceUsd: mark, source: "avantis" }, control: { type: "text", text } };
      }
    }

    return {
      data: { error: "price unavailable", asset },
      control: {
        type: "text",
        text: `i couldn't price ${asset} right now. for Base tokens, paste the contract address; for stocks, try a supported Avantis market like AAPL, TSLA, COIN, NVDA, or MSFT.`,
      },
    };
  }

  async bankr_get_launches(args: {
    limit?: number;
    sort?: BankrLaunchSort;
  }): Promise<ToolResult> {
    const limit = Math.min(args.limit ?? 8, 8);
    const sort = args.sort ?? "mixed";
    try {
      const result = await getBankrLaunches(limit, sort);
      if (result.tokens.length === 0) throw new Error("No Bankr trending data");

      const text = formatBankrLaunchesText(result);

      return {
        data: { count: result.tokens.length, sort: result.sort },
        control: {
          type: "launches",
          text,
          tokens: result.tokens,
        },
      };
    } catch (err) {
      console.warn("⚠️ Bankr trending fetch error:", err);
      return {
        data: { launches: [] },
        control: {
          type: "text",
          text: "Couldn't load trending Bankr projects right now — try again in a minute.",
        },
      };
    }
  }

  async worldcup_get_matches(args: {
    date?: string;
    team?: string;
    featured?: boolean;
  }): Promise<ToolResult> {
    const team = args.team?.trim();
    const featured = team ? false : (args.featured ?? false);
    const dateFrom = team ? undefined : args.date;
    const dateTo =
      !team && dateFrom
        ? new Date(new Date(dateFrom).getTime() + 2 * 24 * 60 * 60_000)
            .toISOString()
            .slice(0, 10)
        : undefined;
    const text = team
      ? `World Cup matches for ${team}:`
      : featured
        ? "featured World Cup matches — big teams like England, Brazil, USA, Argentina:"
        : "upcoming World Cup matches — next games by kickoff:";
    return {
      data: { dateFrom, dateTo, team, featured },
      control: {
        type: "worldcup_matches",
        text,
        dateFrom,
        dateTo,
        team,
        featured,
      },
    };
  }

  async worldcup_propose_bet(args: {
    matchId?: string;
    team?: string;
    stakeUsd?: number;
    amountBasemate?: number;
  }): Promise<ToolResult> {
    return {
      data: args,
      control: {
        type: "worldcup_bet_wizard",
        text: args.team
          ? `opening a bet on ${args.team}…`
          : "pick a match and team to bet on:",
        state: {
          matchId: args.matchId,
          team: args.team,
          stakeUsd: args.stakeUsd,
          amountBasemate: args.amountBasemate,
        },
      },
    };
  }

  async worldcup_list_open_bets(): Promise<ToolResult> {
    const bets = await WorldCupBetAdapter.listOpenByBettor(this.ctx.inboxId);
    return {
      data: { count: bets.length },
      // Markdown so XMTP renders the **bold** labels and `- - -` dividers like
      // the Daily Portfolio Review card instead of dumping raw asterisks.
      control: { type: "markdown", text: formatOpenBetsReport(bets) },
    };
  }

  async bankr_launch_token(args: {
    name?: string;
    symbol?: string;
  }): Promise<ToolResult> {
    // XMTP / Base App still runs native B20 launches. iMessage/WhatsApp do not.
    if (this.ctx.conversation || this.ctx.positionsChannel === "xmtp") {
      return {
        data: { mode: "b20_stock" },
        control: {
          type: "launch_guide",
          text: "let's launch a B20 stock-paired token",
          state: {
            name: args.name,
            symbol: args.symbol,
            mode: "b20_stock",
          },
        },
      };
    }
    return {
      data: { moved: "istonks" },
      control: {
        type: "text",
        text:
          "token launches moved to iStonks — text that line or open basemate.app/istonks/launch",
      },
    };
  }

  // ─── Aerodrome handlers ──────────────────────────────────────────────────────

  async aerodrome_get_pools(args: { limit?: number; asset?: string }): Promise<ToolResult> {
    return _aerodrome_get_pools(this.ctx, args);
  }

  async azzle_get_open_tasks(args: { limit?: number }): Promise<ToolResult> {
    const limit = Math.min(args.limit ?? 10, 25);
    const SUBGRAPH_URL =
      process.env.AZZLE_SUBGRAPH_URL ??
      "https://api.studio.thegraph.com/query/1754651/azzle-protocol/v0.3";
    const query = `query { tasks(where: { state: "POSTED" }, orderBy: createdAt, orderDirection: desc, first: ${limit}) { id state escrowAmount createdAt updatedAt settlementDigest poster { id } worker { id } } }`;
    try {
      const res = await fetch(SUBGRAPH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`AZZLE subgraph ${res.status}`);
      const json = (await res.json()) as {
        data?: { tasks?: Array<{ id: string; escrowAmount: string; createdAt: string; updatedAt: string; settlementDigest: string; poster: { id: string }; worker: { id: string } | null }> };
        errors?: unknown;
      };
      if (json.errors) throw new Error("AZZLE subgraph query error");
      const tasks = json.data?.tasks ?? [];
      if (tasks.length === 0) {
        return {
          data: { tasks: [] },
          control: { type: "text", text: "no open tasks on AZZLE right now — check back soon or post one yourself at azzle.org 💙" },
        };
      }

      const sections = tasks.map((t) => {
        const escrow = (Number(t.escrowAmount) / 1e6).toFixed(2);
        const posted = new Date(Number(t.createdAt) * 1000);
        const ago = (() => {
          const mins = Math.floor((Date.now() - posted.getTime()) / 60_000);
          if (mins < 60) return `${mins}m ago`;
          if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
          return `${Math.floor(mins / 1440)}d ago`;
        })();
        const poster = t.poster.id;
        const posterShort = `${poster.slice(0, 6)}…${poster.slice(-4)}`;
        return [
          `**Task #${t.id}** · $${escrow} USDC`,
          `📋 posted ${ago} by \`${posterShort}\``,
          `🔑 digest \`${t.settlementDigest.slice(0, 10)}…\``,
          `💬 _description is off-chain — message the poster on XMTP to see terms_`,
          `👤 poster: \`${poster}\``,
        ].join("\n");
      });

      const header = tasks.length === 1
        ? `**1 open task on AZZLE** ([azzle.org](https://azzle.org))`
        : `**${tasks.length} open tasks on AZZLE** ([azzle.org](https://azzle.org))`;

      const footer = [
        ``,
        `━━━━━━━━━━━━━━━━━`,
        `**To claim:** need ≥ $20 USDC + 1,000 AZZLE in your AgentDepositVault`,
        `Message the poster on XMTP to get the full task brief before claiming`,
        `Say _"claim task #<id>"_ when you're ready`,
      ].join("\n");

      const text = `${header}\n\n${sections.join("\n\n")}\n${footer}`;
      return { data: { count: tasks.length, tasks }, control: { type: "text", text } };
    } catch (err) {
      console.warn("⚠️ AZZLE subgraph error:", err);
      return {
        data: { error: String(err) },
        control: { type: "text", text: "couldn't reach the AZZLE subgraph right now — try again in a moment or check azzle.org directly" },
      };
    }
  }

  async aerodrome_prepare_swap(args: {
    fromAsset: string;
    toAsset: string;
    amount: string;
    isUsd?: boolean;
  }): Promise<ToolResult> {
    return _aerodrome_prepare_swap(this.ctx, args);
  }

  async aerodrome_prepare_add_liquidity(args: {
    tokenA: string;
    tokenB: string;
    amountA: string;
    amountB: string;
  }): Promise<ToolResult> {
    return _aerodrome_prepare_add_liquidity(this.ctx, args);
  }

  // ─── Avantis perpetual futures handlers ──────────────────────────────────
  // Avantis is a perps DEX on Base. The tx-builder (tx-builder.avantisfi.com)
  // is a public, keyless GET API that returns ready-to-sign { to, data, value }
  // calldata envelopes — same server-side pattern we use for the Uniswap Trade
  // API. We never write the openTrade calldata ourselves; we forward what the
  // tx-builder returns into wallet_sendCalls so the user signs natively in Base
  // App. Collateral is always USDC; reads come from data.avantisfi.com.

  async avantis_guided_trade(): Promise<ToolResult> {
    return _avantis_guided_trade(this.ctx);
  }

  async avantis_update_perp_profile(): Promise<ToolResult> {
    return _avantis_update_perp_profile(this.ctx);
  }

  async avantis_get_markets(args: { limit?: number }): Promise<ToolResult> {
    return _avantis_get_markets(this.ctx, args);
  }

  async avantis_get_positions(
    args: { target?: string; pnlCard?: boolean; pair?: string } = {},
  ): Promise<ToolResult> {
    return _avantis_get_positions(this.ctx, args);
  }

  async avantis_close_position(args: {
    pair?: string;
    pairIndex?: number;
    tradeIndex?: number;
    collateralToClose?: string;
    walletScope?: AvantisCloseWalletScope;
  }): Promise<ToolResult> {
    return _avantis_close_position(this.ctx, args);
  }

  async avantis_close_all_positions(args: { walletScope?: AvantisCloseWalletScope } = {}): Promise<ToolResult> {
    return _avantis_close_all_positions(this.ctx, args);
  }

  async avantis_update_tpsl(args: {
    pair?: string;
    pairIndex?: number;
    tradeIndex?: number;
    takeProfit?: string;
    stopLoss?: string;
  }): Promise<ToolResult> {
    return _avantis_update_tpsl(this.ctx, args);
  }

  async avantis_cancel_limit(args: {
    pair?: string;
    pairIndex?: number;
    tradeIndex?: number;
  }): Promise<ToolResult> {
    return _avantis_cancel_limit(this.ctx, args);
  }

  async avantis_prepare_trade(args: {
    pair: string;
    side: "long" | "short";
    leverage?: number;
    collateral?: string;
    orderType?: AvantisOrderType;
    openPrice?: string;
    takeProfit?: string;
    stopLoss?: string;
  }): Promise<ToolResult> {
    const { isKnownStockPairCandidate } = await import("@/discovery/doppler/stockRegistry.js");
    const msg = this.ctx.userMessage ?? "";
    const looksLikeSpotGift =
      /\b(send|gift|give|buy)\b/i.test(msg) && !/\b(long|short|leverage|perp)\b/i.test(msg);
    if (looksLikeSpotGift && isKnownStockPairCandidate(args.pair)) {
      if (/\b(send|gift|give)\b/i.test(msg)) {
        return {
          data: { error: "use gift_stock" },
          control: {
            type: "text",
            text: "that's a stock gift — tell me who it's for (e.g. send mom $25 of Apple).",
          },
        };
      }
      return _uniswap_prepare_swap(this.ctx, {
        fromAsset: "USDC",
        toAsset: args.pair,
        amount: args.collateral ?? "25",
        isUsd: true,
      });
    }
    return _avantis_prepare_trade(this.ctx, args);
  }

  async yield_compare(args: {
    token: string;
    amount?: string;
    isUsd?: boolean;
  }): Promise<ToolResult> {
    return _yield_compare(this.ctx, args);
  }
}


/** PnL / positions — routed before the LLM because tool_choice is unreliable for these phrases. */
export async function routeAvantisPositionsIntent(
  message: string,
  ctx: RespondCtx,
): Promise<ToolResult | null> {
  if (!isAvantisPnlCardIntent(message) && !isAvantisPositionsListIntent(message)) return null;
  const toolbox = new Toolbox({ ...ctx, userMessage: message });
  const args = {
    pnlCard: isAvantisPnlCardIntent(message),
    pair: extractAvantisPairFromPnlText(message),
  };
  recordRoutingEvalTool(ctx, "avantis_get_positions", args);
  return toolbox.avantis_get_positions(args);
}

/** Earn / yield_compare — routed before the LLM when token is parseable from the message. */
export async function routeYieldCompareIntent(
  message: string,
  ctx: RespondCtx,
): Promise<ToolResult | null> {
  if (!isYieldCompareIntent(message)) return null;
  const token = extractYieldTokenFromMessage(message);
  if (!token) return null;

  const toolbox = new Toolbox({ ...ctx, userMessage: message });
  const amountInfo = extractYieldAmountFromMessage(message);
  const args = {
    token,
    ...(amountInfo ? { amount: amountInfo.amount, isUsd: amountInfo.isUsd } : {}),
  };
  recordRoutingEvalTool(ctx, "yield_compare", args);
  return toolbox.yield_compare(args);
}

/** Balance / portfolio — aggregated summary + signed web link (XMTP + custodial fallback). */
export async function routePortfolioBalanceIntent(
  message: string,
  ctx: RespondCtx,
): Promise<ToolResult | null> {
  if (!isPortfolioBalanceIntent(message)) return null;
  if (ctx.copyPlatform !== "xmtp" && !ctx.custodialWallet) return null;
  const toolbox = new Toolbox({ ...ctx, userMessage: message });
  recordRoutingEvalTool(ctx, "get_portfolio_summary", {});
  return toolbox.get_portfolio_summary();
}

/** World Cup open bets list — "show my world cup bets", "what wc bets do I have". */
export async function routeWorldCupOpenBetsIntent(
  message: string,
  ctx: RespondCtx,
): Promise<ToolResult | null> {
  if (!WORLD_CUP_ENABLED) return null;
  if (!isWorldCupOpenBetsIntent(message)) return null;
  const toolbox = new Toolbox({ ...ctx, userMessage: message });
  recordRoutingEvalTool(ctx, "worldcup_list_open_bets", {});
  return toolbox.worldcup_list_open_bets();
}

/** Staked/supplied balance reads — on-chain, never from prepared tx memory. */
export async function routeEarnPositionIntent(
  message: string,
  ctx: RespondCtx,
): Promise<ToolResult | null> {
  if (!isEarnPositionReadIntent(message)) return null;
  if (isAvantisPositionsListIntent(message) || isAvantisPnlCardIntent(message)) return null;
  // "show my world cup positions" must not be treated as an earn/staking check.
  if (WORLD_CUP_ENABLED && isWorldCupOpenBetsIntent(message)) return null;
  const toolbox = new Toolbox({ ...ctx, userMessage: message });
  const lower = message.toLowerCase();

  const namesSpecificProtocol = /\bmoon\s*well\b|\bmoonwell\b|\bmorpho\b|\baave\b/.test(lower);
  if (!namesSpecificProtocol && (ctx.copyPlatform === "xmtp" || ctx.custodialWallet)) {
    recordRoutingEvalTool(ctx, "get_staking_summary", {});
    const summary = await toolbox.get_staking_summary();
    if (summary) return summary;
  }

  if (/\bmoon\s*well\b|\bmoonwell\b/.test(lower)) {
    recordRoutingEvalTool(ctx, "moonwell_get_position", {});
    return toolbox.moonwell_get_position();
  }

  const asset = extractYieldTokenFromMessage(message) ?? undefined;
  const morphoArgs = asset ? { asset } : {};
  if (/\bmorpho\b/.test(lower) || !/\b(aave|moonwell|moon\s*well)\b/.test(lower)) {
    recordRoutingEvalTool(ctx, "morpho_get_position", morphoArgs);
    return toolbox.morpho_get_position(morphoArgs);
  }

  return null;
}

/**
 * High-traffic intents routed before the LLM (and on OpenAI failure) because
 * tool_choice alone is unreliable for support, close, earn, and positions/PnL.
 */
export async function routeDeterministicIntent(
  message: string,
  ctx: RespondCtx,
): Promise<ToolResult | null> {
  const toolbox = new Toolbox({ ...ctx, userMessage: message });

  if (isSupportIntent(message)) {
    // Don't immediately offer the support group — let the LLM troubleshoot first.
    // The offer_support tool will fire only if the LLM decides it can't resolve the issue.
    return null;
  }

  if (/\bsweep\b/i.test(message) || /\b(exit|close)\s+everything\b/i.test(message)) {
    const to = message.match(/0x[a-fA-F0-9]{40}/)?.[0];
    recordRoutingEvalTool(ctx, "sweep_funds", { to });
    return toolbox.sweep_funds({ to });
  }

  // Perp mechanics / advice questions ("liquidation price for trade #0?",
  // "should i close?") must reach the LLM to be ANSWERED — never deterministically
  // routed to close/positions (which dumps a card and ignores the question).
  const perpInfoQuestion = isPerpInfoOrAdviceQuestion(message);

  const moonwellWithdraw = parseMoonwellWithdrawIntent(message);
  if (moonwellWithdraw) {
    recordRoutingEvalTool(ctx, "moonwell_prepare_withdraw", { ...moonwellWithdraw });
    return toolbox.moonwell_prepare_withdraw(moonwellWithdraw);
  }

  const morphoWithdraw = parseMorphoWithdrawIntent(message);
  if (morphoWithdraw) {
    recordRoutingEvalTool(ctx, "morpho_prepare_withdraw", { ...morphoWithdraw });
    return toolbox.morpho_prepare_withdraw(morphoWithdraw);
  }

  const closeIntent = perpInfoQuestion ? null : parseAvantisCloseIntent(message);
  if (closeIntent?.closeAll) {
    const walletScope = inferAvantisCloseWalletScope(message);
    recordRoutingEvalTool(ctx, "avantis_close_all_positions", { walletScope });
    return toolbox.avantis_close_all_positions({ walletScope });
  }
  if (closeIntent && !closeIntent.closeAll) {
    const closeArgs = {
      tradeIndex: closeIntent.tradeIndex,
      pairIndex: closeIntent.pairIndex,
      pair: closeIntent.pair,
      walletScope: inferAvantisCloseWalletScope(message),
    };
    recordRoutingEvalTool(ctx, "avantis_close_position", closeArgs);
    return toolbox.avantis_close_position(closeArgs);
  }

  const wcOpenBetsResult = await routeWorldCupOpenBetsIntent(message, ctx);
  if (wcOpenBetsResult) return wcOpenBetsResult;

  const portfolioBalanceResult = await routePortfolioBalanceIntent(message, ctx);
  if (portfolioBalanceResult) return portfolioBalanceResult;

  const yieldResult = await routeYieldCompareIntent(message, ctx);
  if (yieldResult) return yieldResult;

  const earnPositionResult = await routeEarnPositionIntent(message, ctx);
  if (earnPositionResult) return earnPositionResult;

  const priceLookup = extractPriceLookup(message);
  if (priceLookup) {
    recordRoutingEvalTool(ctx, "get_market_price", priceLookup);
    return toolbox.get_market_price(priceLookup);
  }

  if (isTrendingGroupsIntent(message)) {
    const args = { limit: 3 };
    recordRoutingEvalTool(ctx, "get_trending", args);
    return toolbox.get_trending(args);
  }
  if (isTrendingTokensIntent(message)) {
    const args = { limit: 8, sort: "mixed" as BankrLaunchSort };
    recordRoutingEvalTool(ctx, "bankr_get_launches", args);
    return toolbox.bankr_get_launches(args);
  }

  // Let the LLM field perp info/advice questions instead of dumping a positions card.
  if (perpInfoQuestion) return null;
  return routeAvantisPositionsIntent(message, ctx);
}

/** When OpenAI is down, deterministic fallback for high-traffic intents. */
export async function tryAiDownFallback(
  message: string,
  convId: string,
  ctx: RespondCtx,
  appendHistory: (user: string, assistant: string) => void,
): Promise<AIResponse | null> {
  const result = await routeDeterministicIntent(message, ctx);
  if (result?.control) {
    appendHistory(message, historyTextForControl(result.control));
    return result.control;
  }
  return null;
}

export function scoreGroup(g: NSGroup, query: string): number {
  let score = 0;
  const q = query.toLowerCase();
  const name = (g.name || "").toLowerCase();
  if (name.includes(q)) score += 5;
  const desc = (g.description || "").toLowerCase();
  if (desc.includes(q)) score += 3;
  for (const t of g.tags || []) {
    if (t.toLowerCase().includes(q)) score += 2;
  }
  for (const t of g.ai_generated_tags || []) {
    if (t.toLowerCase().includes(q)) score += 1;
  }
  return score;
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Keep the last N user+assistant turns per conversation (no tool messages — keeps tokens lean)
export const MAX_HISTORY_TURNS = 6; // 3 user + 3 assistant = 6 messages
export const HISTORY_BOOTSTRAP_MIN = 4;
export const HISTORY_BOOTSTRAP_FETCH = 12;

// Tools whose results need a longer reply to render usefully (multi-item lists,
// market data, capability rundowns, perp guidance). Used to size the completion
// budget for the round that turns tool results into prose.
const COMPLEX_TOOLS = new Set<string>([
  "yield_compare",
  "avantis_get_positions",
  "avantis_get_markets",
  "avantis_prepare_trade",
  "avantis_guided_trade",
  "get_trending",
  "bankr_get_launches",
  "worldcup_get_matches",
  "azzle_get_open_tasks",
]);

/**
 * Resolve the completion-token budget for the *next* round from the tools that
 * fired in the prior round. Pure routing (no tools) stays lean at 400; a simple
 * tool result gets 800; a complex/listing tool gets 1200 so replies don't get
 * cut off mid-sentence.
 */
export function resolveMaxTokens(priorRoundToolNames: string[]): number {
  // Budgets include reasoning-token headroom (gpt-5.4-mini bills hidden
  // reasoning against the completion cap), so even the floor stays generous.
  if (priorRoundToolNames.some((n) => COMPLEX_TOOLS.has(n))) return 2500;
  if (priorRoundToolNames.length > 0) return 2048;
  return 1024;
}

// Advisory / strategy / analysis queries benefit from a stronger model than the
// fast tool-dispatch default. When ADVISORY_MODEL is configured, these route to
// it (e.g. Claude via the Bankr gateway); otherwise behavior is unchanged.
const COMPLEX_QUERY_PATTERNS = [
  /\b(strateg(?:y|ies)|advice|advise|should i|what do you think|recommend|portfolio|analy[sz]e|compare|\bvs\b|explain why|walk me through|teach me)\b/i,
];

export function isComplexQuery(message: string): boolean {
  return COMPLEX_QUERY_PATTERNS.some((r) => r.test(message));
}

/**
 * Pick the model for a turn: the advisory model for complex/strategy queries
 * when configured, else the fast default. Returns the default model unchanged
 * when ADVISORY_MODEL is unset (feature is off).
 */
export function resolveModelForMessage(defaultModel: string, message: string): string {
  const advisory = getAdvisoryModel();
  if (advisory && isComplexQuery(message)) return advisory;
  return defaultModel;
}

/** Rough token estimate (≈4 chars/token) for a set of chat messages. */
function estimateTokens(msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): number {
  return msgs.reduce((n, m) => n + Math.ceil(String(m.content ?? "").length / 4), 0);
}

/**
 * Keep history within a token budget for long chats. Recent turns are kept
 * verbatim; older turns collapse into a single "[earlier context]" line so the
 * model retains the gist without paying for the full transcript.
 */
export function compactHistory(
  msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  budgetTokens = 4000,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  if (estimateTokens(msgs) <= budgetTokens) return msgs;
  const keep = msgs.slice(-4);
  const older = msgs.slice(0, -4);
  const summary = older
    .filter((m) => m.role === "assistant" && typeof m.content === "string")
    .map((m) => String(m.content).slice(0, 120))
    .join(" | ");
  if (!summary) return keep;
  return [{ role: "assistant", content: `[earlier context] ${summary}` }, ...keep];
}

