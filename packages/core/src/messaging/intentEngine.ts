import OpenAI from "openai";
import { z } from "zod";

import { createBankrLlmClient, DEFAULT_CHAT_MODEL, logLlmTurn, openAiChatParams } from "@/llm/config.js";
import { isPortfolioReviewIntent } from "@/portfolio-reviews/commands.js";
import { BASEMATE_IDENTITY_NOTE } from "@/prompts/soul.js";
import { extractPrimaryPersonTag } from "@/messaging/utils/groupTag.utils.js";

const IntentActionSchema = z.enum([
  "unknown",
  "discovery",
  "confirm",
  "cancel",
  "choose_basemate_wallet",
  "change_signing_wallet",
  "portfolio_review",
  "account_link",
  "perp_trade",
  "perp_setup_skip",
  "perp_setup_save",
  "perp_tier_choice",
  "price_alert_create",
  "price_alert_list",
  "price_alert_cancel",
  "price_alert_followup",
  "swap",
  "send_token",
  "contact_list",
  "bankr_launch",
  "bankr_trending",
  "yield",
  "token_analysis",
  "support",
  "main_wallet_balance",
  "main_wallet_fund",
  "main_wallet_transfer",
  "main_wallet_offramp",
  "sweep",
  "worldcup_bet",
  "worldcup_odds",
]);

const IntentDomainSchema = z.enum([
  "system",
  "wallet",
  "perps",
  "price_alerts",
  "portfolio",
  "account_linking",
  "discovery",
  "unknown",
]);

const WalletScopeSchema = z.enum([
  "main_server_wallet",
  "basemate_wallet",
  "both_wallets",
  "unknown",
]);

const TransferDirectionSchema = z.enum([
  "main_to_external",
  "unknown",
]);

const AssetAmountSchema = z.object({
  asset: z.string(),
  amount: z.string().nullable().default(null),
  amountUsd: z.string().nullable().default(null),
  all: z.boolean().default(false),
});

export const ImessageIntentSchema = z.object({
  domain: IntentDomainSchema.default("unknown"),
  action: IntentActionSchema.default("unknown"),
  walletScope: WalletScopeSchema.default("unknown"),
  direction: TransferDirectionSchema.default("unknown"),
  assets: z.array(z.string()).default([]),
  amounts: z.array(AssetAmountSchema).default([]),
  targetAddress: z.string().nullable().default(null),
  targetName: z.string().nullable().default(null),
  leaderboardCategory: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0),
});

export type ImessageIntent = z.infer<typeof ImessageIntentSchema>;
export type ImessageIntentAction = ImessageIntent["action"];

export interface ImessageIntentContext {
  pendingTrade?: boolean;
  pendingPerpFlow?: "setup_choice" | "trade" | "profile_tier" | "profile_collateral";
  pendingPriceAlert?: boolean;
  pendingAccountLink?: boolean;
  pendingSweep?: boolean;
  pendingWorldCupMatch?: boolean;
  pendingEscrowConfirm?: boolean;
  /** Advanced Flash order awaiting chat confirm (not market /pay). */
  pendingFlashOrder?: boolean;
  /** iStonks launch wizard mid-flight for this conversation + sender. */
  pendingLaunch?: boolean;
}

export interface ImessageIntentEngine {
  classify(message: string, context?: ImessageIntentContext): Promise<ImessageIntent>;
}

const UNKNOWN_INTENT: ImessageIntent = ImessageIntentSchema.parse({});

const INTENT_JSON_SCHEMA = {
  name: "imessage_intent",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: IntentActionSchema.options,
        description: "Single best action requested by the user.",
      },
      domain: {
        type: "string",
        enum: IntentDomainSchema.options,
        description: "Feature area that should receive this message.",
      },
      walletScope: {
        type: "string",
        enum: WalletScopeSchema.options,
        description: "Which wallet the user is talking about.",
      },
      direction: {
        type: "string",
        enum: TransferDirectionSchema.options,
        description: "Transfer direction when the action moves funds.",
      },
      assets: {
        type: "array",
        items: { type: "string" },
        description: "Assets explicitly requested or asked about.",
      },
      amounts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            asset: { type: "string" },
            amount: { type: ["string", "null"] },
            amountUsd: { type: ["string", "null"] },
            all: { type: "boolean" },
          },
          required: ["asset", "amount", "amountUsd", "all"],
        },
      },
      targetAddress: {
        type: ["string", "null"],
        description: "0x wallet target, if the user provided one.",
      },
      targetName: {
        type: ["string", "null"],
        description: "basename, ENS name, or @handle target, if provided.",
      },
      leaderboardCategory: {
        type: ["string", "null"],
        description: "Copy-trading leaderboard category, if requested.",
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: [
      "domain",
      "action",
      "walletScope",
      "direction",
      "assets",
      "amounts",
      "targetAddress",
      "targetName",
      "leaderboardCategory",
      "confidence",
    ],
  },
  strict: true,
} as const;

const SYSTEM_PROMPT = [
  "Classify one iMessage user message for Basemate. Return JSON only.",
  BASEMATE_IDENTITY_NOTE,
  "Use identity only to recognize references to Basemate; never add personality, prose, or markdown to the JSON result.",
  "Main server wallet means the custodial wallet Basemate manages for normal user funds, swaps, sends, and onramps.",
  "Basemate wallet means the server wallet used for PerpMate strategy/perp execution.",
  "If the user asks to close, exit, or flatten Avantis/perp positions in the Basemate/server/strategy wallet, classify as perp_trade with walletScope basemate_wallet; use both_wallets only when they explicitly say both/all wallets.",
  "For '$3 worth ETH' set asset ETH with amount null and amountUsd '3'. Do not invent an ETH amount.",
  "For confirmations or cancellations inside a pending transfer context, classify confirm/cancel.",
  "Classify portfolio review scheduling requests as portfolio_review.",
  "Classify show/view/check my portfolio or holdings requests as main_wallet_balance.",
  "Classify Basemate account connection requests as account_link.",
  "Classify leverage/long/short/PerpMate/Avantis trade requests as perp_trade.",
  "Classify price alert creation/list/cancel/follow-up into price_alert_create, price_alert_list, price_alert_cancel, or price_alert_followup.",
  "Use discovery for normal open-ended Base/token/community questions that should go to Basemate's general AI brain.",
  "Classify normal spot swaps/buys/sells as swap. Classify token sends/transfers to another wallet as send_token.",
  "Classify requests to list/show/view the user's saved contacts or contact book as contact_list.",
  "Classify token launches as bankr_launch (B20 on Base App; iStonks on iMessage — Bankr deploys are retired) and trending/new launch requests as bankr_trending.",
  "When a launch wizard is pending, classify a go-ahead ('confirm', 'yes', 'launch it', 'send it') as confirm and a backout ('cancel', 'nvm', 'stop') as cancel.",
  "Classify yield/earn/lend/supply requests as yield. If the user asks to show/check or close/withdraw/exit their Moonwell (or 'moon well') stake, supplied balance, position, collateral, debt, or rewards, classify as yield.",
  "Classify token contract/chart/analyze questions as token_analysis.",
  "Classify main wallet balance, funding, transfer, and fiat offramp requests with the main_wallet_* actions.",
  "Classify requests to sweep, exit everything, close all positions and send all funds to a destination wallet as sweep.",
  "Classify casual acknowledgements like lol, lmao, ok, cool, bet, haha as discovery unless the context shows an active pending confirmation/cancellation.",
  "Classify World Cup betting requests ('put 250k on Brazil', 'bet $5 on France', 'wager on Argentina') as worldcup_bet. Put the team name in targetName and the stake in amounts.",
  "Classify World Cup odds requests ('what are the odds on Brazil', 'odds on USA vs Mexico', 'show me Brazil odds') as worldcup_odds. Put the team name in targetName.",
].join("\n");

export class LlmImessageIntentEngine implements ImessageIntentEngine {
  private openai?: OpenAI;
  private model: string;
  private injectedClient: boolean;

  constructor(opts?: { openai?: OpenAI; model?: string }) {
    this.openai = opts?.openai ?? (process.env.BANKR_LLM_API_KEY ? createBankrLlmClient() : undefined);
    this.model = opts?.model ?? DEFAULT_CHAT_MODEL;
    this.injectedClient = Boolean(opts?.openai);
  }

  async classify(message: string, context: ImessageIntentContext = {}): Promise<ImessageIntent> {
    // Phase 2: Skip the extra LLM classification call. basicImessageIntent handles all
    // stateful (pending) routing at high confidence (≥0.85). Everything else falls
    // through to DiscoveryAI which runs its own full LLM pass — paying for two LLM
    // calls per uncertain turn was the main cost driver. Pending-state rules in
    // basicImessageIntent are deterministic and don't need LLM confirmation.
    return basicImessageIntent(message, context);
  }

}

export function unknownImessageIntent(): ImessageIntent {
  return { ...UNKNOWN_INTENT, assets: [], amounts: [] };
}

export function basicImessageIntent(message: string, context: ImessageIntentContext = {}): ImessageIntent {
  const normalized = message
    .toLowerCase()
    .replaceAll("\n", " ")
    .replaceAll(",", " ")
    .replaceAll('"', " ")
    .trim();
  const tokens = normalized.split(" ").map(cleanToken).filter(Boolean);
  const tokenSet = new Set(tokens);
  const has = (...words: string[]) => words.some((word) => tokenSet.has(word));
  const hasBasemateWallet = has("basemate", "server", "strategy");
  const targetAddress = tokens.find((token) => token.startsWith("0x") && token.length === 42) ?? null;
  const targetName =
    tokens.find(
      (token) =>
        /\.(?:base\.)?eth$/i.test(token) ||
        /\.cb\.id$/i.test(token),
    ) ?? null;
  const amounts = basicAmounts(tokens);
  const amountAssets = amounts.map((amount) => amount.asset);
  const isClosePerpIntent = has("close", "exit", "flatten") &&
    (has("position", "positions", "perp", "perps", "trade", "trades", "avantis", "wallet", "wallets") || hasBasemateWallet) &&
    !isMoonwellYieldIntent(normalized);
  const assets = [...new Set(isClosePerpIntent ? [...amountAssets, ...basicAssetMentions(tokens)] : amountAssets)];

  if (hasPendingActionContext(context) && has("confirm", "yes", "yep", "yeah", "yup", "ok", "okay")) {
    return intent({ domain: "system", action: "confirm", confidence: 0.9 });
  }
  const hardCancel = has("cancel", "canecel", "nope", "stop", "abort", "nvm");
  const softSkip = has("skip");
  const tradeStepSkip = context.pendingPerpFlow === "trade" && (softSkip || has("no", "none"));
  if (hardCancel || softSkip || has("no")) {
    if (context.pendingPerpFlow === "setup_choice" || context.pendingPerpFlow === "profile_tier") {
      return intent({ domain: "perps", action: "perp_setup_skip", confidence: 0.9 });
    }
    if (tradeStepSkip) {
      return intent({ domain: "perps", action: "perp_trade", confidence: 0.8 });
    }
    if (hasPendingActionContext(context)) {
      return intent({ domain: "system", action: "cancel", confidence: 0.9 });
    }
  }
  // "basemate account" / "use basemate account" -> the CDP embedded wallet path.
  // Require "account" (not "wallet") and exclude perp-close scope phrasing like
  // "close my basemate wallet positions".
  if (has("basemate") && has("account") && !isClosePerpIntent) {
    return intent({ domain: "system", action: "choose_basemate_wallet", confidence: 0.9 });
  }
  if (has("change", "switch", "update") && has("signing", "transaction", "tx")) {
    return intent({ domain: "system", action: "change_signing_wallet", confidence: 0.8 });
  }
  if (context.pendingPriceAlert && targetAddress) {
    return intent({ domain: "price_alerts", action: "price_alert_followup", targetAddress, confidence: 0.85 });
  }
  if (has("sweep") || (has("exit", "close") && has("everything"))) {
    return intent({ domain: "wallet", action: "sweep", walletScope: "both_wallets", targetAddress, confidence: 0.9 });
  }
  if (context.pendingAccountLink) {
    return intent({ domain: "account_linking", action: "account_link", confidence: 0.7 });
  }
  if (context.pendingPerpFlow === "setup_choice" && has("setup", "defaults", "profile")) {
    return intent({ domain: "perps", action: "perp_setup_save", confidence: 0.9 });
  }
  if (context.pendingPerpFlow === "profile_tier" && has("steady", "tactical", "aggressive", "basemaxxing")) {
    return intent({ domain: "perps", action: "perp_tier_choice", confidence: 0.9 });
  }
  if (context.pendingPerpFlow === "profile_collateral" && (amounts.length > 0 || tokens.some(isNumericToken))) {
    return intent({ domain: "perps", action: "perp_trade", amounts, assets, confidence: 0.9 });
  }

  if (isClosePerpIntent) {
    const walletScope =
      has("both") || (has("all") && has("wallets", "accounts"))
        ? "both_wallets"
        : hasBasemateWallet
          ? "basemate_wallet"
          : has("main", "custodial")
            ? "main_server_wallet"
            : "main_server_wallet";
    return intent({ domain: "perps", action: "perp_trade", walletScope, assets, confidence: 0.85 });
  }

  if (isPortfolioReviewIntent(normalized)) {
    return intent({ domain: "portfolio", action: "portfolio_review", confidence: 0.8 });
  }
  if (
    (has("create", "make", "open") && has("wallet")) ||
    ((has("setup") || (has("set") && has("up"))) && has("wallet", "account")) ||
    (has("need") && has("wallet"))
  ) {
    return intent({ domain: "account_linking", action: "account_link", confidence: 0.8 });
  }
  if ((has("link", "connect") && has("account", "base", "wallet")) || has("generate")) {
    return intent({ domain: "account_linking", action: "account_link", confidence: 0.75 });
  }
  if (has("alert", "alerts")) {
    if (has("list", "show", "view", "my")) {
      return intent({ domain: "price_alerts", action: "price_alert_list", confidence: 0.8 });
    }
    if (has("cancel", "delete", "remove", "stop")) {
      return intent({ domain: "price_alerts", action: "price_alert_cancel", confidence: 0.8 });
    }
    return intent({ domain: "price_alerts", action: "price_alert_create", confidence: 0.75 });
  }
  // "notify me when ETH hits 4000" / "ping me if BTC reaches 100k" — price alert without the word "alert"
  if ((has("notify", "ping", "tell") && has("when", "if", "once", "reaches", "hits")) ||
      (has("set") && has("when", "if", "once") && (assets.length > 0 || amounts.length > 0))) {
    return intent({ domain: "price_alerts", action: "price_alert_create", assets, amounts, confidence: 0.8 });
  }
  // Morpho / Moonwell / Aave withdraw — "exit morpho", "withdraw from moonwell", "remove from aave"
  if (
    (has("withdraw", "exit", "close", "remove", "pull", "unstake", "redeem")) &&
    (has("morpho", "moonwell", "aave", "moonlend", "moon well", "yield", "supply", "lending", "staked", "position"))
  ) {
    return intent({ domain: "discovery", action: "yield", amounts, assets, confidence: 0.85 });
  }
  if (has("contacts") || (has("contact") && has("list", "book", "saved", "all"))) {
    if (has("list", "show", "view", "see", "my", "saved", "all", "who", "book")) {
      return intent({ domain: "system", action: "contact_list", confidence: 0.85 });
    }
  }
  if (isProtocolYieldIntent(normalized)) {
    return intent({ domain: "discovery", action: "yield", amounts, assets, confidence: 0.85 });
  }
  if (has("long", "short", "perp", "perps", "leverage", "avantis", "position", "positions", "close") || hasLeverageToken(tokens)) {
    return intent({ domain: "perps", action: "perp_trade", amounts, assets, confidence: 0.8 });
  }
  if (has("launch", "deploy", "create") && has("token", "coin", "memecoin", "bankr")) {
    return intent({ domain: "discovery", action: "bankr_launch", confidence: 0.8 });
  }
  if (has("trending", "launches", "new") && has("token", "tokens", "bankr", "coins")) {
    return intent({ domain: "discovery", action: "bankr_trending", confidence: 0.8 });
  }
  if (has("swap", "buy", "sell", "convert")) {
    return intent({ domain: "discovery", action: "swap", amounts, assets, confidence: 0.8 });
  }
  if (has("send", "sending", "transfer", "transferring", "pay", "move", "moving", "tip", "tipping", "give", "giving", "shoot", "toss", "fire")) {
    return intent({
      domain: "discovery",
      action: "send_token",
      amounts,
      assets,
      targetAddress,
      targetName: targetAddress ? null : targetName,
      confidence: 0.8,
    });
  }
  // Group tag-to-send shorthand after @basemate is stripped: "@Aritra 5 USDC" / "@Aritra $5"
  const personTag = extractPrimaryPersonTag(message);
  if (personTag && amounts.length > 0 && !targetAddress) {
    return intent({
      domain: "discovery",
      action: "send_token",
      amounts,
      assets,
      targetAddress: null,
      targetName: personTag,
      confidence: 0.85,
    });
  }
  if (has("cashout", "offramp", "bank")) {
    return intent({
      domain: "wallet",
      action: "main_wallet_offramp",
      walletScope: "main_server_wallet",
      amounts,
      assets,
      confidence: 0.8,
    });
  }
  if (has("onramp") || (has("on") && has("ramp"))) {
    return intent({ domain: "wallet", action: "main_wallet_fund", walletScope: "main_server_wallet", amounts, confidence: 0.8 });
  }
  // "let's add $5", "i want to add 10", "add some funds", "deposit $20" — funding intent.
  // isFundIntent handles the pre-intent fast path; this catches the intent-classified path.
  if (
    has("add", "deposit", "fund", "load") &&
    (/\$[\d]/.test(normalized) || /\b\d+\s*(usd|usdc|dollars?)?\b/i.test(normalized) || has("funds", "money", "cash", "crypto", "wallet"))
  ) {
    return intent({ domain: "wallet", action: "main_wallet_fund", walletScope: "main_server_wallet", amounts, confidence: 0.85 });
  }
  if (
    (has("wallet", "address") && has("my", "mine")) ||
    has("balance", "balances") ||
    /\bhow\s+much\s+[a-z][a-z0-9]{1,30}\s+do\s+i\s+have\b/i.test(normalized) ||
    isPortfolioViewIntent(normalized)
  ) {
    return intent({ domain: "wallet", action: "main_wallet_balance", walletScope: "main_server_wallet", confidence: 0.8 });
  }
  if (has("fund", "deposit", "top", "up") && has("wallet")) {
    return intent({ domain: "wallet", action: "main_wallet_fund", walletScope: "main_server_wallet", confidence: 0.8 });
  }
  if (has("earn", "yield", "lend", "supply", "deposit", "stake")) {
    return intent({ domain: "discovery", action: "yield", amounts, assets, confidence: 0.8 });
  }
  if (has("analyze", "chart", "contract", "ca", "token")) {
    return intent({ domain: "discovery", action: "token_analysis", targetAddress, confidence: 0.75 });
  }
  if (has("help", "support", "menu", "capabilities")) {
    return intent({ domain: "discovery", action: "support", confidence: 0.8 });
  }

  // Known World Cup 2026 teams — prevent these from being routed to token/yield flows
  const WC_TEAMS = new Set([
    "usa", "united states", "usmnt", "argentina", "brazil", "france", "england", "spain",
    "germany", "portugal", "netherlands", "italy", "mexico", "colombia", "uruguay",
    "morocco", "senegal", "japan", "south korea", "australia", "canada", "ecuador",
    "peru", "chile", "venezuela", "bolivia", "paraguay", "panama", "costa rica",
    "jamaica", "honduras", "el salvador", "wales", "scotland", "denmark", "sweden",
    "norway", "croatia", "serbia", "switzerland", "austria", "poland", "ukraine",
    "turkey", "turkiye", "belgium", "iran", "saudi arabia", "nigeria", "ghana",
    "cameroon", "ivory coast", "cote d'ivoire", "egypt", "algeria", "mali",
    "new zealand", "indonesia", "qatar", "china", "india", "thailand",
  ]);

  const wcBetMatch = normalized.match(
    /\b(?:put|bet|wager|place|throw|backing?|going with)\s+(?:\$?[\d.]+[km]?\s+(?:basemate\s+)?|[\d.]+\s+basemate\s+)?on\s+([a-z][a-z\s]{1,30}?)(?:\s*$|\s*[?.!,])/,
  ) ?? normalized.match(
    /\b(?:[\d.]+[km]?|\$[\d.]+)\s+(?:basemate\s+)?on\s+([a-z][a-z\s]{1,30}?)(?:\s*$|\s*[?.!,])/,
  ) ?? normalized.match(
    /\bbet\s+(?:on\s+)?([a-z][a-z\s]{1,30}?)\s+\$?[\d.]+/,
  );
  if (wcBetMatch) {
    const team = wcBetMatch[1].trim();
    if (team.length >= 3 && !has("swap", "earn", "yield", "perp")) {
      return intent({ domain: "discovery", action: "worldcup_bet", targetName: team, confidence: 0.88 });
    }
  }

  // If message contains a known WC team + bet keyword, route to worldcup even without amount
  if (has("bet", "wager", "put", "back", "backing") || context.pendingWorldCupMatch) {
    for (const team of WC_TEAMS) {
      if (normalized.includes(team)) {
        return intent({ domain: "discovery", action: "worldcup_bet", targetName: team, confidence: 0.87 });
      }
    }
  }

  // If message contains a known WC team + odds keyword, route to worldcup_odds
  if (has("odds", "chance", "chances", "lines", "line", "what")) {
    for (const team of WC_TEAMS) {
      if (normalized.includes(team)) {
        return intent({ domain: "discovery", action: "worldcup_odds", targetName: team, confidence: 0.82 });
      }
    }
  }

  const wcOddsMatch = normalized.match(
    /\b(?:odds?|chances?|lines?|price|prices)\s+(?:on|for)\s+([a-z][a-z\s]{1,30}?)(?:\s*$|\s*[?.!])/,
  ) ?? normalized.match(
    /\b([a-z][a-z\s]{1,30}?)\s+odds?(?:\s*$|\s*[?.!])/,
  );
  if (wcOddsMatch) {
    const team = wcOddsMatch[1].trim();
    if (team.length >= 3 && !has("swap", "earn", "yield", "perp", "token", "coin")) {
      return intent({ domain: "discovery", action: "worldcup_odds", targetName: team, confidence: 0.82 });
    }
  }

  if (context.pendingWorldCupMatch && (has("1", "2", "3", "4", "5", "6") || tokens.length <= 3)) {
    return intent({ domain: "discovery", action: "worldcup_bet", confidence: 0.85 });
  }
  return intent({ domain: "discovery", action: "discovery", confidence: 0.55 });
}

// Tokens that look like asset symbols but are actually prepositions/keywords.
// Used to prevent "send 10 TO alice" from treating "TO" as an asset symbol.
const GENERIC_TOKEN_IGNORE = new Set([
  "TO", "FOR", "AT", "ON", "IN", "THE", "OF", "AND", "OR", "FROM",
  "SEND", "SWAP", "BUY", "SELL", "GET", "WITH", "MY", "YOUR",
]);

function basicAmounts(tokens: string[]): ImessageIntent["amounts"] {
  const amounts: ImessageIntent["amounts"] = [];
  const seenAssets = new Set<string>();
  const allWords = new Set(["all", "whole", "entire", "max", "maximum"]);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!allWords.has(token) && !isNumericToken(token) && !isUsdSuffixToken(token)) continue;

    const next = tokens[i + 1];
    const afterNext = tokens[i + 2];
    if (allWords.has(token)) {
      const asset = firstAssetToken([next, afterNext, tokens[i + 3]]);
      if (asset) {
        amounts.push({ asset, amount: null, amountUsd: null, all: true });
        seenAssets.add(asset.toUpperCase());
        continue;
      }
    }
    const isUsdToken = token.startsWith("$") || token.endsWith("$");
    const value = isUsdToken ? (token.startsWith("$") ? token.slice(1) : token.slice(0, -1)) : token;
    if (!isPositiveNumber(value)) continue;
    if (next === "usdc" || next === "usd") {
      amounts.push({ asset: "USDC", amount: value, amountUsd: null, all: false });
      seenAssets.add("USDC");
    } else if ((isUsdToken || next === "worth") && (next === "eth" || afterNext === "eth")) {
      // "$3 ETH" or "$3 worth of ETH" → USD-denominated ETH amount
      amounts.push({ asset: "ETH", amount: null, amountUsd: value, all: false });
      seenAssets.add("ETH");
    } else if (next === "eth") {
      amounts.push({ asset: "ETH", amount: value, amountUsd: null, all: false });
      seenAssets.add("ETH");
    } else if (isUsdToken && (!next || next === "to" || next === "for")) {
      // A bare "$2" in a send/payment means 2 USDC.
      amounts.push({ asset: "USDC", amount: value, amountUsd: null, all: false });
      seenAssets.add("USDC");
    } else if (next && /^[a-z][a-z0-9]{1,9}$/i.test(next) && !GENERIC_TOKEN_IGNORE.has(next.toUpperCase())) {
      // Generic "NUMBER TOKEN" pattern — e.g. "10000 basemate", "5 degen", "0.5 aero"
      const asset = next.toUpperCase();
      if (!seenAssets.has(asset)) {
        amounts.push({ asset, amount: value, amountUsd: null, all: false });
        seenAssets.add(asset);
      }
    }
  }
  return amounts;
}

function basicAssetMentions(tokens: string[]): string[] {
  const ignored = new Set([
    "a",
    "all",
    "and",
    "app",
    "avantis",
    "basemate",
    "both",
    "close",
    "copy",
    "custodial",
    "exit",
    "flatten",
    "main",
    "my",
    "on",
    "open",
    "perp",
    "perps",
    "position",
    "positions",
    "server",
    "the",
    "trade",
    "trades",
    "trading",
    "wallet",
    "wallets",
  ]);
  const assets: string[] = [];
  for (const token of tokens) {
    if (ignored.has(token) || isNumericToken(token) || isUsdSuffixToken(token)) continue;
    if (/^[a-z][a-z0-9]{1,8}$/i.test(token)) assets.push(token.toUpperCase());
  }
  return assets;
}

export function isPortfolioViewIntent(message: string): boolean {
  if (!/\bportfolio\b/.test(message)) return false;
  if (isPortfolioReviewIntent(message)) return false;
  return true;
}

function isMoonwellYieldIntent(message: string): boolean {
  if (!/\bmoon\s*well\b|\bmoonwell\b/.test(message)) return false;
  const positionRead =
    /\b(my|show|view|check|read|see|what|how)\b/.test(message) &&
    /\b(stake|stakes|staked|position|positions|balance|balances|supplied|supply|collateral|debt|borrowed|rewards?)\b/.test(message);
  const withdraw =
    /\b(close|exit|withdraw|remove|redeem|unstake|unstaked|take out|money back)\b/.test(message) &&
    /\b(stake|stakes|staked|position|positions|supply|supplied|usdc|eth|weth|market|markets|money|all)\b/.test(message);
  return positionRead || withdraw;
}

function isProtocolYieldIntent(message: string): boolean {
  const hasProtocol = /\bmorpho\b|\bmoon\s*well\b|\bmoonwell\b|\baave\b/.test(message);
  if (!hasProtocol) return false;
  if (/\b(swap|buy|sell|convert|exchange|trade)\b/.test(message)) return false;
  const action =
    /\b(stake|staking|deposit|deposits?|deposited|earn|yield|lend|supply|supplied|put|invest)\b/.test(message);
  return action || isMoonwellYieldIntent(message);
}

function hasPendingActionContext(context: ImessageIntentContext): boolean {
  return Boolean(
    context.pendingTrade ||
      context.pendingPerpFlow ||
      context.pendingPriceAlert ||
      context.pendingAccountLink ||
      context.pendingSweep ||
      context.pendingWorldCupMatch ||
      context.pendingEscrowConfirm ||
      context.pendingFlashOrder ||
      context.pendingLaunch,
  );
}

function isSystemAckAction(action: ImessageIntent["action"]): boolean {
  return action === "confirm" || action === "cancel";
}

function firstAssetToken(candidates: Array<string | undefined>): string | null {
  const ignored = new Set(["my", "the", "of", "balance", "wallet", "holdings", "to", "for", "into"]);
  for (const candidate of candidates) {
    if (!candidate || ignored.has(candidate) || isNumericToken(candidate)) continue;
    if (/^0x[a-f0-9]{40}$/i.test(candidate)) return candidate;
    const cleaned = candidate.replace(/^\$/, "");
    if (/^[a-z][a-z0-9]{1,20}$/i.test(cleaned)) return cleaned.toUpperCase();
  }
  return null;
}

function cleanToken(token: string): string {
  let cleaned = token.trim();
  while (cleaned.endsWith(".") || cleaned.endsWith("?") || cleaned.endsWith("!") || cleaned.endsWith(";") || cleaned.endsWith(":")) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned;
}

function isNumericToken(token: string): boolean {
  const value = token.startsWith("$") ? token.slice(1) : token.endsWith("$") ? token.slice(0, -1) : token;
  return isPositiveNumber(value);
}

function isUsdSuffixToken(token: string): boolean {
  return token.endsWith("$") && isPositiveNumber(token.slice(0, -1));
}

function isPositiveNumber(value: string): boolean {
  if (!value) return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function hasLeverageToken(tokens: string[]): boolean {
  return tokens.some((token) => token.endsWith("x") && isPositiveNumber(token.slice(0, -1)));
}

function intent(partial: Partial<ImessageIntent>): ImessageIntent {
  return ImessageIntentSchema.parse({
    ...unknownImessageIntent(),
    ...partial,
    amounts: partial.amounts ?? [],
    assets: partial.assets ?? [],
  });
}
