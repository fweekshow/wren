/** Expected routing outcome for harness regression / model comparison. */
export interface RoutingEvalCase {
  id: string;
  message: string;
  /** Tool the model should call (first tool call). Omit when expectNoTool is true. */
  expectTool?: string;
  /** Subset of args that must match on the first tool call. */
  expectToolArgs?: Record<string, unknown>;
  /** Model should reply with text only (no tool call). */
  expectNoTool?: boolean;
  /** Informational answer via plain text (no tool) also passes — e.g. capabilities inline reply. */
  acceptTextOnly?: boolean;
  note?: string;
}

/**
 * Real user phrasings — asserted against DiscoveryAI.respond() (full production path).
 * Measures end-to-end routing: deterministic harness + fat skills + LLM + tool handlers.
 */
export const ROUTING_EVAL_CASES: RoutingEvalCase[] = [
  {
    id: "pnl-check-my",
    message: "check my pnl",
    expectTool: "avantis_get_positions",
    expectToolArgs: { pnlCard: true },
  },
  {
    id: "pnl-show-profit",
    message: "show my profit on perps",
    expectTool: "avantis_get_positions",
    expectToolArgs: { pnlCard: true },
  },
  {
    id: "pnl-on-btc",
    message: "check my pnl on btc",
    expectTool: "avantis_get_positions",
    expectToolArgs: { pnlCard: true, pair: "BTC" },
    note: "Pair filter — tool layer also parses pair from message if model omits it",
  },
  {
    id: "positions-avantis",
    message: "show my avantis positions",
    expectTool: "avantis_get_positions",
  },
  {
    id: "positions-check-my",
    message: "check my positions",
    expectTool: "avantis_get_positions",
    note: "Position list — tool layer forces pnlCard off when message lacks PnL/profit wording",
  },
  {
    id: "positions-trades",
    message: "what perps am i in?",
    expectTool: "avantis_get_positions",
  },
  {
    id: "close-eth",
    message: "close my eth position",
    expectTool: "avantis_close_position",
  },
  {
    id: "close-trade-hash",
    message: "#1",
    expectTool: "avantis_close_position",
    expectToolArgs: { tradeIndex: 1 },
    note: "iMessage trade-# reply style",
  },
  {
    id: "close-trade-hash-tba",
    message: "close #1",
    expectTool: "avantis_close_position",
    expectToolArgs: { tradeIndex: 1 },
    note: "Basemate TBA/XMTP trade-# close reply style",
  },
  {
    id: "close-trade-copied-indexes",
    message: "Close my ETH-USD long perp with pairIndex 0 and tradeIndex 1",
    expectTool: "avantis_close_position",
    expectToolArgs: { pairIndex: 0, tradeIndex: 1 },
    note: "Copied portfolio prompt carries exact Avantis indexes for XMTP close signing",
  },
  {
    id: "close-all",
    message: "close all positions",
    expectTool: "avantis_close_all_positions",
  },
  {
    id: "support-broken",
    message: "this is broken, i need support",
    expectNoTool: true,
    note: "Agent should troubleshoot first, not jump straight to offer_support.",
  },
  {
    id: "support-bug",
    message: "i found a bug",
    expectNoTool: true,
    note: "Agent should try to diagnose first; offer_support only as last resort.",
  },
  {
    id: "capabilities-what-can-you-do",
    message: "what can you do?",
    expectTool: "describe_capabilities",
    acceptTextOnly: true,
    note: "Production calls describe_capabilities, which returns a single menu bubble with the summary as its description",
  },
  {
    id: "capabilities-features",
    message: "what features do you have",
    expectTool: "describe_capabilities",
    acceptTextOnly: true,
  },
  {
    id: "greeting-gm",
    message: "gm",
    expectNoTool: true,
    note: "Full respond() path — model should reply text-only with no tool invocation",
  },
  {
    id: "smalltalk-thanks",
    message: "thanks!",
    expectNoTool: true,
  },
  {
    id: "swap-simple",
    message: "buy $10 of DEGEN",
    expectTool: "uniswap_prepare_swap",
  },
  {
    id: "perp-prep-long",
    message: "long eth $25",
    expectTool: "avantis_prepare_trade",
  },
  {
    id: "trending-groups",
    message: "what communities are trending on base?",
    expectTool: "get_trending",
  },
  {
    id: "trending-tokens",
    message: "what's trending",
    expectTool: "bankr_get_launches",
    expectToolArgs: { sort: "mixed" },
    note: "Deterministic route — tokens by default, not group chats",
  },
  {
    id: "price-token-eth",
    message: "what's the price of eth?",
    expectTool: "get_market_price",
    expectToolArgs: { asset: "ETH" },
  },
  {
    id: "price-major-bitcoin",
    message: "price of Bitcoin",
    expectTool: "get_market_price",
    expectToolArgs: { asset: "BTC" },
    note: "Well-known majors must use canonical market pricing, not same-name Base tokens.",
  },
  {
    id: "price-stock-aapl",
    message: "aapl stock price",
    expectTool: "get_market_price",
    expectToolArgs: { asset: "AAPL", assetType: "stock" },
  },
  {
    id: "earn-on-hype",
    message: "Earn on my hype",
    expectTool: "yield_compare",
    expectToolArgs: { token: "HYPE" },
    note: "Harness also routes deterministically when token is parseable",
  },
  {
    id: "earn-on-usdc",
    message: "Earn on my usdc",
    expectTool: "yield_compare",
    expectToolArgs: { token: "USDC" },
  },
  {
    id: "earn-with-btc",
    message: "Where can I earn with btc",
    expectTool: "yield_compare",
    expectToolArgs: { token: "CBBTC" },
  },
  {
    id: "earn-on-aero",
    message: "earn on my aero",
    expectTool: "yield_compare",
    expectToolArgs: { token: "AERO" },
  },
  {
    id: "earn-on-mamo",
    message: "earn on my mamo",
    expectTool: "yield_compare",
    expectToolArgs: { token: "MAMO" },
  },
  {
    id: "earn-park-usdc",
    message: "park my usdc",
    expectTool: "yield_compare",
    expectToolArgs: { token: "USDC" },
  },
  {
    id: "earn-on-weth",
    message: "where can I earn with eth",
    expectTool: "yield_compare",
    expectToolArgs: { token: "WETH" },
  },
  {
    id: "best-usdc-yield-on-base",
    message: "best usdc yield on base",
    expectTool: "yield_compare",
    expectToolArgs: { token: "USDC" },
    note: "'on base' is chain context. Brain (not regex) must extract token=USDC.",
  },
  {
    id: "highest-apy-for-usdc",
    message: "highest apy for usdc",
    expectTool: "yield_compare",
    expectToolArgs: { token: "USDC" },
    note: "Superlative APY phrasing — LLM picks yield_compare with the asset.",
  },
  {
    id: "best-place-to-park-eth",
    message: "where should I park my eth",
    expectTool: "yield_compare",
    expectToolArgs: { token: "WETH" },
  },
  {
    id: "supply-on-aave",
    message: "supply usdc on aave",
    expectTool: "aave_prepare_supply",
    expectToolArgs: { asset: "USDC" },
    note: "Explicit Aave venue must skip yield_compare and route to prepare tool with no amount.",
  },
  {
    id: "wc-show-matches",
    message: "show me today's world cup games",
    expectTool: "worldcup_get_matches",
  },
  {
    id: "wc-bet-team",
    message: "bet 100 on Brazil tonight",
    expectTool: "worldcup_propose_bet",
    expectToolArgs: { team: "Brazil" },
  },
  {
    id: "wc-bet-vague",
    message: "I want to bet on the France game",
    expectTool: "worldcup_propose_bet",
    expectToolArgs: { team: "France" },
  },
  {
    id: "wc-whats-playing",
    message: "what world cup matches are on?",
    expectTool: "worldcup_get_matches",
  },
  {
    id: "wc-usa-game",
    message: "when does the USA play?",
    expectTool: "worldcup_get_matches",
    expectToolArgs: { team: "USA" },
  },
  {
    id: "wc-my-bets",
    message: "show my world cup bets",
    expectTool: "worldcup_list_open_bets",
  },
  {
    id: "wc-open-bets",
    message: "what open world cup bets do I have?",
    expectTool: "worldcup_list_open_bets",
  },

  // Phrasing-agnostic sends — recipient in any position, contact names, slang.
  // Expanded from sendPhrasing.bank.ts (shared fixture).
  {
    id: "send-to-basename",
    message: "send 6.7 usdc to bob.base.eth",
    expectTool: "send_token",
    expectToolArgs: { to: "bob.base.eth", amount: "6.7", asset: "USDC" },
  },
  {
    id: "send-recipient-first-contact",
    message: "send Degeneer .01 usdc",
    expectTool: "send_token",
    expectToolArgs: { to: "Degeneer", asset: "USDC" },
    note: "Recipient-first, plain contact name, no 'to' — must still resolve the recipient",
  },
  {
    id: "send-pay-contact",
    message: "pay bob 5 usdc",
    expectTool: "send_token",
    expectToolArgs: { to: "bob", amount: "5", asset: "USDC" },
    note: "'pay <name> <amount>' phrasing",
  },
  {
    id: "send-slang-contact",
    message: "shoot alice 10 usdc",
    expectTool: "send_token",
    expectToolArgs: { to: "alice", amount: "10", asset: "USDC" },
    note: "Slang verb, recipient-first contact name",
  },
  {
    id: "send-usd-recipient-first",
    message: "send jesse.base.eth $5",
    expectTool: "send_token",
    expectToolArgs: { to: "jesse.base.eth", asset: "USDC" },
    note: "Recipient-first with $ amount defaults to USDC",
  },
  {
    id: "send-leading-decimal",
    message: "send .01 usdc to degeneer03.base.eth",
    expectTool: "send_token",
    expectToolArgs: { to: "degeneer03.base.eth", amount: ".01", asset: "USDC" },
    note: "Leading-decimal amount must not be misread as 1",
  },
  {
    id: "send-give-verb",
    message: "Give Degeneer .01 USDC",
    expectTool: "send_token",
    expectToolArgs: { to: "Degeneer", amount: ".01", asset: "USDC" },
  },
  {
    id: "send-tip-verb",
    message: "Tip Degeneer .01 USDC",
    expectTool: "send_token",
    expectToolArgs: { to: "Degeneer", amount: ".01", asset: "USDC" },
  },
  {
    id: "send-toss-verb",
    message: "Toss Degeneer .01 USDC",
    expectTool: "send_token",
    expectToolArgs: { to: "Degeneer", amount: ".01", asset: "USDC" },
  },
  {
    id: "send-fire-over",
    message: "Fire over .01 USDC to Degeneer",
    expectTool: "send_token",
    expectToolArgs: { to: "Degeneer", amount: ".01", asset: "USDC" },
  },
  {
    id: "send-can-you",
    message: "Can you send .01 USDC to Degeneer?",
    expectTool: "send_token",
    expectToolArgs: { to: "Degeneer", amount: ".01", asset: "USDC" },
  },
  {
    id: "send-help-me",
    message: "Help me send .01 USDC to Degeneer.",
    expectTool: "send_token",
    expectToolArgs: { to: "Degeneer", amount: ".01", asset: "USDC" },
  },
  {
    id: "send-one-cent",
    message: "Send Degeneer one cent USDC",
    expectTool: "send_token",
    expectToolArgs: { to: "Degeneer", amount: "0.01", asset: "USDC" },
  },
  {
    id: "send-a-penny",
    message: "Send a penny in USDC to Degeneer",
    expectTool: "send_token",
    expectToolArgs: { to: "Degeneer", amount: "0.01", asset: "USDC" },
  },
  {
    id: "send-stables-synonym",
    message: "send Degeneer .01 stables",
    expectTool: "send_token",
    expectToolArgs: { to: "Degeneer", amount: ".01", asset: "USDC" },
    note: "stables → USDC",
  },
  {
    id: "send-memo-lunch",
    message: "send Degeneer .01 usdc for lunch",
    expectTool: "send_token",
    expectToolArgs: { to: "Degeneer", amount: ".01", asset: "USDC", memo: "lunch" },
  },
  {
    id: "send-tip-penny-memo",
    message: "Can you tip Degeneer a penny in USDC for lunch?",
    expectTool: "send_token",
    expectToolArgs: { to: "Degeneer", amount: "0.01", asset: "USDC", memo: "lunch" },
  },
  {
    id: "send-neg-what-is-usdc",
    message: "what is USDC?",
    expectNoTool: true,
    note: "Informational — must not call send_token",
  },
  {
    id: "send-neg-how-do-i-send",
    message: "how do I send crypto?",
    expectNoTool: true,
    acceptTextOnly: true,
    note: "How-to — text answer, no send_token",
  },
  {
    id: "send-neg-missing-recipient",
    message: "send .01 usdc",
    expectNoTool: true,
    acceptTextOnly: true,
    note: "Missing recipient — ask, do not invent `to`",
  },
];
