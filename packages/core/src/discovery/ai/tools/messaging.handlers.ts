/**
 * messaging.handlers — iMessage / WhatsApp tool handlers that wrap
 * platform-specific capabilities: price alerts, contact listing, and
 * portfolio-review scheduling.
 *
 * These tools let DiscoveryAI handle capabilities that previously lived only
 * in handler.ts Tier-3 branches, completing the LLM-first routing migration.
 *
 * Exported surface:
 *   price_alert_create       — create a new price or market-cap alert
 *   price_alert_list         — list all active alerts for the user
 *   price_alert_cancel       — cancel one or all alerts
 *   contact_list             — list the user's saved contacts
 *   schedule_portfolio_review — enable/disable/show daily portfolio review
 */

import type { AlertDirection, AlertMetric } from "@/price-alerts/types.js";
import type { AlertPlatform } from "@/discovery/adapters/priceAlert.adapter.js";
import { PriceAlertAdapter } from "@/discovery/adapters/priceAlert.adapter.js";
import { ContactsAdapter } from "@/messaging/contacts.adapter.js";
import {
  createAlertFromIntent,
  type FinalizeAlertInput,
} from "@/price-alerts/index.js";
import { handlePortfolioReviewCommand } from "@/portfolio-reviews/commands.js";
import { stripMarkdown } from "@/imessage/outbound.js";
import type { RespondCtx, ToolResult } from "@/discovery/ai/toolbox.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

function resolveAlertPlatform(ctx: RespondCtx): AlertPlatform {
  if (ctx.copyPlatform === "whatsapp") return "whatsapp";
  if (ctx.copyPlatform === "telegram") return "telegram";
  if (ctx.copyPlatform === "imessage") return "imessage";
  return "xmtp";
}

function buildAlertCore(ctx: RespondCtx): FinalizeAlertInput {
  const platform = resolveAlertPlatform(ctx);
  const dmTarget: Record<string, unknown> =
    platform === "whatsapp"
      ? { to: ctx.inboxId }
      : platform === "imessage"
        ? { spaceId: ctx.inboxId }
        : { inboxId: ctx.inboxId };
  return {
    platform,
    userKey: ctx.inboxId,
    dmTarget,
    sourceConversationId: ctx.inboxId,
    sourceIsGroup: false,
  };
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

export async function price_alert_create(
  ctx: RespondCtx,
  args: {
    token: string;
    targetValue: number;
    direction: "above" | "below";
    metric?: "price_usd" | "market_cap_usd";
  },
): Promise<ToolResult> {
  const intent = {
    tokenQuery: args.token,
    contractAddress: null,
    direction: args.direction as AlertDirection,
    targetValue: args.targetValue,
    metric: (args.metric ?? "price_usd") as AlertMetric,
  };

  const result = await createAlertFromIntent(buildAlertCore(ctx), intent);

  const text =
    result.kind === "created"
      ? `alert #${result.alertId}: ${result.reply}`
      : "reply" in result
        ? result.reply
        : "something went wrong setting that alert.";

  return {
    data: { result },
    control: { type: "text", text: stripMarkdown(text) },
  };
}

export async function price_alert_list(ctx: RespondCtx): Promise<ToolResult> {
  const platform = resolveAlertPlatform(ctx);
  const alerts = await PriceAlertAdapter.listActiveForUser(platform, ctx.inboxId);

  if (alerts.length === 0) {
    return {
      data: { alerts: [] },
      control: { type: "text", text: "you have no active price alerts." },
    };
  }

  const text = [
    "your active price alerts:",
    ...alerts.map((a) => {
      const label = a.metric === "market_cap_usd" ? "MC" : "price";
      return `#${a.id}: ${a.symbol} ${label} ${a.direction} $${Number(a.target_value)}`;
    }),
  ].join("\n");

  return {
    data: { alerts },
    control: { type: "text", text },
  };
}

export async function price_alert_cancel(
  ctx: RespondCtx,
  args: { alertId?: number },
): Promise<ToolResult> {
  const platform = resolveAlertPlatform(ctx);
  let count = 0;

  if (args.alertId) {
    count = await PriceAlertAdapter.cancelForUser(platform, ctx.inboxId, args.alertId);
  } else {
    count = await PriceAlertAdapter.cancelForUser(platform, ctx.inboxId);
  }

  const text =
    count > 0
      ? `cancelled ${count} alert${count === 1 ? "" : "s"}.`
      : "no matching active alert to cancel.";

  return {
    data: { count },
    control: { type: "text", text },
  };
}

export async function contact_list(ctx: RespondCtx): Promise<ToolResult> {
  const contacts = await ContactsAdapter.listContacts(ctx.inboxId);

  if (contacts.length === 0) {
    return {
      data: { contacts: [] },
      control: {
        type: "text",
        text: 'you have no saved contacts yet. save one by sending "Name: +63 917 123 4567" or sharing a contact card.',
      },
    };
  }

  const text = [
    `your saved contacts (${contacts.length}):`,
    ...contacts.map((c) => {
      const contactPhone = c.contact_phone ?? c.contact;
      const phone = contactPhone ? ` — ${contactPhone}` : "";
      return `• ${c.name}${phone}`;
    }),
  ].join("\n");

  return {
    data: { contacts: contacts.map((c) => c.name) },
    control: { type: "text", text },
  };
}

export async function schedule_portfolio_review(
  ctx: RespondCtx,
): Promise<ToolResult> {
  const platform = ctx.copyPlatform === "whatsapp" ? "whatsapp" : "imessage";
  const dmTarget: Record<string, unknown> =
    platform === "whatsapp" ? { to: ctx.inboxId } : { spaceId: ctx.inboxId };

  const result = await handlePortfolioReviewCommand({
    platform,
    userKey: ctx.inboxId,
    text: ctx.userMessage ?? "",
    walletAddress: ctx.walletAddress,
    dmTarget,
  });

  if (!result.handled) {
    return {
      data: { handled: false },
      control: {
        type: "text",
        text: 'to set up a daily portfolio review, say something like: "portfolio review every day at 8am America/New_York"',
      },
    };
  }

  return {
    data: { handled: true },
    control: { type: "text", text: stripMarkdown(result.reply) },
  };
}
