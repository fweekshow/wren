import {
  PriceAlertAdapter,
  type AlertPlatform,
} from "@/discovery/adapters/priceAlert.adapter.js";

import { inferDirection, valueForMetric } from "./comparison.js";
import { formatAmbiguous, formatConfirmation } from "./format.js";
import { parseAlertIntent } from "./parser.js";
import { resolveAlertToken, type ResolveOptions } from "./tokenResolver.js";
import type { ParsedAlertIntent } from "./types.js";

/** Everything needed to finalize an alert except the parsed request itself. */
export interface FinalizeAlertInput {
  platform: AlertPlatform;
  /** Stable per-platform user id (XMTP inbox id, Telegram user id, iMessage sender id). */
  userKey: string;
  /** Platform-specific DM routing info, stored as JSON. Null if not yet known. */
  dmTarget: Record<string, unknown> | null;
  sourceConversationId: string | null;
  sourceIsGroup: boolean;
  /** Optional fetch override for tests. */
  resolveOptions?: ResolveOptions;
}

export interface SetupAlertInput extends FinalizeAlertInput {
  text: string;
}

export type SetupAlertResult =
  | { kind: "not_an_alert" }
  | { kind: "created"; reply: string; alertId: number }
  | { kind: "ambiguous"; reply: string }
  | { kind: "unresolved"; reply: string }
  | { kind: "unpriced"; reply: string }
  | { kind: "needs_dm_target"; reply: string };

/**
 * Parse, resolve, persist, and confirm a one-time price alert from free text.
 * Returns a discriminated result so each platform can render the reply (and,
 * for groups, redirect delivery to the user's DM).
 */
export async function setupAlertFromText(
  input: SetupAlertInput,
): Promise<SetupAlertResult> {
  const intent = parseAlertIntent(input.text);
  if (!intent) return { kind: "not_an_alert" };
  return createAlertFromIntent(input, intent);
}

/**
 * Resolve, persist, and confirm an alert from an already-parsed intent. Used
 * both for the initial request and to complete a request once the user supplies
 * a disambiguating contract address.
 */
export async function createAlertFromIntent(
  input: FinalizeAlertInput,
  intent: ParsedAlertIntent,
): Promise<SetupAlertResult> {
  const resolution = await resolveAlertToken(
    intent.tokenQuery,
    intent.contractAddress,
    input.resolveOptions,
  );

  if (resolution.kind === "not_found") {
    return {
      kind: "unresolved",
      reply: `I couldn't find a token for "${intent.tokenQuery}". Try a different symbol or send the contract address.`,
    };
  }

  if (resolution.kind === "ambiguous") {
    return {
      kind: "ambiguous",
      reply: formatAmbiguous(intent.tokenQuery, resolution.candidates),
    };
  }

  if (resolution.kind === "unpriced") {
    return {
      kind: "unpriced",
      reply: `I can't read a live price for ${resolution.token.symbol} right now. Try again in a moment, or send the contract address.`,
    };
  }

  const { token, quote } = resolution;
  const currentValue = valueForMetric(quote, intent.metric);
  if (currentValue === null) {
    const label = intent.metric === "market_cap_usd" ? "market cap" : "price";
    return {
      kind: "unpriced",
      reply: `I can't read a live ${label} for ${token.symbol} right now. Try again in a moment, or send the contract address.`,
    };
  }

  // DM-only delivery: if we don't yet know where to DM the user, tell them.
  if (!input.dmTarget) {
    return {
      kind: "needs_dm_target",
      reply: "DM me directly first so I can send your price alert privately.",
    };
  }

  const direction =
    intent.direction ?? inferDirection(currentValue, intent.targetValue);

  const row = await PriceAlertAdapter.insert({
    platform: input.platform,
    userKey: input.userKey,
    dmTarget: input.dmTarget,
    sourceConversationId: input.sourceConversationId,
    sourceIsGroup: input.sourceIsGroup,
    tokenSource: token.source,
    tokenId: token.tokenId,
    tokenAddress: token.tokenAddress,
    chainId: token.chainId,
    symbol: token.symbol,
    name: token.name,
    metric: intent.metric,
    targetValue: intent.targetValue,
    direction,
    currentValueAtCreate: currentValue,
  });

  return {
    kind: "created",
    alertId: row.id,
    reply: formatConfirmation({
      symbol: token.symbol,
      metric: intent.metric,
      direction,
      targetValue: intent.targetValue,
      currentValue,
      isGroup: input.sourceIsGroup,
    }),
  };
}
