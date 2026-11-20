/**
 * discovery.stateKeys — XMTP conversation-state key factory + pending-flow helpers.
 *
 * Extracted from discovery.plugin.ts.
 * All cross-domain pending-flow utilities live here so handler modules can import
 * just this file instead of the full plugin.
 *
 * Exported surface:
 *   XK          — Redis key factory (22 key slots, all scoped to "xmtp" platform)
 *   TxConfirmLink / PendingProtocolVolume / CopyTradeContext — shared state types
 *   registerPendingTxConfirmLink — register the post-sign confirm link for a conv
 *   touchPending / clearPendingIfExpired — 15-minute TTL for wizard flows
 *   activePendingLabel — debug helper: which slot is active for a key
 *   pendingCashout / pendingCustomYieldToken / pendingStrategyPrompt / improveInFlight
 *       — in-memory sets shared across handler domains
 */

import {
  convKey,
  stateDelete,
  stateGet,
  stateHas,
  stateHasAny,
  stateSet,
} from "@/state/conversationState.store.js";
import {
  pendingUserKey,
  registerPendingInteractionChecker,
} from "@/xmtp/core/pendingInteractionRegistry.js";
import type { CopyTradeCtxPayload } from "@/discovery/ai.js";

// ── Shared type aliases ───────────────────────────────────────────────────────

/** Post-sign confirmation link: basemate.app/txn for swaps/buys; Avantis mini app for perps. */
export type TxConfirmLink = "basemate" | "avantis";

export type PendingProtocolVolume = {
  inboxId: string;
  protocol: "moonwell" | "morpho" | "aave" | "avantis" | "uniswap" | "aerodrome" | "bankr";
  action: string;
  token?: string;
  amountUsdc: number;
  notionalUsdc?: number;
};

/** Pending Doppler Multicurve create awaiting wallet_sendCalls confirmation. */
export type PendingDopplerLaunch = {
  name: string;
  symbol: string;
  pairSymbol: string;
  pairAddress: string;
  predictedToken: string;
  poolId?: string;
  wallet: string;
  /** Beneficiary split at prepare time; shares are decimal strings (JSON-safe). */
  beneficiaries?: Array<{ beneficiary: string; shares: string }>;
  createdAt: number;
};

/**
 * Copy trade context stored in a group after a member signs a swap or perp open.
 * Includes the originating inboxId + a 5-minute TTL so it never fires stale.
 */
export type CopyTradeContext = CopyTradeCtxPayload & {
  label: string;
  originInboxId: string;
  expiresAt: number;
};

// ── XMTP conversation-state key builders ─────────────────────────────────────
// All pending-flow Maps are backed by Redis (with in-process fallback).
// Platform tag is "xmtp". Key pattern: conv:xmtp:{scopeId}:{slotName}.

export const XK = {
  pendingCustomBuy:          (k: string) => convKey("xmtp", k, "pendingCustomBuy"),
  pendingCustomDeposit:      (k: string) => convKey("xmtp", k, "pendingCustomDeposit"),
  pendingYieldFollowUp:      (k: string) => convKey("xmtp", k, "pendingYieldFollowUp"),
  pendingCustomPerpTopUp:    (k: string) => convKey("xmtp", k, "pendingCustomPerpTopUp"),
  pendingProtocolVolume:     (k: string) => convKey("xmtp", k, "pendingProtocolVolume"),
  pendingSweepXmtp:          (k: string) => convKey("xmtp", k, "pendingSweep"),
  pendingPostTxActionXmtp:   (k: string) => convKey("xmtp", k, "pendingPostTxAction"),
  pendingGroupCopyTrade:     (k: string) => convKey("xmtp", k, "pendingGroupCopyTrade"),
  pendingTxConfirmLink:      (k: string) => convKey("xmtp", k, "pendingTxConfirmLink"),
  recentlyFinalized:         (k: string) => convKey("xmtp", k, "recentlyFinalized"),
  pendingCopyTradeAmount:    (k: string) => convKey("xmtp", k, "pendingCopyTradeAmount"),
  pendingPerpSetupInput:     (k: string) => convKey("xmtp", k, "pendingPerpSetupInput"),
  pendingPerpInput:          (k: string) => convKey("xmtp", k, "pendingPerpInput"),
  activePerpWizard:          (k: string) => convKey("xmtp", k, "activePerpWizard"),
  pendingTpslUpdateInput:    (k: string) => convKey("xmtp", k, "pendingTpslUpdateInput"),
  activeTpslUpdateWizard:    (k: string) => convKey("xmtp", k, "activeTpslUpdateWizard"),
  pendingLaunch:             (k: string) => convKey("xmtp", k, "pendingLaunch"),
  pendingDopplerLaunch:      (k: string) => convKey("xmtp", k, "pendingDopplerLaunch"),
  pendingB20Launch:          (k: string) => convKey("xmtp", k, "pendingB20Launch"),
  lastStrategyPrompt:        (k: string) => convKey("xmtp", k, "lastStrategyPrompt"),
  lastStrategyConfig:        (k: string) => convKey("xmtp", k, "lastStrategyConfig"),
  pendingImproveFeedback:    (k: string) => convKey("xmtp", k, "pendingImproveFeedback"),
  pendingActivityAt:         (k: string) => convKey("xmtp", k, "pendingActivityAt"),
} as const;

// ── In-memory sets (module-level singletons) ──────────────────────────────────

/** Guards against double-tap on the cashout Confirm button (in-flight CDP send). */
export const pendingCashout = new Set<string>();

/** Waiting for a token symbol after tapping ✏️ Other in the yield-compare picker. */
export const pendingCustomYieldToken = new Set<string>();

/**
 * Tracks users who tapped "Prompt a Strategy" and whose next free-text message
 * is their strategy prompt (fed to the Opus authoring flow).
 * Key: inboxId:conversationId.
 */
export const pendingStrategyPrompt = new Set<string>();

/** Improve runs in-flight (key: inboxId:conversationId:strategyId) to debounce double-taps. */
export const improveInFlight = new Set<string>();

// ── Pending-interaction checker (registers global hook) ───────────────────────

registerPendingInteractionChecker(async (key) => {
  if (pendingCustomYieldToken.has(key) || pendingStrategyPrompt.has(key)) return true;
  return stateHasAny([
    XK.pendingCustomBuy(key),
    XK.pendingCustomDeposit(key),
    XK.pendingCustomPerpTopUp(key),
    XK.pendingPerpInput(key),
    XK.pendingPerpSetupInput(key),
    XK.pendingTpslUpdateInput(key),
    XK.activePerpWizard(key),
    XK.activeTpslUpdateWizard(key),
    XK.pendingLaunch(key),
    XK.pendingImproveFeedback(key),
    XK.pendingCopyTradeAmount(key),
    XK.pendingSweepXmtp(key),
  ]);
});

// ── Tx-confirm link ───────────────────────────────────────────────────────────

export async function registerPendingTxConfirmLink(
  conversationId: string,
  link: TxConfirmLink,
): Promise<void> {
  await stateSet(XK.pendingTxConfirmLink(conversationId), link);
}

// ── Pending TTL (15 min) ──────────────────────────────────────────────────────

export const PENDING_TTL_MS = 15 * 60 * 1000;

export async function touchPending(key: string): Promise<void> {
  await stateSet(XK.pendingActivityAt(key), Date.now());
}

export async function clearPendingIfExpired(key: string): Promise<boolean> {
  const at = await stateGet<number>(XK.pendingActivityAt(key));
  if (!at || Date.now() - at <= PENDING_TTL_MS) return false;
  await stateDelete(XK.pendingLaunch(key));
  await stateDelete(XK.activePerpWizard(key));
  await stateDelete(XK.activeTpslUpdateWizard(key));
  await stateDelete(XK.pendingPerpInput(key));
  await stateDelete(XK.pendingTpslUpdateInput(key));
  await stateDelete(XK.pendingCustomBuy(key));
  await stateDelete(XK.pendingCustomDeposit(key));
  await stateDelete(XK.pendingCustomPerpTopUp(key));
  pendingCustomYieldToken.delete(key);
  pendingStrategyPrompt.delete(key);
  await stateDelete(XK.pendingImproveFeedback(key));
  await stateDelete(XK.pendingCopyTradeAmount(key));
  await stateDelete(XK.pendingSweepXmtp(key));
  await stateDelete(XK.pendingActivityAt(key));
  console.log(`pending_ttl cleared all pending for ${key.slice(0, 24)}`);
  return true;
}

/** Debug: human-readable name of the first active pending slot for a key. */
export async function activePendingLabel(pendingKey: string): Promise<string> {
  if (pendingCustomYieldToken.has(pendingKey)) return "custom_yield_token";
  if (pendingStrategyPrompt.has(pendingKey)) return "strategy_prompt";
  if (await stateHas(XK.pendingLaunch(pendingKey))) return "launch";
  if (await stateHas(XK.activePerpWizard(pendingKey))) return "perp";
  if (await stateHas(XK.activeTpslUpdateWizard(pendingKey))) return "tpsl_wizard";
  if (await stateHas(XK.pendingPerpInput(pendingKey))) return "perp_input";
  if (await stateHas(XK.pendingTpslUpdateInput(pendingKey))) return "tpsl_input";
  if (await stateHas(XK.pendingCustomBuy(pendingKey))) return "custom_buy";
  if (await stateHas(XK.pendingCustomDeposit(pendingKey))) return "custom_deposit";
  if (await stateHas(XK.pendingCustomPerpTopUp(pendingKey))) return "perp_topup";
  if (await stateHas(XK.pendingImproveFeedback(pendingKey))) return "improve_feedback";
  if (await stateHas(XK.pendingCopyTradeAmount(pendingKey))) return "copy_trade_amount";
  if (await stateHas(XK.pendingSweepXmtp(pendingKey))) return "sweep";
  return "none";
}

// Re-export pendingUserKey so handlers can import everything from one place.
export { pendingUserKey };
