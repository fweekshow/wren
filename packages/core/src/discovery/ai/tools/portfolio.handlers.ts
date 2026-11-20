/**
 * portfolio.handlers — get_portfolio_summary, get_staking_summary and
 * shared portfolio helpers used across the Toolbox.
 *
 * Extracted from toolbox.ts (private helpers + methods at lines ~1039-1096).
 *
 * Exported surface:
 *   portfolioUserKey        — resolves the per-platform user key for portfolio lookups
 *   buildChannelPortfolio   — fetches the right portfolio payload for the current platform
 *   get_portfolio_summary   — returns coin balances as a text control
 *   get_staking_summary     — returns staking summary as a text control
 */

import { tryBuildSignedPortfolioUrl } from "@/portfolio/access.js";
import {
  buildImessagePortfolio,
  buildXmtpPortfolio,
} from "@/portfolio/service.js";
import type { ImessagePortfolioPayload } from "@/portfolio/types.js";
import {
  formatCoinsSummaryForImessage,
  formatStakingSummaryForImessage,
} from "@/portfolio/summary.js";
import type { RespondCtx, ToolResult } from "@/discovery/ai/toolbox.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Resolves the per-platform user key for portfolio lookups.
 * Returns `null` when no portfolio should be shown in the current context.
 */
export function portfolioUserKey(ctx: RespondCtx): string | null {
  if (ctx.copyPlatform === "xmtp") return ctx.inboxId;
  if (
    ctx.custodialWallet &&
    (ctx.copyPlatform === "imessage" || ctx.copyPlatform === "whatsapp")
  ) {
    return ctx.copyUserKey ?? ctx.inboxId;
  }
  return null;
}

/** Fetches the right portfolio payload for the current platform / user key. */
export async function buildChannelPortfolio(
  ctx: RespondCtx,
): Promise<ImessagePortfolioPayload | null> {
  const userKey = portfolioUserKey(ctx);
  if (!userKey) return null;
  return ctx.copyPlatform === "xmtp"
    ? buildXmtpPortfolio(userKey, ctx.walletAddress)
    : buildImessagePortfolio(userKey);
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

export async function get_portfolio_summary(ctx: RespondCtx): Promise<ToolResult | null> {
  const userKey = portfolioUserKey(ctx);
  if (!userKey) return null;
  try {
    const portfolio = await buildChannelPortfolio(ctx);
    if (!portfolio) return null;
    return {
      data: { portfolioSummary: true },
      control: {
        type: "text",
        text: formatCoinsSummaryForImessage(portfolio),
        portfolioViewUrl: tryBuildSignedPortfolioUrl(userKey) ?? undefined,
      },
    };
  } catch (err) {
    console.warn("⚠️ portfolio balance summary failed:", err);
    return null;
  }
}

export async function get_staking_summary(ctx: RespondCtx): Promise<ToolResult | null> {
  const userKey = portfolioUserKey(ctx);
  if (!userKey) return null;
  try {
    const portfolio = await buildChannelPortfolio(ctx);
    if (!portfolio) return null;
    return {
      data: { portfolioSummary: true, staking: portfolio.staking.length },
      control: {
        type: "text",
        text: formatStakingSummaryForImessage(portfolio),
        portfolioViewUrl: tryBuildSignedPortfolioUrl(userKey) ?? undefined,
      },
    };
  } catch (err) {
    console.warn("⚠️ portfolio staking summary failed:", err);
    return null;
  }
}
