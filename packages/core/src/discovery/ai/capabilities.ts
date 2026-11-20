/**
 * Auto-generated capability manifest for DiscoveryAI.
 *
 * Generated at module-load time from the live TOOLS array in schemas.ts.
 * Adding a tool to schemas.ts automatically includes it in the manifest —
 * no other file needs to change.
 */
import { TOOLS } from "@/discovery/ai/tools/schemas.js";

// Infrastructure tools that are not user-facing capabilities
const INFRA_TOOLS = new Set([
  "show_capabilities_menu",
  "describe_capabilities",
  "offer_support",
]);

// Leveraged-perp (Avantis) tools — excluded from the manifest on channels that
// don't support perps (iMessage/WhatsApp) so the brain never advertises them.
const PERPS_TOOLS = new Set([
  "avantis_guided_trade",
  "avantis_get_markets",
  "avantis_update_perp_profile",
  "avantis_prepare_trade",
  "avantis_get_positions",
  "avantis_close_position",
  "avantis_close_all_positions",
  "avantis_update_tpsl",
  "avantis_cancel_limit",
]);

// Human-readable category labels keyed by tool name.
// Order here determines the order categories appear in the manifest — pillar-first.
const TOOL_CATEGORY: Record<string, string> = {
  // Pillar 1: Trade & Swap
  avantis_guided_trade: "Trade & Swap",
  avantis_get_markets: "Trade & Swap",
  avantis_update_perp_profile: "Trade & Swap",
  avantis_prepare_trade: "Trade & Swap",
  avantis_get_positions: "Trade & Swap",
  avantis_close_position: "Trade & Swap",
  avantis_close_all_positions: "Trade & Swap",
  avantis_update_tpsl: "Trade & Swap",
  avantis_cancel_limit: "Trade & Swap",
  uniswap_prepare_swap: "Trade & Swap",
  aerodrome_prepare_swap: "Trade & Swap",
  aerodrome_get_pools: "Trade & Swap",
  aerodrome_prepare_add_liquidity: "Trade & Swap",
  // Pillar 2: Price Alerts
  price_alert_create: "Price Alerts",
  price_alert_list: "Price Alerts",
  price_alert_cancel: "Price Alerts",
  // Pillar 3: Yield
  morpho_get_vaults: "Yield",
  morpho_prepare_deposit: "Yield",
  morpho_get_position: "Yield",
  morpho_prepare_withdraw: "Yield",
  moonwell_prepare_supply: "Yield",
  moonwell_get_position: "Yield",
  moonwell_prepare_withdraw: "Yield",
  aave_prepare_supply: "Yield",
  yield_compare: "Yield",
  // Pillar 4: Onramp & Offramp
  fund_wallet: "Onramp & Offramp",
  offramp_to_fiat: "Onramp & Offramp",
  sweep_funds: "Onramp & Offramp",
  // Secondary: Wallet & Sends
  get_wallet_balance: "Wallet",
  send_token: "Wallet",
  gift_stock: "Wallet",
  withdraw_funds: "Wallet",
  resolve_name: "Wallet",
  contact_list: "Wallet",
  schedule_portfolio_review: "Wallet",
  // Secondary: Market & Research
  get_market_price: "Market",
  bankr_get_launches: "Market",
  // Secondary: Launch
  bankr_launch_token: "Launch",
  // Secondary: Communities
  search_communities: "Communities",
  get_trending: "Communities",
  recommend_for_user: "Communities",
  // Secondary: AZZLE
  azzle_get_open_tasks: "AZZLE",
  // Seasonal / World Cup
  worldcup_get_matches: "World Cup",
  worldcup_propose_bet: "World Cup",
  worldcup_list_open_bets: "World Cup",
};

function firstSentence(description: string): string {
  return description.split(/[.\n]/)[0].trim();
}

/**
 * Builds a concise, categorized capability manifest from the live TOOLS array.
 * Returns a multi-line string suitable for injection into the system prompt.
 */
export function buildCapabilityManifest(opts: { excludePerps?: boolean } = {}): string {
  const categories = new Map<string, string[]>();

  for (const tool of TOOLS) {
    // Only process function-type tools (the only kind we use)
    if (tool.type !== "function") continue;
    if (INFRA_TOOLS.has(tool.function.name)) continue;
    if (opts.excludePerps && PERPS_TOOLS.has(tool.function.name)) continue;
    const category = TOOL_CATEGORY[tool.function.name] ?? "Other";
    if (!categories.has(category)) categories.set(category, []);
    categories.get(category)!.push(
      `  • ${tool.function.name}: ${firstSentence(tool.function.description ?? "")}`,
    );
  }

  const lines: string[] = ["TOOL CAPABILITIES (auto-generated — always current):"];
  for (const [category, entries] of categories) {
    lines.push(`${category}:`);
    lines.push(...entries);
  }
  return lines.join("\n");
}

/**
 * Pre-built manifests, generated once at module load.
 * `CAPABILITY_MANIFEST` is the full set (XMTP/Base App). `CAPABILITY_MANIFEST_NO_PERPS`
 * drops leveraged-perp tools for channels that don't support them (iMessage/WhatsApp).
 */
export const CAPABILITY_MANIFEST: string = buildCapabilityManifest();
export const CAPABILITY_MANIFEST_NO_PERPS: string = buildCapabilityManifest({
  excludePerps: true,
});
