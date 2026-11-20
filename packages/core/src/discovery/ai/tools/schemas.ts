import type OpenAI from "openai";

import { formatSpotBuyableForPrompt } from "@/discovery/doppler/stockCatalog.js";

// ─── OpenAI tool schemas ──────────────────────────────────────────────────────

export const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  // Discovery
  {
    type: "function",
    function: {
      name: "search_communities",
      description:
        "Search Basemate's catalog of Base App group chats by keyword, topic, or interest tag.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-form keyword or topic" },
          limit: { type: "number", description: "Max results", default: 5 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_trending",
      description:
        "Trending Base App GROUP CHATS only. Use ONLY when the user explicitly asks about trending communities, groups, or chats — NOT for bare 'what's trending' (use bankr_get_launches for tokens).",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "How many to return", default: 3 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recommend_for_user",
      description:
        "Personalized community recommendations for the current user, based on their interest history.",
      parameters: { type: "object", properties: {} },
    },
  },

  // Custodial wallet (iMessage server wallets — only available when a basemate-custodied wallet is present)
  {
    type: "function",
    function: {
      name: "get_wallet_balance",
      description:
        "Show the user their basemate wallet: balances (USDC, ETH, etc.) and the Base address they can fund. Use whenever the user asks about their balance, funds, wallet, or address.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "fund_wallet",
      description:
        "Help the user add funds to their basemate wallet. Returns a Coinbase Onramp link (Apple Pay / card) to buy crypto, plus the wallet address for a direct crypto deposit. Use for 'add funds', 'deposit', 'buy crypto', 'fund my wallet', 'top up'.",
      parameters: {
        type: "object",
        properties: {
          amountUsd: {
            type: "number",
            description: "Optional preset USD amount to buy, e.g. 25. Omit if the user didn't specify.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "withdraw_funds",
      description:
        "Withdraw funds from the user's basemate wallet to an external crypto address. Executes an on-chain transfer immediately. Use for 'withdraw', 'send to my wallet', 'move my USDC to 0x...'.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Destination 0x address." },
          amount: { type: "string", description: "Human-readable amount, e.g. '10' or '0.5'." },
          asset: {
            type: "string",
            description: "Asset to withdraw: 'USDC' or 'ETH'. Defaults to USDC.",
            enum: ["USDC", "ETH"],
          },
        },
        required: ["to", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sweep_funds",
      description:
        "Preview a destructive sweep of Basemate server wallets: close all perps, redeem Morpho/Moonwell vaults, and send all funds to a destination while keeping ETH for gas. Requires the user to confirm before execution. Use for 'sweep', 'sweep my wallet', 'exit everything and send to 0x...'.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Optional destination 0x address. If omitted, use the user's linked Base App wallet when available." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "offramp_to_fiat",
      description:
        "Help the user cash out crypto from their basemate wallet to fiat (bank/PayPal/Coinbase). Returns a Coinbase Offramp link. Use for 'cash out', 'sell to fiat', 'withdraw to my bank', 'offramp'.",
      parameters: {
        type: "object",
        properties: {
          amount: {
            type: "string",
            description: "Optional preset USDC amount to sell, e.g. '10'. Omit if unspecified.",
          },
        },
      },
    },
  },

  // DeFi
  {
    type: "function",
    function: {
      name: "resolve_name",
      description:
        "Resolve a Basename (name.base.eth), ENS name (name.eth), or Coinbase name (name.cb.id) to a 0x wallet address — or reverse-resolve a 0x address to its primary Basename/ENS. Use when the user asks who owns a name, what address a basename points to, or what name an address has.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Full basename/ENS (e.g. alice.base.eth, vitalik.eth) OR a 0x address for reverse lookup. No bare @handles.",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_token",
      description:
        "Prepare an ERC-20 or ETH transfer to a person, contact name, wallet address, or Basename (e.g. alice.base.eth). Supports ANY token — not just USDC. A bare dollar amount with no named token defaults to USDC. Synonyms like 'stables'/'dollars' mean USDC. Word amounts like 'a penny'/'one cent' mean 0.01. The recipient may appear in ANY position/word order (before or after the amount, with or without 'to') — e.g. 'send Degeneer .01 usdc' and 'send .01 usdc to Degeneer' are equivalent. Verbs include send/pay/transfer/tip/give/shoot/toss/fire. Optional memo when the user adds a note (e.g. 'for lunch'). Returns a wallet_sendCalls transaction the user signs. NEVER invent the recipient — if none is named, reply with a single question: 'who do you want to send it to?' NEVER invent an amount — if none is stated, ask 'how much do you want to send?' NEVER invent a memo. NEVER call this tool with a hallucinated recipient, amount, or asset. NOT for buying/gifting Coinbase B20 stocks (Apple/AAPL/AAPLc, NVDA, META, GOOGL, …) — use gift_stock when the user wants to send stock to someone.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient in any position: a contact name (e.g. 'Degeneer', 'mom'), a 0x address, or a full basename (name.base.eth). No bare @handles." },
          asset: { type: "string", description: "Token to send, e.g. USDC, ETH, WETH, BASEMATE. Map stables/dollars/bucks → USDC. Do NOT use for Apple/AAPL/NVDA/META stock gifts — use gift_stock." },
          amount: {
            type: "string",
            description:
              "Prefer a numeric amount (e.g. 0.01 or .01). Word amounts like 'a penny'/'one cent'/'1 cent' are also accepted (normalized to 0.01). Pass 'all' when the user said all/everything/max. If user said '$1 of TOKEN', pass amount='1' with isUsd=true.",
          },
          isUsd: { type: "boolean", description: "true when the user specified a dollar/USD value (e.g. 'send $1 of basemate'). Converts to token amount before transfer. Defaults to false." },
          all: {
            type: "boolean",
            description: "true when the user wants to send their full balance of the asset (e.g. 'send all usdc'). Prefer amount='all' as well.",
          },
          memo: {
            type: "string",
            description:
              "Optional short note when the user included one (e.g. 'lunch' from 'for lunch', 'birthday'). Omit when the user did not imply a memo.",
          },
        },
        required: ["to", "asset", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gift_stock",
      description:
        `Send a Coinbase B20 tokenized stock on Base (${formatSpotBuyableForPrompt()}) to a person. Use for: 'send mom 1 Apple stock', 'gift dad $25 of NVDA', 'send Apple to mom'. If they already hold the stock, send from holdings (YES). Otherwise Apple Pay then buy + send. Never swap leftover USDC. Never a bare APPLE reply — that is the stock. Do NOT use send_token or uniswap_prepare_swap or avantis_prepare_trade for these. Do NOT open a perp. Never refuse a stock name yourself; call this and let it say whether the stock is available.`,
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description:
              "Recipient: contact name (mom), a phone that already includes its country code (+380…, +1…), 0x address, or basename. Never invent a country code. Never assume +1.",
          },
          stock: {
            type: "string",
            description: "Stock name or ticker as the user wrote it (Apple, AAPL, AAPLc, Eli Lilly, LLY, SK hynix, …).",
          },
          amount: {
            type: "string",
            description:
              "Share count (e.g. '1') or dollar notional (e.g. '25') when isUsd=true.",
          },
          isUsd: {
            type: "boolean",
            description: "true for dollar notional ('$25 of Apple'); false for whole/fractional shares ('1 Apple').",
          },
          memo: {
            type: "string",
            description: "Optional note for the recipient. Omit to ask in chat (skip allowed).",
          },
        },
        required: ["to", "stock", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "uniswap_prepare_swap",
      description:
        "Prepare a market swap on Base. When Flash is configured this routes through Definitive Flash (not Kyber/Uniswap). USD buys default to USDC only when the user did NOT name a source token. Examples: 'buy $5 basemate' → fromAsset=USDC, toAsset=BASEMATE, amount='5', isUsd=true. 'swap $5 eth for basemate' → fromAsset=ETH, toAsset=BASEMATE, amount='5', isUsd=true. 'swap 0.01 eth for basemate' → fromAsset=ETH, toAsset=BASEMATE, amount='0.01', isUsd=false.",
      parameters: {
        type: "object",
        properties: {
          fromAsset: { type: "string", description: "Token being sold/spent. Default USDC for bare '$X of Y' buys. If user said ETH/WETH/USDC/etc, use that exactly — never override with USDC." },
          toAsset:   { type: "string", description: "Token being bought. e.g. ETH, USDC, WETH" },
          amount:    { type: "string", description: "The numeric value from the user's message. If user said '$5', pass '5' with isUsd=true. If user said '5 USDC', pass '5' with isUsd=false." },
          isUsd:     { type: "boolean", description: "true when the user specified a dollar/USD value to spend (e.g. '$5 of WETH'). false when they specified a token amount of fromAsset (e.g. '5 USDC'). Defaults to false." },
        },
        required: ["fromAsset", "toAsset", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "flash_prepare_order",
      description:
        "Prepare a Definitive Flash spot order on Base (market, limit, stop, stop-loss, take-profit, TWAP). targetAsset is the traded token; contraAsset is usually USDC. Simple buy/sell can also use uniswap_prepare_swap (Flash-backed when configured).",
      parameters: {
        type: "object",
        properties: {
          targetAsset: { type: "string", description: "Traded token symbol or address, e.g. ETH, WETH, BASEMATE" },
          contraAsset: { type: "string", description: "Counter asset — spent on buys, received on sells. Usually USDC." },
          side: { type: "string", enum: ["buy", "sell"] },
          qty: { type: "string", description: "Spend amount as decimal string. Contra units on buy; target units on sell." },
          orderType: {
            type: "string",
            enum: ["market", "limit", "twap", "stop", "stop-loss", "take-profit", "bracket"],
          },
          limitNotionalPrice: { type: "string", description: "USD limit price for limit orders (and optional for trigger LIMIT promotion)." },
          triggerNotionalPrice: { type: "string", description: "USD trigger price for stop / stop-loss / take-profit." },
          triggerType: { type: "string", enum: ["upper", "lower"], description: "Optional; defaults from orderType." },
          durationSeconds: { type: "number", description: "TWAP duration in seconds (min 300)." },
          twapBucketCount: { type: "number", description: "Optional TWAP bucket count." },
          maxSlippage: { type: "string", description: "Optional slippage as decimal string, default 0.05." },
        },
        required: ["targetAsset", "contraAsset", "side", "qty", "orderType"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "flash_list_orders",
      description: "List the user's recent Definitive Flash orders (open and recent).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "flash_cancel_order",
      description: "Cancel a Definitive Flash order by orderId.",
      parameters: {
        type: "object",
        properties: {
          orderId: { type: "string", description: "Flash order id from flash_list_orders or a prior placement." },
        },
        required: ["orderId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "morpho_get_vaults",
      description: "Fetch Morpho vault APYs on Base, optionally filtered by underlying asset.",
      parameters: {
        type: "object",
        properties: {
          asset: { type: "string", description: "Optional filter, e.g. USDC" },
          limit: { type: "number", default: 5 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "morpho_prepare_deposit",
      description:
        "Prepare a Morpho vault deposit on Base. amount is OPTIONAL — when omitted, the tool asks the user how much. Pass amount only when the user literally stated one.",
      parameters: {
        type: "object",
        properties: {
          asset: { type: "string", description: "e.g. USDC" },
          amount: { type: "string", description: "The numeric value from the user's message. OMIT when the user did not specify one — do not guess." },
          isUsd: { type: "boolean", description: "true when the user specified a dollar/USD value (e.g. '$5 of WETH'). false for token amounts. Defaults to false." },
          vaultName: {
            type: "string",
            description:
              "Optional hint for which vault to use, e.g. 'Apostro', 'Moonwell', 'Gauntlet', 'Steakhouse'. Fuzzy-matched against vault names.",
          },
        },
        required: ["asset"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "morpho_get_position",
      description:
        "Read a user's current Morpho vault deposits on Base — how much they have supplied/staked/deposited per asset. Call when the user asks how much they have staked, deposited, or supplied on Morpho, or a generic staked-balance question after a Morpho flow. Reads on-chain balances; never guess from a prepared transaction.",
      parameters: {
        type: "object",
        properties: {
          asset: { type: "string", description: "Optional filter, e.g. USDC." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aave_prepare_supply",
      description:
        "Prepare an Aave V3 supply on Base. Use when the user explicitly says 'aave' or 'on aave'. Supports USDC, WETH, cbBTC, wstETH, cbETH, USDS. amount is OPTIONAL — when omitted, the tool asks how much.",
      parameters: {
        type: "object",
        properties: {
          asset: { type: "string", description: "Token symbol, e.g. USDC, WETH, cbBTC, wstETH, cbETH, USDS" },
          amount: { type: "string", description: "The numeric value from the user's message. OMIT when the user did not specify one — do not guess." },
          isUsd: { type: "boolean", description: "true when the user specified a dollar/USD value (e.g. '$5 of USDC'). false for token amounts. Defaults to false." },
        },
        required: ["asset"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "moonwell_prepare_supply",
      description:
        "Prepare a Moonwell supply/lending on Base. amount is OPTIONAL — when omitted, the tool asks the user how much. Pass amount only when the user literally stated one.",
      parameters: {
        type: "object",
        properties: {
          asset: { type: "string", description: "Token symbol, e.g. USDC, MAMO, WETH, cbETH" },
          amount: { type: "string", description: "The numeric value from the user's message. If user said '$5', pass '5' with isUsd=true. If user said '5 MAMO', pass '5' with isUsd=false. OMIT when the user did not specify one." },
          isUsd: { type: "boolean", description: "true when the user specified a dollar/USD amount (e.g. '$5 of MAMO'). false when they specified a token amount (e.g. '5 MAMO'). Defaults to false." },
        },
        required: ["asset"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "moonwell_prepare_withdraw",
      description:
        "Prepare a Moonwell withdraw/close transaction on Base. Use when the user wants to close, exit, withdraw, redeem, or unstake a Moonwell supplied/lending position. For 'close all' or 'withdraw all', set all=true. asset is optional only when all=true.",
      parameters: {
        type: "object",
        properties: {
          asset: { type: "string", description: "Token symbol to withdraw, e.g. USDC, WETH, cbETH. Omit only when closing all Moonwell positions." },
          amount: { type: "string", description: "Optional numeric amount to withdraw. Omit when the user asked to close/withdraw all." },
          isUsd: { type: "boolean", description: "true when the amount is a dollar/USD amount like '$5'. false for token amounts." },
          all: { type: "boolean", description: "true when the user asks to close/exit/withdraw all of a Moonwell position." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "morpho_prepare_withdraw",
      description:
        "Prepare a Morpho vault withdraw/redeem on Base. Use when the user wants to withdraw, redeem, unstake, exit, or close a Morpho vault position. For 'close all' or 'withdraw all', set all=true. asset is optional only when all=true.",
      parameters: {
        type: "object",
        properties: {
          asset: { type: "string", description: "Token symbol to withdraw, e.g. USDC, WETH. Omit only when closing all Morpho positions." },
          amount: { type: "string", description: "Optional numeric amount to withdraw. Omit when the user asked to close/withdraw all." },
          isUsd: { type: "boolean", description: "true when the amount is a dollar/USD amount like '$5'. false for token amounts." },
          all: { type: "boolean", description: "true when the user asks to close/exit/withdraw all of a Morpho position." },
          vaultName: {
            type: "string",
            description: "Optional vault hint, e.g. 'Gauntlet', 'Steakhouse', 'Apostro'. Fuzzy-matched against vault names.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "moonwell_get_position",
      description: "Read a user's current Moonwell (also written 'moon well') position on Base — health factor, supplied/staked assets, borrowed amounts, accrued WELL rewards, and net APY. Call this when the user asks to show/check their Moonwell stake, stakes, position, balance, collateral, debt, or rewards.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_market_price",
      description:
        "Fetch the live USD price for a crypto token on Base or an Avantis-supported tokenized stock/perp market. Use for questions like 'price of ETH', 'what is BASEMATE worth?', 'AAPL stock price', 'how much is TSLA?', or '$DEGEN price'. This is read-only: never use swap/trade tools for price-only questions.",
      parameters: {
        type: "object",
        properties: {
          asset: {
            type: "string",
            description: "Token, stock, or market symbol/address, e.g. ETH, BASEMATE, DEGEN, AAPL, TSLA, COIN, or a 0x Base token address.",
          },
          assetType: {
            type: "string",
            enum: ["token", "stock", "auto"],
            description: "Use stock for equities like AAPL/TSLA/COIN, token for crypto tokens, auto when unsure.",
            default: "auto",
          },
        },
        required: ["asset"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bankr_get_launches",
      description:
        "Trending Bankr ecosystem TOKENS on Base (default for bare 'what's trending' / 'what's hot'). Fresh pools + momentum movers. NOT group chats — use get_trending only when user says communities/groups/chats.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", default: 5 },
          sort: {
            type: "string",
            enum: ["trending", "new", "mixed", "mcap"],
            default: "mixed",
            description:
              "mixed=fresh + trending sections (default), trending=momentum movers only, new=newest launches, mcap=highest market cap",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bankr_launch_token",
      description:
        "Start a native B20 stock-paired token launch on Base App (XMTP). Bankr deploys are retired. On iMessage/WhatsApp this tool only points the user at iStonks (basemate.app/istonks/launch) — do not start a wizard there. Pass ONLY what the user LITERALLY typed. NEVER invent a ticker from the name.",
      parameters: {
        type: "object",
        properties: {
          name:   { type: "string", description: "The token name EXACTLY as the user stated it, e.g. 'Pizza Party Time'. Optional — omit if not given." },
          symbol: { type: "string", description: "Ticker symbol ONLY if the user literally typed one (e.g. '$PIZZA', 'ticker PIZZA', 'symbol PIZZA'). NEVER derive, abbreviate, or acronym it from the name — e.g. do NOT turn 'Pizza Party Time' into 'PPT'. Omit entirely if the user did not explicitly give a ticker; the wizard will ask them." },
        },
      },
    },
  },

  // World Cup house betting
  {
    type: "function",
    function: {
      name: "worldcup_get_matches",
      description:
        "Show FIFA World Cup matches with betting odds. Default: popular upcoming games. Pass team for a specific nation (e.g. USA, Brazil, Argentina). Do NOT pass date when the user asks for a team's games or schedule unless they named a specific day — team queries use the full 14-day search window. Call with a team filter when the user asks about a specific team's match, favorite, or odds — this fetches live data and shows the bet card so they can act immediately. Do NOT re-call without a team filter if a general match list was already shown. Do NOT use this when the user is explicitly placing a bet (e.g. 'bet 100 on Brazil', 'I want to bet on France') — use worldcup_propose_bet instead.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description:
              "ISO date (YYYY-MM-DD) for a specific day only — omit when filtering by team",
          },
          team: {
            type: "string",
            description: "Filter to matches involving this team, e.g. USA, Mexico, Brazil",
          },
          featured: {
            type: "boolean",
            description:
              "true = next big-team games (England, Brazil, USA, etc.). false (default) = next games by kickoff. Ignored when team is set.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "worldcup_propose_bet",
      description:
        "Use this when the user is EXPLICITLY placing a World Cup house casino bet — they've named a team or 'draw' and/or stated an amount. Call immediately without showing matches first. Examples: 'bet 500k on Brazil tonight', 'I want to bet on France', 'put 1m on draw', 'bet on USA win'. Prefer amountBasemate when the user states a token amount (e.g. 'bet 1 million BASEMATE on Brazil'); use stakeUsd only when they say dollars (e.g. 'bet $5 on Brazil'). The house takes the other side — instant placement, no opponent needed. Max stake is 1M BASEMATE (~$5).",
      parameters: {
        type: "object",
        properties: {
          matchId: { type: "string", description: "API-Football fixture id if known" },
          team: {
            type: "string",
            description:
              "Team to back (e.g. Brazil, France, USA) OR 'draw' if the user wants to bet on a draw outcome. Always pass 'draw' literally when the user says draw, tie, or level.",
          },
          amountBasemate: {
            type: "number",
            description:
              "Stake in BASEMATE tokens when user gave an explicit token amount (e.g. bet 1 million BASEMATE on Brazil → 1000000)",
          },
          stakeUsd: {
            type: "number",
            description: "Stake in USD only when user stated a dollar amount (e.g. bet $5 on Brazil → 5)",
          },
        },
      },
    },
  },

  {
    type: "function",
    function: {
      name: "worldcup_list_open_bets",
      description:
        "List the current user's active World Cup bets. Call when the user asks to see, check, or list their own open/active World Cup bets/wagers. Pending deposits, awaiting-settlement bets, and settled bets are excluded. No parameters — always returns bets for the requesting user.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },

  // Dashboard reads — answer in chat AND hand over a /app deep link
  {
    type: "function",
    function: {
      name: "get_recent_activity",
      description:
        "Show the user's recent transaction history (sends, swaps, deposits, funding, etc.). Call when the user asks about their past activity, recent transactions, transaction history, 'what have I done', 'show my activity', or 'what happened on my account'. Returns the latest few transactions AND a link to the full history in the dashboard. No parameters — always the requesting user.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_sends",
      description:
        "Show who the user has sent money to (person-to-person sends). Call when the user asks about their past sends, who they paid, 'who did I send to', 'show my sends', or 'my recent payments to people'. Returns the latest few sends with recipient + amount AND a link to all sends in the dashboard. Do NOT call for swaps or deposits — use get_recent_activity for general history. No parameters.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_payment_mode",
      description:
        "Tell the user their current payment confirmation setting — 'Confirm each' (every payment needs a tap) vs 'Automatic' (payments send without confirmation, up to a limit). Call when the user asks how their payments are set up, 'do my payments auto-send?', 'do I have to confirm payments?', 'what's my payment mode', or 'am I on manual or automatic'. Returns the mode + auto-approve limit AND a link to change it in the dashboard. No parameters.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "set_payment_mode",
      description:
        "Change the user's payment confirmation setting. Call when the user asks to turn automatic payments ON — 'turn on automatic', 'make my sends automatic', 'auto-send my payments', 'stop asking me to confirm', 'don't make me confirm' (mode=automatic) — or to turn it OFF / require confirmation — 'confirm each payment', 'ask me before every send', 'turn off automatic', 'make me confirm each one', 'switch to manual' (mode=manual). Automatic sends payments up to the auto-send limit without a tap; manual confirms every payment. Applies the change and confirms it in chat.",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["automatic", "manual"],
            description:
              "automatic = auto-send up to the limit without a tap; manual = confirm every payment",
          },
        },
        required: ["mode"],
      },
    },
  },

  // AZZLE — agent task marketplace on Base
  {
    type: "function",
    function: {
      name: "azzle_get_open_tasks",
      description:
        "List open POSTED tasks on the AZZLE agent task marketplace (Base mainnet). Call when the user asks about AZZLE tasks, open work on AZZLE, what jobs are available on AZZLE, or wants to claim/find a task on AZZLE. Returns live tasks from the subgraph with escrow amounts and ids. Do NOT call for generic 'what tasks do I have' questions — only for AZZLE marketplace queries.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            description: "Max tasks to return (default 10, max 25)",
            minimum: 1,
            maximum: 25,
          },
        },
      },
    },
  },

  // Aerodrome
  {
    type: "function",
    function: {
      name: "aerodrome_get_pools",
      description: "List top Aerodrome liquidity pools on Base with APY and TVL — for users exploring LP opportunities or asking about Aerodrome yields.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", default: 8, description: "Max pools to return" },
          asset: { type: "string", description: "Optional token filter, e.g. USDC or AERO" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aerodrome_prepare_swap",
      description: "Prepare a swap on the Aerodrome DEX on Base. Use when the user explicitly says 'on aero', 'on aerodrome', 'via aerodrome', or wants to swap AERO itself. Same fromAsset rules as uniswap_prepare_swap — honor ETH/WETH when the user names them.",
      parameters: {
        type: "object",
        properties: {
          fromAsset: { type: "string", description: "Token being sold/spent. Default USDC for bare '$X of Y' buys. If user said ETH/WETH/USDC/etc, use that exactly." },
          toAsset:   { type: "string", description: "Token being bought. e.g. AERO, USDC, WETH" },
          amount:    { type: "string", description: "The numeric value from the user's message. If user said '$5', pass '5' with isUsd=true. If user said '5 USDC', pass '5' with isUsd=false." },
          isUsd:     { type: "boolean", description: "true when the user specified a dollar/USD value to spend (e.g. '$5 of AERO'). false when they specified a token amount of fromAsset (e.g. '5 USDC'). Defaults to false." },
        },
        required: ["fromAsset", "toAsset", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aerodrome_prepare_add_liquidity",
      description: "Add liquidity to an Aerodrome pool on Base. User must provide amounts for both tokens. Builds approve + approve + addLiquidity calldata.",
      parameters: {
        type: "object",
        properties: {
          tokenA:  { type: "string", description: "First token symbol or address, e.g. USDC" },
          tokenB:  { type: "string", description: "Second token symbol or address, e.g. AERO" },
          amountA: { type: "string", description: "Amount of tokenA to deposit, e.g. 100" },
          amountB: { type: "string", description: "Amount of tokenB to deposit, e.g. 500" },
        },
        required: ["tokenA", "tokenB", "amountA", "amountB"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "yield_compare",
      description: "Compare live Moonwell, Morpho, and Aave V3 APYs for a single-sided deposit of a token on Base. Use when the user wants to earn/deposit a token but hasn't specified a protocol. amount is OPTIONAL — only pass it when the user gave a real number; NEVER invent one. If no amount, the tool returns rates only and asks the user how much.",
      parameters: {
        type: "object",
        properties: {
          token:  { type: "string", description: "Token symbol, e.g. AERO" },
          amount: { type: "string", description: "Human-readable amount the user actually said, e.g. '5' or '100'. OMIT when the user did not specify one — do not guess." },
          isUsd:  { type: "boolean", description: "true when the user specified a dollar amount ($5 of AERO)" },
        },
        required: ["token"],
      },
    },
  },

  // Avantis (perpetual futures on Base)
  {
    type: "function",
    function: {
      name: "avantis_guided_trade",
      description: "Start the guided, button-driven perp wizard ONLY when the user names NONE of {token, side, leverage, amount} — pure educational or open-ended interest like 'how does leverage work?', 'can I use leverage?', 'teach me perps', 'i wanna try leverage'. The moment the user names ANY of those fields (even just 'long ETH' or '5x'), call avantis_prepare_trade instead with the stated fields — it pre-fills the same wizard and asks for the rest.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "avantis_get_markets",
      description: "List available perpetual futures markets on Avantis (Base) with max leverage and min position — includes crypto, tokenized stocks (COIN, AAPL, …), indices, forex, commodities. Call when the user asks what perps they can trade or what pairs Avantis supports.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", default: 8, description: "Max markets to return" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "avantis_update_perp_profile",
      description: "Open the perp setup wizard to choose or change risk tier (Steady/Tactical/Aggressive/Basemaxxing) and default USDC margin. DM only for the wizard; in groups, user is nudged to DM. Call when the user wants to change tier, default trade size, or set up perps for the first time. Do not use this for paper trading or automated strategies — those are off.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "avantis_prepare_trade",
      description: "Prepare a perpetual futures trade (long or short, with leverage) on Avantis on Base — crypto, tokenized stocks, indices, forex, commodities. Call this the moment the user names ANY opening field from {token, side, leverage, amount, limit entry price, take profit, stop loss} — even one field ('long COIN', 'short AAPL', '5x ETH', 'long TSLA with $100'). Never refuse stocks; COIN/AAPL/TSLA etc. are valid. Pass ONLY fields the user actually stated; do NOT invent side, leverage, amount, entry price, TP, or SL — except after perp setup is complete, omit leverage/collateral to use saved tier defaults ($ in the message overrides margin for that trade only). Limit orders require orderType=limit and openPrice. TP/SL here are for NEW trades only. If required opening fields are missing, this drops the user into a guided button wizard. Collateral is always USDC. Paper trading and automated strategies are off — do not start those.",
      parameters: {
        type: "object",
        properties: {
          pair:       { type: "string", description: "Market symbol or pair: ETH-USD, COIN-USD, AAPL-USD, US500-USD. Bare symbols (ETH, COIN, AAPL) default to *-USD." },
          side:       { type: "string", enum: ["long", "short"], description: "Trade direction. 'long' = betting price goes up, 'short' = betting price goes down." },
          leverage:   { type: "number", description: "Leverage multiplier, e.g. 5 for 5x. Only pass when the user stated it." },
          collateral: { type: "string", description: "USDC collateral the user is putting up, e.g. '100'. The numeric value only. Only pass when the user stated it. Minimum is typically 100 USDC notional / leverage." },
          orderType:  { type: "string", enum: ["market", "limit"], description: "Use 'limit' only when the user explicitly asks for a limit order / entry at a price. Defaults to market." },
          openPrice:  { type: "string", description: "Limit entry price. Required for limit orders. Only pass when the user stated it." },
          takeProfit: { type: "string", description: "Take-profit price for the new trade. Only pass when the user stated it; omit for no TP." },
          stopLoss:   { type: "string", description: "Stop-loss price for the new trade. Only pass when the user stated it; omit for no SL." },
        },
        required: ["pair", "side"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "avantis_get_positions",
      description: "List Avantis open positions and pending limit orders, or generate a visual PnL card. Set pnlCard:true ONLY when the user asks about PnL/profit/loss (\"check my pnl\") — NOT for position lists (\"check my positions\", \"show open trades\"). pnlCard:true returns a shareable card image (picker if multiple positions). Omit pnlCard (or false) for position lists / trade indexes. For the connected user's own positions, omit target. For another person, pass the exact 0x address, basename/ENS, or @person text the user gave.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Optional target wallet/person to inspect, e.g. 0x..., name.base.eth, name.eth, or @person. Omit for the sender's own wallet." },
          pnlCard: { type: "boolean", description: "When true, generate a visual PnL card instead of a text positions list. Required for PnL/profit/loss requests." },
          pair: { type: "string", description: "Optional pair filter when the user names a market (e.g. BTC, ETH, COIN). Use for \"pnl on btc\" — only that position's card; if none open, explain what they do have." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "avantis_close_position",
      description: "Build a signable transaction to close an EXISTING Avantis open position. Use when the user asks to close, exit, or reduce a perp position. Omit collateralToClose for a full close; pass it only when the user explicitly requests a partial close amount.",
      parameters: {
        type: "object",
        properties: {
          pair:              { type: "string", description: "Trading pair or base token, e.g. ETH-USD or ETH." },
          pairIndex:         { type: "number", description: "Avantis pair index, if already known." },
          tradeIndex:        { type: "number", description: "Per-pair trade index. Required when multiple positions exist for a pair." },
          collateralToClose: { type: "string", description: "Optional USDC collateral amount to close for a partial close. Omit for a full close." },
          walletScope:       { type: "string", enum: ["active", "basemate", "both"], description: "Which wallet to close from. Use basemate for Basemate/server/strategy wallet phrases; active for main/current wallet; both only when explicitly requested." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "avantis_close_all_positions",
      description: "Build signable transactions to close every open Avantis position at once. Use when the user asks to close all, exit everything, or flatten all perps.",
      parameters: {
        type: "object",
        properties: {
          walletScope: { type: "string", enum: ["active", "basemate", "both"], description: "Which wallet to close from. Use basemate for Basemate/server/strategy wallet phrases; active for main/current wallet; both only when explicitly requested." },
        },
      },
    },
  },

  // Capabilities menu (always available)
  {
    type: "function",
    function: {
      name: "show_capabilities_menu",
      description:
        "Show Basemate's full interactive capabilities menu (Trade/Swap, Yield, Alerts, Onramp/Offramp, More). Call immediately when the user explicitly asks for menu, help, or wants to browse options — not for informational 'what can you do' questions (use describe_capabilities for those).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "avantis_update_tpsl",
      description: "Build a signable transaction to update take profit and/or stop loss on an EXISTING Avantis open position. Use after the user asks to set, update, move, remove, or clear TP/SL on an existing trade. If tradeIndex is unknown and multiple positions match, ask/list positions first.",
      parameters: {
        type: "object",
        properties: {
          pair:       { type: "string", description: "Trading pair or base token, e.g. ETH-USD or ETH." },
          pairIndex:  { type: "number", description: "Avantis pair index, if already known." },
          tradeIndex: { type: "number", description: "Per-pair trade index. Required when multiple positions exist for a pair." },
          takeProfit: { type: "string", description: "New take-profit price. Pass '0' to remove TP. Omit only if keeping current TP." },
          stopLoss:   { type: "string", description: "New stop-loss price. Pass '0' to remove SL. Omit only if keeping current SL." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "avantis_cancel_limit",
      description: "Build a signable transaction to cancel an existing pending Avantis limit order. Use when the user asks to cancel a pending limit order.",
      parameters: {
        type: "object",
        properties: {
          pair:       { type: "string", description: "Trading pair or base token, e.g. ETH-USD or ETH." },
          pairIndex:  { type: "number", description: "Avantis pair index, if already known." },
          tradeIndex: { type: "number", description: "Pending limit order trade index." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "describe_capabilities",
      description:
        "Use ONLY for a broad, open-ended 'what can you do?' / 'what is this?' / 'what is Basemate?' question. " +
        "Return a short, warm GUIDE in Basemate's sharp-friend voice — a few natural lowercase lines with real personality (you're their crypto-native money mate, not a help desk). Teach the exact phrases to text: send a friend cash (\"send $20 to Alex\", or share their contact card), add cash (\"deposit $20\"), earn on your USDC (\"earn on USDC\"), and check your balance (\"balance\"). " +
        "Close with a casual, warm invite that VARIES every time (e.g. \"what's the move?\", \"what are we getting into?\", \"wanna start with one?\") — never the robotic \"what would you like to do\". Vary all the wording each time; do NOT copy verbatim. Lead with those four; no jargon, no overstating. " +
        "For SPECIFIC questions like 'can i do X?', 'how does yield work?', or 'do you support Y?', answer those directly and concretely instead of calling this tool. Never say 'ship'. Do NOT also call show_capabilities_menu.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "A short, warm guide in Basemate's voice (a few lowercase lines with personality) teaching the exact phrases to text — send a friend (\"send $20 to Alex\" or share a contact), add cash (\"deposit $20\"), earn (\"earn on USDC\"), balance (\"balance\") — closing with a casual, varied invite like \"what's the move?\" (never the same line twice, never robotic).",
          },
        },
        required: ["summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "offer_support",
      description:
        "Offer the Basemate support group join button ONLY as a last resort — after you've already tried to troubleshoot or answer the user's issue yourself and genuinely can't resolve it. Do NOT call this on first mention of a bug or problem. First attempt to diagnose and fix the issue yourself. Only call this if you've tried and the user still needs human help from the team.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Short empathetic reply before the join button (1-2 lines)",
          },
        },
        required: ["message"],
      },
    },
  },

  // ── Messaging-platform tools (iMessage / WhatsApp) ────────────────────────
  {
    type: "function",
    function: {
      name: "price_alert_create",
      description:
        "Create a price or market-cap alert that notifies the user when a token crosses a threshold. " +
        "Use when the user says things like 'alert me when ETH hits 4000', 'notify me if BTC drops below 50k', " +
        "or 'let me know when DOGE market cap reaches 10 billion'. " +
        "Extract the token symbol or address, target value, and direction from the user's message.",
      parameters: {
        type: "object",
        properties: {
          token: {
            type: "string",
            description: "Token symbol (e.g. ETH, BTC, DOGE) or on-chain contract address (0x…)",
          },
          targetValue: {
            type: "number",
            description: "Target price in USD (or market cap in USD when metric is market_cap_usd)",
          },
          direction: {
            type: "string",
            enum: ["above", "below"],
            description: "Trigger when the value goes above or below the target",
          },
          metric: {
            type: "string",
            enum: ["price_usd", "market_cap_usd"],
            description: "What to monitor — price (default) or market cap",
          },
        },
        required: ["token", "targetValue", "direction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "price_alert_list",
      description:
        "List all active price and market-cap alerts for the user. " +
        "Use when the user asks to see, check, or show their current alerts.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "price_alert_cancel",
      description:
        "Cancel one or all active price alerts. " +
        "Pass an alertId to cancel a specific alert (the number from 'alert #3: …'), " +
        "or omit it to cancel everything. " +
        "Use when the user says 'cancel alert 3', 'remove my ETH alert', or 'cancel all alerts'.",
      parameters: {
        type: "object",
        properties: {
          alertId: {
            type: "number",
            description: "ID of a specific alert to cancel. Omit to cancel all alerts.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "contact_list",
      description:
        "Show the user's saved contacts (names and phone numbers). " +
        "Use when the user asks 'show my contacts', 'list contacts', or 'who do i have saved'.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_portfolio_review",
      description:
        "Enable, disable, or show the user's scheduled daily portfolio review. " +
        "Use when the user says things like 'portfolio review every day at 8am', " +
        "'stop my daily review', 'when is my portfolio review', or 'set up daily portfolio digest'. " +
        "Do NOT use for showing the current portfolio balance — use get_portfolio_summary for that.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];
