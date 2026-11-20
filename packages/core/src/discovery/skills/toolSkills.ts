/**
 * Fat skills — routing judgment lives on each tool, not in the system prompt.
 * Appended to OpenAI tool descriptions via applyToolSkills().
 */
import { formatSpotBuyableForPrompt } from "@/discovery/doppler/stockCatalog.js";

export const TOOL_SKILLS: Record<string, string> = {
  search_communities:
    "WHEN: user wants to find/join/discover group chats by topic or keyword.\n" +
    "NOT: token launch (bankr_launch_token) or trending list without a search query (get_trending).\n" +
    'EXAMPLES: "find a degen group" → query=degen; "any nft communities?" → query=nft',

  get_trending:
    "WHEN: user EXPLICITLY asks about trending GROUP CHATS / communities / channels.\n" +
    "NOT for bare 'what's trending' or 'what's hot' — those are tokens (bankr_get_launches).\n" +
    'EXAMPLES: "what communities are trending?" / "trending groups on base" → limit=3',

  recommend_for_user:
    "WHEN: personalized group recommendations for this user based on past interests.\n" +
    'EXAMPLES: "recommend groups for me" / "what should I join?"',

  get_wallet_balance:
    "WHEN (custodial/iMessage only): balance, funds, wallet address, " +
    '"do I have a wallet", "show my wallet". Never say you cannot create a wallet — it exists.\n' +
    "Go straight to tool; no troubleshooting first.",

  fund_wallet:
    "WHEN (custodial only): add funds, deposit, top up, fund wallet, buy crypto into wallet.\n" +
    'EXAMPLES: "add $25" → amountUsd=25',

  withdraw_funds:
    "WHEN (custodial only): withdraw/move USDC or ETH to an external 0x address.\n" +
    'EXAMPLES: "send 10 USDC to 0xabc..." → to, amount, asset=USDC',

  offramp_to_fiat:
    "WHEN (custodial only): cash out, sell to fiat, withdraw to bank, offramp.\n" +
    'EXAMPLES: "cash out $50 USDC" → amount="50"',

  send_token:
    "WHEN: send/transfer/pay/tip/give/shoot/toss/fire tokens to a person, contact name, address, or basename. Also polite wrappers (can you send, please send, help me send, I want to send).\n" +
    `NOT for Coinbase B20 stocks (${formatSpotBuyableForPrompt()}) — use gift_stock.\n` +
    "RULES: isUsd=true only when user said $ amount. A $ amount without a named token defaults to USDC. Bare @handles unsupported. Pass the full basename (name.base.eth) as `to` — do not strip the suffix. For 'all'/'everything'/'max', pass amount='all' (and all=true).\n" +
    "RULES: The recipient can appear ANYWHERE and in ANY word order — before or after the amount, with or without the word 'to'. It may be a contact NAME (e.g. 'Degeneer', 'mom'), a 0x address, or a basename. Set `to` to exactly what the user wrote (Basemate resolves contact names itself). Only ask for a recipient when the message genuinely names none — never invent one.\n" +
    "RULES: Prefer numeric amounts (.01, 0.01). Word amounts: 'a penny'/'one cent'/'1 cent'/'a cent' → amount='0.01'. Asset synonyms: stables/dollars/bucks → USDC. Bare 'a cent' with no asset → USDC.\n" +
    "RULES: Optional memo — if the user added a note ('for lunch', 'note: birthday'), pass memo with the short note. Omit memo when they did not imply one — never invent it.\n" +
    "CRITICAL: NEVER reply in text demanding a basename (.base.eth) or 0x address when the user named a person/contact. A plain name IS a valid recipient — call send_token with that name and let Basemate resolve it. Do not refuse, do not ask for an 'exact format'.\n" +
    'EXAMPLES: "send $1 of basemate to alice.base.eth" → asset=BASEMATE, amount=1, isUsd=true, to=alice.base.eth; ' +
    '"send 6.7 usdc to bob.base.eth" → asset=USDC, amount=6.7, isUsd=false, to=bob.base.eth; ' +
    '"send Degeneer .01 usdc" → asset=USDC, amount=.01, to=Degeneer; ' +
    '"pay bob 5 usdc" → asset=USDC, amount=5, to=bob; ' +
    '"shoot alice 10 usdc" → asset=USDC, amount=10, to=alice; ' +
    '"tip Degeneer a penny in USDC for lunch" → asset=USDC, amount=0.01, to=Degeneer, memo=lunch; ' +
    '"send Degeneer .01 stables" → asset=USDC, amount=.01, to=Degeneer; ' +
    '"send all usdc to bob.base.eth" → asset=USDC, amount=all, all=true, to=bob.base.eth',

  gift_stock:
    `WHEN: user wants to send a Coinbase B20 stock (${formatSpotBuyableForPrompt()}) to a person, by name or ticker.\n` +
    "RULES: Never refuse a stock name yourself. Call gift_stock and let it say whether the stock is available.\n" +
    "NOT send_token, not uniswap_prepare_swap, not avantis_prepare_trade (those are perps).\n" +
    "RULES: isUsd=true for dollar notional ('$25 of Apple'); false for share count ('1 Apple stock'). Pass the contact name as `to`.\n" +
    "RULES: A phone is only ok as `to` when the country code is already on it (+380…, +44…, +1…). Pass that number through unchanged. If it has no country code, ask the user for the code before calling this tool. Never assume +1.\n" +
    "RULES: Holdings first if they already hold the stock; otherwise Apple Pay then buy + send. Never swap leftover USDC.\n" +
    'EXAMPLES: "send mom 1 Apple stock" → to=mom, stock=Apple, amount=1, isUsd=false; ' +
    '"gift dad $25 of NVDA" → to=dad, stock=NVDA, amount=25, isUsd=true; ' +
    '"send $10 of Apple to mom" → to=mom, stock=Apple, amount=10, isUsd=true',

  resolve_name:
    "WHEN: user asks to look up / resolve a basename, ENS name, or 0x address (who owns X, what address is Y.base.eth, what's the name for 0x…).\n" +
    "NOT for sending tokens — use send_token for transfers (it resolves names itself).\n" +
    'EXAMPLES: "what address is alice.base.eth?" → name=alice.base.eth; "who is 0xabc…?" → name=0xabc…',

  uniswap_prepare_swap:
    "WHEN: immediate market swap/buy/sell any spot token. Routes through Definitive Flash when configured (not Kyber/Uniswap).\n" +
    "NOT for limit/stop/take-profit/TWAP — use flash_prepare_order for those.\n" +
    "RULES: If user names a source token (ETH, USDC, …), use it — never substitute USDC.\n" +
    'EXAMPLES: "buy $5 basemate" → from=USDC,to=BASEMATE,amount=5,isUsd=true; ' +
    '"swap 0.01 eth for basemate" → from=ETH,to=BASEMATE,amount=0.01,isUsd=false; ' +
    '"buy $10 MXNB" → from=USDC,to=MXNB,amount=10,isUsd=true',

  flash_prepare_order:
    "WHEN: spot orders on Flash — market, limit, stop, stop-loss, take-profit, or TWAP on Base.\n" +
    "Prefer this for explicit limit/stop/TWAP. For simple buy/sell, uniswap_prepare_swap also uses Flash when configured.\n" +
    "NOT for leveraged perps (Avantis).\n" +
    "RULES: targetAsset = traded token; contraAsset = quote token (usually USDC). qty is spend amount (contra on buy, target on sell). limit needs limitNotionalPrice (USD). triggers need triggerNotionalPrice. TWAP needs durationSeconds >= 300.\n" +
    'EXAMPLES: "limit buy 100 USDC of ETH at $2500" → target=ETH,contra=USDC,side=buy,qty=100,orderType=limit,limitNotionalPrice=2500; ' +
    '"stop loss sell 0.5 ETH at $2000" → target=ETH,contra=USDC,side=sell,qty=0.5,orderType=stop-loss,triggerNotionalPrice=2000; ' +
    '"twap sell 1 ETH over 4 hours" → target=ETH,contra=USDC,side=sell,qty=1,orderType=twap,durationSeconds=14400',

  flash_list_orders:
    "WHEN: user asks about open Flash / limit / TWAP / stop orders.\n" +
    'EXAMPLES: "my flash orders" / "open limit orders"',

  flash_cancel_order:
    "WHEN: user wants to cancel a specific Flash order by id.\n" +
    'EXAMPLES: "cancel flash order ord_abc…" → orderId=ord_abc…',

  aerodrome_prepare_swap:
    "WHEN: user explicitly says on aero/aerodrome/via aerodrome, or swaps AERO and wants Aerodrome specifically. For normal swaps use uniswap_prepare_swap (auto-picks best venue).",

  aerodrome_get_pools:
    "WHEN: pool list, LP APR, Aerodrome yields, " +
    '"show me aero pools". NOT single-sided earn (yield_compare).',

  aerodrome_prepare_add_liquidity:
    "WHEN: user wants to add LP to a specific Aerodrome pair with both amounts stated.",

  yield_compare:
    "WHEN: earn/deposit/lend a token without naming Moonwell/Morpho/Aave and without pool/LP wording.\n" +
    "ALSO when user asks for the BEST/HIGHEST yield/APY/APR for a token, where to park/put a token, or compares yields. Treat 'on base' as chain context, NOT a token.\n" +
    "DEFAULT for single-sided earn. Compares Moonwell, Morpho, and Aave V3 APYs.\n" +
    "amount OMIT unless user stated a number — never invent.\n" +
    "EXAMPLES:\n" +
    '  "earn on my AERO" → token=AERO\n' +
    '  "put $5 on cbBTC" → token=cbBTC, amount=5, isUsd=true\n' +
    '  "best usdc yield on base" → token=USDC (no amount; "base" is the chain)\n' +
    '  "highest apy for usdc" → token=USDC\n' +
    '  "park my usdc" → token=USDC\n' +
    '  "where should I park my eth" → token=WETH\n' +
    '  "compare yields for usdc" → token=USDC\n' +
    '  "best place to earn with cbbtc" → token=cbBTC',

  morpho_get_vaults:
    "WHEN: user explicitly says Morpho or names a vault. Optional asset filter.",

  morpho_prepare_deposit:
    "WHEN: Morpho deposit after user picked vault or said Morpho. amount OMIT if not stated.",

  morpho_get_position:
    "WHEN: Morpho staked/supplied/deposited balance, position status, or generic 'how much do I have staked?' after Morpho. Reads on-chain — never from a prepared tx.",

  aave_prepare_supply:
    "WHEN: user explicitly says Aave or 'on aave' / 'supply on aave'. Supports USDC, WETH, cbBTC, wstETH, cbETH, USDS. amount OMIT if not stated.",

  moonwell_prepare_supply:
    "WHEN: user explicitly says Moonwell or pangolins/steakhouse terms. amount OMIT if not stated.",

  moonwell_prepare_withdraw:
    "WHEN: user wants to close, exit, withdraw, redeem, remove, or unstake a Moonwell supplied/lending position. Use all=true for close all / withdraw all.",

  moonwell_get_position:
    "WHEN: Moonwell (or 'moon well') health factor, collateral, debt, rewards, position status, supplied/staked balance, stake, or stakes.",

  bankr_get_launches:
    "WHEN: DEFAULT for bare 'what's trending' / 'what's hot' / token market heat.\n" +
    "Also: Bankr launches, hot memecoins, trending tickers, new/fresh pools.\n" +
    "NOT for group chats — get_trending ONLY if user says communities/groups/chats.\n" +
    'sort=mixed (default) for general "what\'s trending" — fresh + movers sections.\n' +
    "sort=trending for momentum/movers only.\n" +
    'sort=new for "new launches", "just launched".\n' +
    'sort=mcap for highest market cap only.',

  bankr_launch_token:
    "WHEN: launch/create/deploy their own token on Base App (XMTP) as a native B20 stock pair.\n" +
    "Bankr launches are RETIRED. Never promise a Bankr deploy.\n" +
    "On iMessage/WhatsApp do not start a wizard — the tool points them at iStonks.\n" +
    "Call IMMEDIATELY. NEVER invent ticker from name (Pizza Party → NOT PPT). Omit symbol unless user typed ticker.\n" +
    "Never claim token is live or invent CA.",

  avantis_guided_trade:
    "WHEN: pure perp education with NONE of {token, side, leverage, amount} named.\n" +
    'EXAMPLES: "how does leverage work?" — NOT "long eth" (use avantis_prepare_trade).',

  avantis_get_markets:
    "WHEN: what perps/pairs can I trade, max leverage, market list. Includes stocks (COIN, AAPL…).",

  avantis_update_perp_profile:
    "WHEN: change risk tier or default USDC margin / first-time VibeTrading setup in DM. Say Less main-menu quick action.",

  avantis_prepare_trade:
    "WHEN: user names ANY open field: token, side, leverage, amount, limit price, TP, SL.\n" +
    "Also WHEN [Active perp trade wizard] context — merge wizard fields with the user's reply for the awaiting field.\n" +
    "Never refuse stock perps. Pass ONLY stated fields; after setup omit leverage/collateral for defaults.\n" +
    'EXAMPLES: "long eth $25" → pair=ETH,side=long,collateral=25; wizard awaiting token + reply "COIN" → pair=COIN + wizard side',

  avantis_get_positions:
    "WHEN: own or someone else's open perps / pending limits / PnL.\n" +
    "pnlCard:true ONLY for PnL/profit/loss (\"check my pnl\") — NOT \"check my positions\" (text list).\n" +
    "pair when user names market (\"pnl on btc\"). target for another wallet (0x, basename, @person).\n" +
    'EXAMPLES: "check my pnl" → pnlCard:true; "what perps am I in?" → omit pnlCard; "#2" close uses close tool not this.',

  avantis_close_position:
    "WHEN: close/exit/flatten ONE existing open position. Reply #N from positions list maps to tradeIndex.\n" +
    "collateralToClose only for explicit partial close. Single match required — list positions if ambiguous.\n" +
    'EXAMPLES: "close my eth position" → pair=ETH; "#1" → tradeIndex=1; "close #2" → tradeIndex=2',

  avantis_close_all_positions:
    "WHEN: close all / exit everything / flatten all open perps.\n" +
    'EXAMPLES: "close all positions" / "exit all my trades". NOT single close (avantis_close_position).',

  avantis_update_tpsl:
    "WHEN: set/update/remove TP or SL on an EXISTING open position (not new trade). tradeIndex if multiple.",

  avantis_cancel_limit:
    "WHEN: cancel a pending limit order. tradeIndex if multiple pending on same pair.",

  show_capabilities_menu:
    "WHEN: user explicitly wants the interactive menu (\"menu\", \"help\", browse options).\n" +
    "NOT informational what-can-you-do (describe_capabilities).",

  describe_capabilities:
    "WHEN: informational what can you do / features / how can you help.\n" +
    "Lead earn, learn, trade on Base. Opens the menu with your summary as the message — do NOT also call show_capabilities_menu.",

  offer_support:
    "WHEN: bug, broken, not working, need support/help from team.\n" +
    "Short empathy + support group button. Do not troubleshoot at length first.",

  worldcup_get_matches:
    "WHEN: user asks about World Cup matches, games, schedule, who's playing, or a specific team.\n" +
    'EXAMPLES: "show me today\'s World Cup games" / "what\'s on next?" → { featured: false }; ' +
    '"big world cup games" / "featured matches" / "when does England play?" → { featured: true } or { team: "England" }; ' +
    '"USA game" → { team: "USA" }; "Argentina games" → { team: "Argentina" } (do not pass date); ' +
    '"all games on June 13" → { date: "2026-06-13" }',

  worldcup_propose_bet:
    "WHEN: user wants to bet on a World Cup match, back a team, wager on a game.\n" +
    'EXAMPLES: "bet 1 million BASEMATE on Brazil" → team=Brazil, amountBasemate=1000000; ' +
    '"bet $5 on Brazil" → team=Brazil, stakeUsd=5; ' +
    '"I\'ll back France" → team=France (wizard prompts for amount)',

  worldcup_list_open_bets:
    "WHEN: user asks to see, check, or list their own open/active World Cup bets or wagers. No parameters. Pending deposits, awaiting-settlement bets, and settled bets are excluded.\n" +
    'EXAMPLES: "show my world cup bets" / "what bets do I have open" / "my wc wagers" / "do I have any active world cup bets"',

  get_market_price:
    "WHEN: user asks the price / value / how much a token is worth, or any factual price question.\n" +
    "ALWAYS call this tool before stating a price — never invent or guess a number from memory.\n" +
    'EXAMPLES: "what\'s the price of ETH?" → token=ETH; "how much is cbBTC?" → token=cbBTC; ' +
    '"is basemate up today?" → token=BASEMATE',

  morpho_prepare_withdraw:
    "WHEN: user wants to exit, close, withdraw, pull out, or remove funds from a Morpho vault.\n" +
    "Call morpho_get_position first if no amount is stated to show current balance.\n" +
    'Use amount=all (or all:true) for "withdraw everything".\n' +
    'EXAMPLES: "withdraw from morpho" → call morpho_get_position first; ' +
    '"pull out all my morpho USDC" → all=true',

  sweep_funds:
    "WHEN (custodial/iMessage only): user wants to move ALL funds from their server wallet to their own wallet address.\n" +
    "Only valid when a custodial wallet exists. Asks for confirmation if not already confirmed.\n" +
    'EXAMPLES: "sweep my wallet" / "move all funds to my wallet" / "transfer everything out"',

  azzle_get_open_tasks:
    "WHEN: user asks about AZZLE tasks, rewards, missions, earning through tasks, or what tasks are available.\n" +
    'EXAMPLES: "show me AZZLE tasks" / "how do I earn on AZZLE?" / "any open missions?" / "claim a task"',
};
