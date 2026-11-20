import { sanitizeAmount } from "@basemate/shared";
import type { MoonwellWithdrawIntent } from "@/discovery/ai/types.js";
import { extractUsdAmountFromMessage } from "@/discovery/ai/amounts.js";
import { isPortfolioViewIntent } from "@/messaging/intentEngine.js";
import { isAllowedSendRecipient } from "@/discovery/services/sendRecipient.service.js";
type PerpRiskTier = "steady" | "tactical" | "aggressive" | "basemaxxing";
import { MOONWELL_MTOKENS } from "@/portfolio/moonwell.js";

function normalizeYieldTokenSymbol(token: string): string {
  return token.trim().toUpperCase();
}
import { resolveStockToken } from "@/discovery/doppler/stockRegistry.js";

export function parseMoonwellWithdrawIntent(message: string): MoonwellWithdrawIntent | null {
  const m = message.trim().replace(/^(?:@\S+\s+)+/i, "").trim().toLowerCase();
  if (!/\bmoon\s*well\b|\bmoonwell\b/.test(m)) return null;
  if (
    !/\b(close|exit|withdraw|remove|redeem|unstake|unstaked|cash\s*out|take\s+out|get\s+(?:my\s+)?money\s+back|money\s+back)\b/i.test(m)
  ) return null;

  const asset = extractMoonwellWithdrawAsset(message) ?? extractYieldTokenFromMessage(message) ?? undefined;
  const all =
    /\b(all|everything|entire|whole|max|maximum)\b/i.test(m) ||
    /\b(close|exit|money\s+back|get\s+(?:my\s+)?money\s+back)\b/i.test(m);
  const usdMatch = m.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  const tokenMatch = m.match(/\b([0-9]+(?:\.[0-9]+)?)\s*([a-z][a-z0-9]{1,11})\b/i);
  const amount = usdMatch?.[1] ?? tokenMatch?.[1];
  const isUsd = Boolean(usdMatch);

  return { asset, amount, isUsd, all: all || !amount };
}

interface MorphoWithdrawIntent {
  asset?: string;
  amount?: string;
  isUsd?: boolean;
  all: boolean;
  vaultName?: string;
}

export function parseMorphoWithdrawIntent(message: string): MorphoWithdrawIntent | null {
  const m = message.trim().replace(/^(?:@\S+\s+)+/i, "").trim().toLowerCase();
  if (!/\bmorpho\b/.test(m)) return null;
  if (
    !/\b(close|exit|withdraw|remove|redeem|unstake|unstaked|cash\s*out|take\s+out|get\s+(?:my\s+)?money\s+back|money\s+back)\b/i.test(m)
  ) return null;

  const asset = extractYieldTokenFromMessage(message) ?? undefined;
  const all =
    /\b(all|everything|entire|whole|max|maximum)\b/i.test(m) ||
    /\b(close|exit|money\s+back|get\s+(?:my\s+)?money\s+back)\b/i.test(m);
  const usdMatch = m.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  const tokenMatch = m.match(/\b([0-9]+(?:\.[0-9]+)?)\s*([a-z][a-z0-9]{1,11})\b/i);
  const amount = usdMatch?.[1] ?? tokenMatch?.[1];
  const isUsd = Boolean(usdMatch);

  // Extract optional vault name hint (e.g. "from the gauntlet vault")
  const vaultMatch = m.match(/\b(?:from\s+(?:the\s+)?)?(gauntlet|steakhouse|apostro|moonwell|re7|[a-z][a-z0-9]{2,20})\s+vault\b/i);
  const vaultName = vaultMatch?.[1];

  return { asset, amount, isUsd, all: all || !amount, vaultName };
}

export function isEarnPositionReadIntent(message: string): boolean {
  const m = message.trim().replace(/^(?:@\S+\s+)+/i, "").trim().toLowerCase();
  if (/\b(deposit|supply|stake|lend|earn)\s+(?:to|on|in|with|into)\b/.test(m)) return false;
  const hasReadVerb = /\b(how much|what(?:'s| is)|show|check|view|see|read|tell me)\b/.test(m);
  const hasPositionNoun =
    /\b(stake|stakes|staked|staking|deposit|deposited|supplied|supply|position|positions|vault|vaults|yield|earning|earned)\b/.test(m);
  return hasReadVerb && hasPositionNoun;
}

export function extractMoonwellWithdrawAsset(message: string): string | null {
  const tokens = message.match(/\b[a-zA-Z][a-zA-Z0-9]{1,11}\b/g) ?? [];
  for (const token of tokens) {
    const normalized = normalizeYieldTokenSymbol(token);
    if (MOONWELL_MTOKENS[normalized]) return normalized;
  }
  return null;
}

/**
 * True when the user is ASKING about perp mechanics or seeking advice, rather
 * than issuing a command — e.g. "what's the liquidation price for trade #0?",
 * "should i close it?", "what happens when i close?", "explain leverage".
 * These must reach the LLM for a real answer; deterministically routing them to
 * close/positions just dumps a card and never answers the question. Pure
 * commands ("close my eth position", "check my positions", "what's my pnl")
 * deliberately do NOT match.
 */
export function isPerpInfoOrAdviceQuestion(message: string): boolean {
  const m = message.trim().replace(/^(?:@\S+\s+)+/i, "").trim().toLowerCase();
  if (!m) return false;
  if (/\bshould i\b/.test(m)) return true;
  const infoTopic =
    /\b(liquidat\w*|liq\b|liq price|leverage|funding|fees?|slippage|spread|collateral|stop[\s-]?loss|take[\s-]?profit|\bsl\b|\btp\b|risk level|what happens|how (does|do|long|much)|how it works|is it safe|safe to|risky|worth it|what does|difference between|explain|mean|means|right\?)\b/.test(
      m,
    );
  if (!infoTopic) return false;
  const isQuestion =
    m.includes("?") ||
    /^(what|whats|what'?s|how|why|is|are|do|does|can|could|would|when|which|should|explain|tell me|teach|walk me)\b/.test(
      m,
    );
  return isQuestion;
}

/** Bug / broken / support requests — routed to offer_support before the LLM (tool_choice is unreliable here). */
export function isSupportIntent(message: string): boolean {
  const m = message.trim().replace(/^(?:@\S+\s+)+/i, "").trim().toLowerCase();
  if (!m) return false;
  if (/\b(found|report(ed|ing)?|discovered|file(d)?|seeing|hit|have)\b.*\b(bug|issue|problem|glitch)\b/.test(m))
    return true;
  if (/\b(bug|bugs)\b/.test(m) && /\b(found|report|there'?s|i have|hit a)\b/.test(m)) return true;
  if (/\b(broken|not working|doesn'?t work|doesnt work|isn'?t working|isnt working|stopped working)\b/.test(m))
    return true;
  if (/\b(need|want|get|join|talk to|contact)\b.*\b(support|help from (the )?team|the team)\b/.test(m))
    return true;
  if (/\b(support (group|channel|team)|help desk)\b/.test(m)) return true;
  return false;
}

export const MOONWELL_MTOKEN_KEY_SET = new Set<string>();

/** Yield compare is not part of Wren. */
export function isYieldCompareIntent(_message: string): boolean {
  return false;
}

/** Yield deposits are not part of Wren. */
export function extractYieldTokenFromMessage(_message: string): string | null {
  return null;
}

/**
 * Detects "show my world cup bets" / "what open wc bets do I have" etc.
 * Must have a World Cup context token AND a list/ownership verb AND a bet noun.
 * Does NOT match bet-placement phrases ("bet 100 on Brazil") or match-browsing
 * ("show world cup matches") — those stay with worldcup_propose_bet /
 * worldcup_get_matches.
 */
export function isWorldCupOpenBetsIntent(message: string): boolean {
  const m = message.trim().replace(/^(?:@\S+\s+)+/i, "").trim().toLowerCase();

  // Must have World Cup context.
  if (!/\b(world\s+cup|worldcup|fifa|\bwc\b)\b/.test(m)) return false;

  // Exclude bare match-browsing ("show world cup matches/games").
  if (/\b(matches?|games?|schedule|fixtures?|upcoming|odds)\b/.test(m) &&
      !/\b(bet|bets|wager|wagers|pick|picks)\b/.test(m)) return false;

  // Exclude explicit bet-placement ("bet X on Y", "I want to bet on France").
  if (/\bbet\s+\d/.test(m)) return false;
  if (/\b(place|make|put)\s+(a\s+)?bet\b/.test(m)) return false;
  if (/\bwant\s+to\s+bet\b/.test(m)) return false;

  // Require a list/ownership intent. "active" as a bet modifier counts as implicit "show me".
  const hasListIntent =
    /\b(my|show|list|view|check|see|what|any|do\s+i\s+have|have\s+i|got)\b/.test(m) ||
    /\bactive\b.*\b(bet|bets|wager|wagers)\b/.test(m) ||
    /\b(bet|bets|wager|wagers)\b.*\bactive\b/.test(m);
  if (!hasListIntent) return false;

  // Require a bet noun or explicit open/active.
  // "positions" counts as a bet noun in the World Cup context ("show my world cup positions").
  const hasBetNoun = /\b(bet|bets|wager|wagers|pick|picks|positions?)\b/.test(m);
  const hasStatusWord = /\b(open|active)\b/.test(m);
  return hasBetNoun || hasStatusWord;
}

/** Optional amount from earn phrasing — only when the user stated a number. */
export function extractYieldAmountFromMessage(
  message: string,
): { amount: string; isUsd: boolean } | null {
  const usd = extractUsdAmountFromMessage(message);
  if (usd) return { amount: usd, isUsd: true };

  const tokenAmt = message.match(
    /\b(?:deposit|supply|lend|earn|put|park|deploy)\s+([\d][\d,]*(?:\.\d+)?)\s+(?:of\s+)?/i,
  );
  if (tokenAmt?.[1]) {
    const amt = sanitizeAmount(tokenAmt[1].replace(/,/g, ""));
    if (amt) return { amount: amt, isUsd: false };
  }
  return null;
}

/**
 * Deterministic custodial-wallet intents, routed before the LLM so they fire
 * reliably (the model otherwise tends to decline "create a wallet"). Returns the
 * Toolbox method name to invoke, or null. Only consulted when the request
 * carries a basemate-custodied wallet.
 */
export function detectWalletIntent(
  message: string,
): "get_wallet_balance" | "fund_wallet" | "offramp_to_fiat" | null {
  const m = message.trim().replace(/^(?:@\S+\s+)+/i, "").trim().toLowerCase();
  if (!m) return null;

  // Defer to the LLM for protocol/earn/trade/transfer intents — those words
  // ("deposit 100 usdc on moonwell", "send 5 usdc to 0x…") are not wallet ops.
  if (/\b(moonwell|morpho|aave|aerodrome|avantis|perp|leverage|vault|pool|lp|liquidity|swap|stake|lend|supply|yield|earn)\b/.test(m))
    return null;
  // A destination ("to 0x…" / "to name.base.eth") means a transfer/withdraw, not funding.
  if (/\bto\s+(0x[a-f0-9]{4,}|[a-z0-9-]+\.(base\.)?eth)\b/.test(m)) return null;

  // Cash out to fiat (check before generic withdraw/balance wording).
  if (/\b(cash\s?out|off\s?ramp|sell to fiat|withdraw to (my )?bank|to my bank)\b/.test(m))
    return "offramp_to_fiat";

  // Add funds / deposit to wallet / buy crypto.
  if (
    /\bfund (my )?wallet\b/.test(m) ||
    /\b(add|deposit|load) (some )?(funds?|money|cash|crypto)\b/.test(m) ||
    /\btop\s?up\b/.test(m) ||
    /\bbuy crypto\b/.test(m) ||
    /\bon\s?ramp\b/.test(m)
  )
    return "fund_wallet";

  // Wallet / balance / address / "create a wallet" (they already have one).
  if (
    /\b(create|make|set up|get|open|need|do i have|show( me)?) (a |my )?wallet\b/.test(m) ||
    /\bmy (wallet|balance|funds|address)\b/.test(m) ||
    /\b(wallet|balance) (address|please|info)?\b/.test(m) ||
    /^(wallet|balance)[\s!?.]*$/.test(m) ||
    /\bhow much (do i have|money|usdc|eth)\b/.test(m)
  )
    return "get_wallet_balance";

  return null;
}

/** Balance / portfolio view — mirrors iMessage main_wallet_balance for XMTP + custodial fallback. */
export function isPortfolioBalanceIntent(message: string): boolean {
  if (detectWalletIntent(message)) return true;
  if (isPortfolioViewIntent(message.trim().toLowerCase())) return true;
  const m = message.trim().replace(/^(?:@\S+\s+)+/i, "").trim().toLowerCase();
  if (/\b(holdings|what do i have|net worth)\b/.test(m)) return true;
  if (/\b(balances?)\b/.test(m) && /\b(my|show|check|view)\b/.test(m)) return true;
  return false;
}

// ─── Intent / message-parsing helpers ────────────────────────────────────────
// These will be extracted to src/discovery/ai/intents.ts in PR 3.4.

/** Deterministic "buy $1 bnkr" / "get $5 of TOKEN" — bypasses the LLM amount. */
export function parseSimpleUsdBuy(message: string): { amount: string; toAsset: string } | null {
  const stripped = message.trim().replace(/^@\S+\s+/, "").replace(/^please\s+/i, "");
  const m = stripped.match(
    /^(?:buy|get)\s+\$?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)\s*(?:usd|usdc|dollars?)?(?:\s+(?:worth|amount))?\s*(?:(?:of|in)\s+)?(\$?[a-zA-Z][\w]{0,20})\s*$/i,
  );
  if (!m?.[1] || !m[2]) return null;
  const amount = sanitizeAmount(m[1].replace(/,/g, ""));
  const toAsset = m[2].replace(/^\$/, "").trim();
  if (!amount || !toAsset) return null;
  // Stock gifts with a recipient are handled by parseGiftStock; bare
  // "buy $25 apple" still spot-buys via Slipstream (not Flash / Avantis).
  return { amount, toAsset };
}

export type GiftStockParse = {
  to: string;
  stock: string;
  amount: string;
  isUsd: boolean;
};

const GIFT_AMOUNT_RE = String.raw`(?:\d[\d,]*(?:\.\d+)?|\.\d+)`;
/** Up to four words, so "Novo Nordisk stock" and "SK hynix" parse as a stock name. */
const GIFT_STOCK_NAME_RE = String.raw`[a-zA-Z][\w]{0,20}(?:\s+[a-zA-Z][\w]{0,20}){0,3}`;

/**
 * A gift phone is only usable when the country code is already on it (`+…`).
 * Digit-only numbers are rejected — we never invent a code, and we never assume +1.
 */
export function extractGiftPhone(raw: string): string | null {
  const compact = raw.trim().replace(/[\s().-]/g, "");
  if (!compact.startsWith("+")) return null;
  const cleaned = compact.replace(/[^\d+]/g, "");
  return /^\+\d{7,15}$/.test(cleaned) ? cleaned : null;
}

/**
 * Deterministic stock gift: "send mom 1 Apple stock", "gift dad $25 of NVDA",
 * "send $25 apple to mom", "Send Leo Gonzalez $2 of Apple stock".
 * Must win over send_token / uniswap / Avantis.
 */
export function parseGiftStock(message: string): GiftStockParse | null {
  const stripped = message
    .trim()
    // Normalize fancy dollars / thin spaces from iOS so "$2" still matches.
    .replace(/[\u00A0\u202F\u2007]/g, " ")
    .replace(/[＄￥]/g, "$")
    .replace(/^@\S+\s+/, "")
    .replace(/^please\s+/i, "")
    .replace(/[.?!,;:]+$/g, "");
  if (!/\b(send|gift|give)\b/i.test(stripped)) return null;

  const personThenUsd = stripped.match(
    new RegExp(
      String.raw`\b(?:send|gift|give)\s+(.+?)\s+\$\s*(${GIFT_AMOUNT_RE})\s*(?:(?:of|in|worth\s+of)\s+)?(${GIFT_STOCK_NAME_RE})\s*$`,
      "i",
    ),
  );
  if (personThenUsd) {
    const to = cleanGiftRecipient(personThenUsd[1]);
    const amount = sanitizeAmount(personThenUsd[2].replace(/,/g, ""));
    const stock = cleanGiftStock(personThenUsd[3]);
    if (to && amount && resolveStockToken(stock)) {
      return { to, stock, amount, isUsd: true };
    }
  }

  const usdThenPerson = stripped.match(
    new RegExp(
      String.raw`\b(?:send|gift|give)\s+\$\s*(${GIFT_AMOUNT_RE})\s*(?:(?:of|in|worth\s+of)\s+)?(.+?)\s*$`,
      "i",
    ),
  );
  if (usdThenPerson) {
    const amount = sanitizeAmount(usdThenPerson[1].replace(/,/g, ""));
    const split = splitGiftStockThenRecipient(usdThenPerson[2]);
    if (split && amount) {
      return { ...split, amount, isUsd: true };
    }
  }

  const personThenQty = stripped.match(
    new RegExp(
      String.raw`\b(?:send|gift|give)\s+(.+?)\s+(${GIFT_AMOUNT_RE})\s+(${GIFT_STOCK_NAME_RE})\s*$`,
      "i",
    ),
  );
  if (personThenQty) {
    const to = cleanGiftRecipient(personThenQty[1]);
    const amount = sanitizeAmount(personThenQty[2].replace(/,/g, ""));
    const stock = cleanGiftStock(personThenQty[3]);
    if (to && amount && resolveStockToken(stock) && !/\$/.test(stripped)) {
      return { to, stock, amount, isUsd: false };
    }
  }

  // "send 0.001 AAPLc to +1 (818)…" — "stock" after the ticker is optional
  const qtyThenPerson = stripped.match(
    new RegExp(
      String.raw`\b(?:send|gift|give)\s+(${GIFT_AMOUNT_RE})\s+(?:(?:of|in)\s+)?(.+?)\s*$`,
      "i",
    ),
  );
  if (qtyThenPerson && !/\$/.test(stripped)) {
    const amount = sanitizeAmount(qtyThenPerson[1].replace(/,/g, ""));
    const split = splitGiftStockThenRecipient(qtyThenPerson[2]);
    if (split && amount) {
      return { ...split, amount, isUsd: false };
    }
  }

  return null;
}
/**
 * "Eli Lilly to mom" → stock + recipient. Tries the longest stock name first;
 * the recipient is whatever follows.
 */
function splitGiftStockThenRecipient(rest: string): { stock: string; to: string } | null {
  const words = rest.trim().split(/\s+/);
  for (let n = Math.min(3, words.length - 1); n >= 1; n--) {
    const stock = words.slice(0, n).join(" ");
    if (!/^[a-zA-Z]/.test(stock) || !resolveStockToken(stock)) continue;
    const to = cleanGiftRecipient(words.slice(n).join(" ").replace(/^stocks?\b\s*/i, ""));
    if (to) return { stock, to };
  }
  return null;
}

export function giftStockHint(): string {
  return 'to send a stock, text me like: send $25 of AAPL to Alex\nor: send +18185306378 $25 of AAPL. share a contact card or "Alex: +1…" to save them first.';
}

/** Incomplete send-stock asks. Does not steal a spot "buy $25 apple". */
export function looksLikeGiftStockAsk(text: string | undefined | null): boolean {
  const raw = (text ?? "").trim();
  if (!raw) return false;
  if (parseGiftStock(raw)) return true;
  const t = raw.toLowerCase().replace(/[?!.,]+$/g, "");
  if (/^(?:buy|send|gift) stocks?$/.test(t)) return true;
  if (/^(?:send|gift) a stocks?$/.test(t)) return true;
  if (/\bi (?:want to|wanna|need to) (?:send|gift)\b/.test(t) && /\bstocks?\b/.test(t)) {
    return true;
  }
  if (/\b(?:send|gift)\b/.test(t) && /\b(?:stocks?|aaplc?|apple|nvdac?|nvidia|metac?|googlc?)\b/.test(t)) {
    return true;
  }
  return false;
}

function cleanGiftRecipient(raw: string): string {
  return raw
    .replace(/^(?:to|for)\s+/i, "")
    .replace(/\s+stocks?$/i, "")
    .trim();
}

/** Drop accidental "stock(s)" suffix if the optional group missed it. */
function cleanGiftStock(raw: string): string {
  return raw.replace(/\s+stocks?$/i, "").trim();
}

const SEND_RECIPIENT_PATTERN =
  /(?:0x[a-fA-F0-9]{40}|[\w][\w.-]*\.(?:base\.)?eth|[\w][\w.-]*\.cb\.id)/i;

function extractSendRecipient(message: string): string | null {
  const toMatch = message.match(new RegExp(`\\bto\\s+@?(${SEND_RECIPIENT_PATTERN.source})`, "i"));
  const leadingRecipient = message.match(
    new RegExp(`\\b(?:send|transfer|pay|tip|give|shoot|toss|fire)\\s+@?(${SEND_RECIPIENT_PATTERN.source})`, "i"),
  );
  const toRaw = toMatch?.[1] ?? leadingRecipient?.[1];
  if (!toRaw || !isAllowedSendRecipient(toRaw)) return null;
  return toRaw;
}

/**
 * Deterministic "send $1 [of TOKEN] to name.base.eth" — bypasses LLM
 * amount/routing. A bare dollar amount means USDC.
 */
export function parseSimpleUsdSend(
  message: string,
): { to: string; amount: string; asset: string } | null {
  const amount = extractUsdAmountFromMessage(message);
  if (!amount) return null;
  if (!/\b(send|transfer|pay|tip|give|shoot|toss|fire)\b/i.test(message)) return null;

  const toRaw = extractSendRecipient(message);
  if (!toRaw) return null;

  // Match "$5 of BRETT", "$5 in BRETT", "$5 worth of BRETT", "$5 BRETT" (no filler word)
  const assetMatch =
    message.match(/\$\s*[\d][\d,]*(?:\.\d+)?\s*(?:of|in|worth\s+of)\s+(\$?[a-zA-Z][\w]{0,20})\b/i) ??
    // "$5 BRETT" — token symbol immediately after amount (not a filler word or "to"/"for")
    message.match(
      /\$\s*[\d][\d,]*(?:\.\d+)?\s+(?!to\b|for\b|worth\b|of\b|in\b)(\$?[a-zA-Z][\w]{0,18})\b/i,
    );

  const asset = (assetMatch?.[1] ?? "USDC").replace(/^\$/, "").trim();
  if (!asset) return null;

  return { to: toRaw, amount, asset };
}

export type SimpleTokenSend = {
  to: string;
  amount: string;
  asset: string;
  /** True when user said all/everything/max — amount is the sentinel "all". */
  all?: boolean;
};

/**
 * Deterministic "send 6.7 usdc to name.base.eth" / "send all usdc to …"
 * (token amount, no $) — bypasses LLM amount/routing. Does not match
 * $-prefixed USD sends (those use parseSimpleUsdSend).
 */
export function parseSimpleTokenSend(message: string): SimpleTokenSend | null {
  if (!/\b(send|transfer|pay|tip|give|shoot|toss|fire)\b/i.test(message)) return null;
  // $-prefixed amounts are handled by parseSimpleUsdSend
  if (/\$\s*[\d]/.test(message)) return null;

  const toRaw = extractSendRecipient(message);
  if (!toRaw) return null;

  // "send all usdc to …" / "send all of my usdc to …" / "transfer everything eth to …"
  const allAsset =
    message.match(
      /\b(?:send|transfer|pay|tip|give|shoot|toss|fire)\s+(?:all|everything|max|maximum)(?:\s+of)?(?:\s+my)?\s+(\$?[a-zA-Z][\w]{0,20})\b/i,
    ) ??
    message.match(
      /\b(?:all|everything|max|maximum)(?:\s+of)?(?:\s+my)?\s+(\$?[a-zA-Z][\w]{0,20})\s+to\b/i,
    );
  if (allAsset?.[1]) {
    const asset = allAsset[1].replace(/^\$/, "").trim();
    if (!asset) return null;
    const normalizedAsset = /^usd$/i.test(asset) ? "USDC" : asset;
    return { to: toRaw, amount: "all", asset: normalizedAsset, all: true };
  }

  // "send 6.7 usdc to …" / "send .1 usdc to …" / "transfer 0.5 eth to …".
  // The amount alternation accepts leading-dot decimals (".1", ".01") — without
  // the "|\.\d+" branch, ".1 usdc" would fall through and match the bare "1".
  const amountAsset =
    message.match(
      /\b(?:send|transfer|pay|tip|give|shoot|toss|fire)\s+(\d[\d,]*(?:\.\d+)?|\.\d+)\s+(?:of\s+)?(\$?[a-zA-Z][\w]{0,20})\b/i,
    ) ??
    message.match(
      /(\d[\d,]*(?:\.\d+)?|\.\d+)\s+(?:of\s+)?(\$?[a-zA-Z][\w]{0,20})\s+to\b/i,
    );
  if (!amountAsset?.[1] || !amountAsset?.[2]) return null;

  const amount = sanitizeAmount(amountAsset[1].replace(/,/g, ""));
  const asset = amountAsset[2].replace(/^\$/, "").trim();
  if (!amount || !asset) return null;
  // "usd" alone is ambiguous without $ — treat as USDC token amount
  const normalizedAsset = /^usd$/i.test(asset) ? "USDC" : asset;

  return { to: toRaw, amount, asset: normalizedAsset };
}

/** True when the whole message is just a basename / ENS / 0x address. */
export function parseBareSendRecipient(message: string): string | null {
  const stripped = message.trim().replace(/^@\S+\s+/, "").replace(/^please\s+/i, "").trim();
  if (!stripped) return null;
  // Reject multi-word / command messages
  if (/\s/.test(stripped)) return null;
  if (!isAllowedSendRecipient(stripped)) return null;
  return stripped.replace(/^@+/, "");
}

/**
 * Pull a pending send (asset + amount, optionally missing `to`) from recent
 * history so a bare basename reply can complete it.
 */
export function extractPendingSendFromHistory(
  history: Array<{ role?: string; content?: unknown }>,
): { asset: string; amount: string; all?: boolean; to?: string } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (turn.role !== "user") continue;
    const text = typeof turn.content === "string" ? turn.content : "";
    if (!text || !/\b(send|transfer|pay|tip|give|shoot|toss|fire)\b/i.test(text)) continue;

    // Full send with recipient already present
    const withTo = parseSimpleTokenSend(text) ?? (() => {
      const usd = parseSimpleUsdSend(text);
      return usd ? { ...usd, all: false as const } : null;
    })();
    if (withTo) {
      return {
        asset: withTo.asset,
        amount: withTo.amount,
        all: withTo.all,
        to: withTo.to,
      };
    }

    // "send all usdc" / "send 6.7 usdc" without a resolvable recipient yet
    const allNoTo = text.match(
      /\b(?:send|transfer|pay)\s+(?:all|everything|max|maximum)(?:\s+of)?(?:\s+my)?\s+(\$?[a-zA-Z][\w]{0,20})\b/i,
    );
    if (allNoTo?.[1]) {
      const asset = allNoTo[1].replace(/^\$/, "").trim();
      if (asset) {
        return {
          asset: /^usd$/i.test(asset) ? "USDC" : asset,
          amount: "all",
          all: true,
        };
      }
    }
    const amtNoTo = text.match(
      /\b(?:send|transfer|pay)\s+([\d][\d,]*(?:\.\d+)?)\s+(?:of\s+)?(\$?[a-zA-Z][\w]{0,20})\b/i,
    );
    if (amtNoTo?.[1] && amtNoTo?.[2]) {
      const amount = sanitizeAmount(amtNoTo[1].replace(/,/g, ""));
      const asset = amtNoTo[2].replace(/^\$/, "").trim();
      if (amount && asset) {
        return {
          asset: /^usd$/i.test(asset) ? "USDC" : asset,
          amount,
        };
      }
    }
    break;
  }
  return null;
}

/**
 * Deterministic "long eth" / "short btc $50" — detects an unambiguous perp-open
 * command. Amount, leverage, TP/SL are NOT parsed here; those come from the
 * avantis_prepare_trade handler.
 */
export function parseSimplePerp(
  message: string,
): { side: "long" | "short"; base: string } | null {
  const m = message
    .trim()
    .replace(/^@\S+\s*/, "")
    .match(/^(?:go\s+|open\s+(?:a\s+)?)?(long|short)\s+\$?([a-zA-Z][a-zA-Z0-9]{0,11})\b/i);
  if (!m?.[1] || !m[2]) return null;
  return {
    side: m[1].toLowerCase() as "long" | "short",
    base: m[2].toUpperCase(),
  };
}

const PERP_TIER_KEYWORDS: Array<{ tier: PerpRiskTier; re: RegExp }> = [
  { tier: "basemaxxing", re: /\b(basemaxx\w*|max(?:imum)?(?:\s*(?:lev\w*|risk))?|degen|yolo|ape\s*in)\b/i },
  { tier: "aggressive", re: /\b(aggressive|high(?:\s*risk)?|risky|spicy)\b/i },
  { tier: "tactical", re: /\b(tactical|medium|moderate|balanced|mid(?:\s*risk)?)\b/i },
  { tier: "steady", re: /\b(steady|low(?:\s*risk)?|conservative|cautious|safe)\b/i },
];

/**
 * Deterministic free-text PerpMate profile setup — e.g. "medium risk, 500 USDC
 * margin". Requires BOTH a recognizable risk tier AND a margin amount.
 */
export function parsePerpProfileSetup(
  message: string,
): { tier: PerpRiskTier; collateral: string } | null {
  const m = message.trim();
  if (!m) return null;
  if (/\b(long|short|swap|buy|sell|send|earn|deposit|withdraw|close|exit)\b/i.test(m)) return null;

  let tier: PerpRiskTier | undefined;
  for (const { tier: t, re } of PERP_TIER_KEYWORDS) {
    if (re.test(m)) {
      tier = t;
      break;
    }
  }
  if (!tier) return null;

  const marginMatch = m.match(
    /\$\s*([\d][\d,]*(?:\.\d+)?)|([\d][\d,]*(?:\.\d+)?)\s*(?:usdc|usd|dollars?|margin|per\s*trade|each)\b/i,
  );
  const rawAmt = marginMatch?.[1] ?? marginMatch?.[2];
  if (!rawAmt) return null;
  const collateral = sanitizeAmount(rawAmt.replace(/,/g, ""));
  if (!collateral || Number(collateral) <= 0) return null;

  return { tier, collateral };
}

const CARD_NUDGES = [
  "it's ready — tap Confirm when you want it to go through, or tell me if you want to tweak anything",
  "transaction's ready 👆 tap Confirm to send it — lmk if you want to change the amount",
  "queued up — tap Confirm whenever you're ready, and shout if you want to adjust it",
];

export function pickCardNudge(): string {
  return CARD_NUDGES[Math.floor(Math.random() * CARD_NUDGES.length)];
}

/**
 * Bare acknowledgment / resend after a card was already shown — "sign it",
 * "resend", "go", "ok", "yes". Used to nudge the user to tap the existing card.
 */
export function isPostCardAck(message: string): boolean {
  const m = message
    .trim()
    .replace(/^@\S+\s*/, "")
    .toLowerCase()
    .replace(/[!.?\s]+$/, "");
  if (!m) return false;
  if (/\b(resend|send\s+it\s+again|show\s+(it\s+)?again|one\s+more\s+time|try\s+again|retry|again)\b/.test(m)) {
    return true;
  }
  return /^(sign(\s+it)?|sign\s+the\s+(tx|transaction|request)|tap\s+it|do\s+it|go|go\s+ahead|ok(ay)?|k|yes|yep|yup|sure|confirm(ed)?|proceed|send\s+it|submit(\s+it)?|approve)$/.test(
    m,
  );
}
