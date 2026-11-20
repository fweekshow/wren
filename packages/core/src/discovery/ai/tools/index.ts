import type OpenAI from "openai";
import { config } from "@/config/config.js";
import { isStrategyLiveTradingPaused } from "@/discovery/strategy/liveTrading.js";

const isAvantisLive = () => false;
const isLaunchpadMode = () => false;
const WORLD_CUP_ENABLED = false;
const WORLDCUP_TOOL_NAMES = new Set<string>();
import { applyToolSkills } from "@/discovery/skills/applyToolSkills.js";
import { TOOLS } from "./schemas.js";

const LAUNCHPAD_ALLOWED = new Set([
  "bankr_launch_token",
  "bankr_get_launches",
  "get_market_price",
  "resolve_name",
]);

const AVANTIS_TOOL_NAMES = new Set([
  "avantis_guided_trade",
  "avantis_get_markets",
  "avantis_prepare_trade",
  "avantis_update_perp_profile",
  "avantis_get_positions",
  "avantis_close_position",
  "avantis_close_all_positions",
  "avantis_update_tpsl",
  "avantis_cancel_limit",
]);
const AVANTIS_LIVE_OPEN_TOOL_NAMES = new Set([
  "avantis_guided_trade",
  "avantis_prepare_trade",
]);
const CUSTODIAL_TOOL_NAMES = new Set([
  "get_wallet_balance",
  "fund_wallet",
  "withdraw_funds",
  "sweep_funds",
  "offramp_to_fiat",
]);
// Dashboard reads back the /app companion (phone/embedded channels). Base App
// (XMTP) users have their own wallet UI and no escrow-send / pay-mode data, so
// these are hidden there.
const DASHBOARD_TOOL_NAMES = new Set([
  "get_recent_activity",
  "get_recent_sends",
  "get_payment_mode",
  "set_payment_mode",
]);
const FLASH_TOOL_NAMES = new Set([
  "flash_prepare_order",
  "flash_list_orders",
  "flash_cancel_order",
]);

/** Channels where leveraged perps (Avantis) are intentionally unavailable. */
function perpsDisabledForChannel(channel?: string): boolean {
  return channel === "imessage" || channel === "whatsapp";
}

export function getTools(opts?: {
  custodial?: boolean;
  channel?: string;
}): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const noPerps = perpsDisabledForChannel(opts?.channel);
  const filtered = TOOLS.filter((t: OpenAI.Chat.Completions.ChatCompletionTool) => {
    if (t.type !== "function") return true;
    const name = t.function.name;
    // iMessage/WhatsApp do not offer perps — never expose Avantis tools there.
    if (noPerps && AVANTIS_TOOL_NAMES.has(name)) return false;
    if (!isAvantisLive() && AVANTIS_TOOL_NAMES.has(name)) return false;
    if (isStrategyLiveTradingPaused() && AVANTIS_LIVE_OPEN_TOOL_NAMES.has(name)) return false;
    if (!WORLD_CUP_ENABLED && WORLDCUP_TOOL_NAMES.has(name)) return false;
    if (CUSTODIAL_TOOL_NAMES.has(name) && !opts?.custodial) return false;
    // Dashboard reads are for the phone/embedded channels — not Base App (XMTP).
    if (DASHBOARD_TOOL_NAMES.has(name) && opts?.channel === "xmtp") return false;
    // Flash advanced orders require FLASH_API_KEY; hide tools when unset.
    if (FLASH_TOOL_NAMES.has(name) && !config.flash.enabled) return false;
    if (isLaunchpadMode() && opts?.channel === "xmtp" && !LAUNCHPAD_ALLOWED.has(name)) {
      return false;
    }
    return true;
  });
  return applyToolSkills(filtered);
}
