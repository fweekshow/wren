import { sanitizeAmount } from "@basemate/shared";

import { type AIResponse } from "@/discovery/ai.js";
import { appLink } from "@/discovery/ai/appLinks.js";
import {
  GasEstimationError,
  getBalances,
  InsufficientGasError,
  sendCalls,
  type TokenBalance,
} from "@/wallet/cdp.js";
import { buildImessagePortfolio } from "@/portfolio/service.js";
import { formatCoinsSummaryForImessage } from "@/portfolio/summary.js";
import type { ImessagePortfolioPayload } from "@/portfolio/types.js";
import { fetchTraderHoldings } from "@/copy-trading/portfolio/balances.js";
import { confettiTextOutbound, type ImessageOutbound } from "@/imessage/outbound.js";
import type {
  PendingAmountChoice,
  PendingTrade,
  PendingYieldChoice,
} from "../handler.types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const BASE_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Pending trades older than this are treated as stale and discarded. */
export const PENDING_TRADE_TTL_MS = 5 * 60 * 1000;
export const PENDING_OTP_TTL_MS = 10 * 60 * 1000;
export const MIN_VISIBLE_BALANCE_USD = 0.01;

// ── Balance utilities ─────────────────────────────────────────────────────────

export function trimBalanceAmount(value: string): string {
  return value.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}

export function normalizeConnectedWalletAddress(address?: string | null): string | null {
  const trimmed = address?.trim();
  if (!trimmed || !BASE_ADDRESS_RE.test(trimmed)) return null;
  if (trimmed.toLowerCase() === ZERO_ADDRESS) return null;
  return trimmed;
}

export async function walletBalanceLines(walletAddress: string): Promise<string> {
  const holdings = (await fetchTraderHoldings(walletAddress, {
    minValueUsd: MIN_VISIBLE_BALANCE_USD,
  })).filter(
    (holding) =>
      holding.valueUsd >= MIN_VISIBLE_BALANCE_USD ||
      (holding.priceUsd === null && Number(holding.amount) > 0),
  );
  return holdings.length > 0
    ? holdings.map((holding) => `• ${trimBalanceAmount(holding.amount)} ${holding.symbol}`).join("\n")
    : "• 0 USDC";
}

export async function mainWalletInfoText(
  senderId: string,
  walletAddress: string,
): Promise<ImessageOutbound[] | null> {
  if (!walletAddress) {
    return ["i don't have a Basemate wallet connected for you yet."];
  }

  try {
    const portfolio = await buildImessagePortfolio(senderId);
    if (portfolio && !isEmptyPortfolio(portfolio)) {
      return [
        formatCoinsSummaryForImessage(portfolio),
        walletAddress,
        appLink("home"),
      ];
    }
  } catch (err) {
    console.error("⚠️ [iMessage] portfolio summary lookup failed:", err);
  }

  let balanceLines: string;
  try {
    balanceLines = await walletBalanceLines(walletAddress);
  } catch (err) {
    console.error("⚠️ [iMessage] wallet balance lookup failed:", err);
    balanceLines = "couldn't fetch balances right now.";
  }

  return [
    [
      "here's your Basemate wallet:",
      "",
      balanceLines,
      "",
      "your Base address is in the next message so it's easy to copy.",
    ].join("\n"),
    walletAddress,
  ];
}

export function isEmptyPortfolio(portfolio: ImessagePortfolioPayload): boolean {
  return portfolio.totals.totalUsd <= 0 &&
    portfolio.coins.length === 0 &&
    portfolio.perpetuals.length === 0 &&
    portfolio.staking.length === 0;
}

// ── Asset / swap text parsing ─────────────────────────────────────────────────

export function hasFullBalancePhrase(text: string): boolean {
  return /\b(all|whole|entire|max|maximum)\b/i.test(text);
}

export function normalizeAssetText(asset: string): string {
  return asset.trim().replace(/^\$/, "").toUpperCase();
}

export function extractBalanceAssetMention(text: string): string | null {
  const cleaned = text.trim();
  const ticker = "\\$?([A-Za-z][A-Za-z0-9]{1,30})";
  const patterns = [
    new RegExp(`\\bhow\\s+much\\s+${ticker}\\b`, "i"),
    new RegExp(`\\b${ticker}\\s+(?:balance|do\\s+i\\s+have|have)\\b`, "i"),
  ];
  const ignored = new Set(["MUCH", "BALANCE", "WALLET", "PORTFOLIO"]);
  for (const pattern of patterns) {
    const match = pattern.exec(cleaned);
    const asset = match?.[1] ? normalizeAssetText(match[1]) : "";
    if (asset && !ignored.has(asset)) return asset;
  }
  return null;
}

export function parseSwapDraft(
  text: string,
  fallbackFromAsset?: string,
): { fromAsset: string; toAsset: string; createdAt: number } | null {
  const cleaned = text.replace(/→/g, "->").trim();
  const address = "0x[a-fA-F0-9]{40}";
  const ticker = "\\$?[A-Za-z][A-Za-z0-9]{1,30}";
  const asset = `(${address}|${ticker})`;
  const amountPrefix = "(?:(?:all|whole|entire|max|maximum)\\s+)?(?:my\\s+)?(?:the\\s+)?(?:wallet\\s+)?(?:balance\\s+)?(?:of\\s+)?";
  const patterns = [
    new RegExp(`\\b(?:swap|convert)\\s+${amountPrefix}${asset}\\s+(?:to|for|into|->)\\s+${asset}\\b`, "i"),
    new RegExp(`\\bsell\\s+${amountPrefix}${asset}\\s+(?:to|for|into|->)\\s+${asset}\\b`, "i"),
    new RegExp(`\\b(?:swap|convert|sell)\\s+(?:my\\s+)?(?:whole|entire|max|maximum|all)\\s+${asset}\\s+balance\\s+(?:to|for|into|->)\\s+${asset}\\b`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(cleaned);
    if (match?.[1] && match[2]) {
      return {
        fromAsset: normalizeAssetText(match[1]),
        toAsset: normalizeAssetText(match[2]),
        createdAt: Date.now(),
      };
    }
  }
  if (fallbackFromAsset) {
    const pronounPatterns = [
      new RegExp(`\\b(?:swap|convert|sell)\\s+(?:it\\s+)?(?:all|whole|entire|max|maximum)\\s+(?:to|for|into|->)\\s+${asset}\\b`, "i"),
      new RegExp(`\\b(?:swap|convert|sell)\\s+it\\s+(?:to|for|into|->)\\s+${asset}\\b`, "i"),
    ];
    for (const pattern of pronounPatterns) {
      const match = pattern.exec(cleaned);
      if (match?.[1]) {
        return {
          fromAsset: normalizeAssetText(fallbackFromAsset),
          toAsset: normalizeAssetText(match[1]),
          createdAt: Date.now(),
        };
      }
    }
  }
  return null;
}

// ── Token / balance matching ──────────────────────────────────────────────────

export function balanceMatchesAsset(balance: TokenBalance, asset: string): boolean {
  const normalized = normalizeAssetText(asset);
  if (balance.symbol.toUpperCase() === normalized) return true;
  if (/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
    return balance.contractAddress.toLowerCase() === normalized.toLowerCase();
  }
  if (normalized === "ETH") {
    return balance.contractAddress.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  }
  return false;
}

export async function findWalletBalance(address: string, asset: string): Promise<TokenBalance | null> {
  const balances = await getBalances(address);
  const balance = balances.find((item) => balanceMatchesAsset(item, asset));
  const numeric = Number(balance?.formatted ?? "0");
  return balance && Number.isFinite(numeric) && numeric > 0 ? balance : null;
}

// ── Amount parsing ────────────────────────────────────────────────────────────

export function isAmountPromptResponse(resp: AIResponse): boolean {
  return resp.type === "text" && /what amount should i swap/i.test(resp.text);
}

export function parseNumberText(text: string): string | undefined {
  const match = text.trim().replace(/^\$/, "").match(/^([0-9][\d,]*(?:\.\d+)?)/);
  return match ? sanitizeAmount(match[1].replace(/,/g, "")) ?? undefined : undefined;
}

export function parseChoiceIndex(text: string): number | null {
  const match = text.trim().match(/^#?([1-9]|10)$/);
  return match ? Number(match[1]) - 1 : null;
}

/** Preset menu selection during amount_select — requires a # prefix so "3" means $3, not option 3. */
export function parsePresetChoiceIndex(text: string, presetCount: number): number | null {
  const match = text.trim().match(/^#([1-9]|10)$/);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return index >= 0 && index < presetCount ? index : null;
}

/** Bare amount the user typed during amount_select (e.g. "3", "$3", "3 usdc"). */
export function parseCustomDepositAmountUsd(text: string): number | null {
  const trimmed = text.trim();
  const dollar = /^\$\s*([0-9][\d,]*(?:\.\d+)?)\s*$/i.exec(trimmed);
  if (dollar) {
    const n = Number(dollar[1].replace(/,/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const usdSuffix = /^([0-9][\d,]*(?:\.\d+)?)\s*(?:usdc|usd|dollars?)\s*$/i.exec(trimmed);
  if (usdSuffix) {
    const n = Number(usdSuffix[1].replace(/,/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const bare = /^([0-9][\d,]*(?:\.\d+)?)\s*$/.exec(trimmed);
  if (bare) {
    const n = Number(bare[1].replace(/,/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

// ── Yield / amount choice messages ───────────────────────────────────────────

export function explicitYieldMessage(
  choice: PendingYieldChoice,
  option: PendingYieldChoice["options"][number],
): string {
  const amtPrefix = choice.amountToken ? `${choice.amountToken} ` : "";
  if (option.protocol === "moonwell") return `supply ${amtPrefix}${choice.token} on moonwell`;
  if (option.protocol === "morpho") return `deposit ${amtPrefix}${choice.token} to morpho`;
  if (option.protocol === "aave") return `supply ${amtPrefix}${choice.token} on aave`;
  return `add ${amtPrefix}${choice.token} liquidity on aerodrome`;
}

export function explicitPresetAmountMessage(choice: PendingAmountChoice, usd: number): string {
  if (choice.protocol === "moonwell") return `supply $${usd} of ${choice.asset} on moonwell`;
  if (choice.protocol === "morpho") return `deposit $${usd} of ${choice.asset} on morpho`;
  return `supply $${usd} of ${choice.asset} on aave`;
}

// ── Trade execution ───────────────────────────────────────────────────────────

/** Transaction confirmation link — basemate.app/txn/ redirects to BaseScan. */
export function basemateTxUrl(hash: string): string {
  return `https://app.basemate.app/txn/${hash}`;
}

/** Direct Base mainnet transaction explorer link. */
export function basescanTxUrl(hash: string): string {
  return `https://basescan.org/tx/${hash}`;
}

/**
 * Chat confirmations point users to the app's Activity tab instead of pasting a
 * raw explorer link on every transaction (Basescan stays the source of truth,
 * reachable from the app). Plain text, no URL, to avoid link spam in chat.
 */
export const APP_ACTIVITY_HINT = "view your activity in the app";

/**
 * Structured plain-text iMessage receipt. iMessage renders no markdown, so the
 * only formatting levers are line breaks and spacing: an emoji title, an
 * optional block of labeled detail lines, and an optional footer hint — each
 * separated by a blank line so the bubble reads as distinct sections.
 */
export function formatReceipt(opts: {
  title: string;
  lines?: Array<string | null | undefined>;
  footer?: string | null;
}): string {
  const blocks: string[] = [opts.title];
  const detail = (opts.lines ?? []).filter((l): l is string => Boolean(l));
  if (detail.length) blocks.push(detail.join("\n"));
  if (opts.footer) blocks.push(opts.footer);
  return blocks.join("\n\n");
}

export async function executePendingTrade(pending: PendingTrade): Promise<ImessageOutbound[]> {
  try {
    const batches = pending.batches ?? [{
      accountName: pending.accountName!,
      label: pending.label,
      calls: pending.calls ?? [],
    }];
    const hashes: string[] = [];
    for (const batch of batches) {
      const result = await sendCalls({
        accountName: batch.accountName,
        calls: batch.calls,
      });
      hashes.push(...result.hashes);
    }
    const txHash = hashes[hashes.length - 1] ?? hashes[0];
    const messages: ImessageOutbound[] = [confettiTextOutbound(`done — ${pending.label} submitted.`)];
    if (txHash) messages.push(basemateTxUrl(txHash));
    return messages;
  } catch (err) {
    if (err instanceof InsufficientGasError) {
      return [
        "i couldn't place that — your wallet has no ETH for gas. send a little ETH on Base to your address, then ask me to rebuild the trade.",
      ];
    }
    if (err instanceof GasEstimationError) {
      console.error("⚠️ [iMessage] trade gas estimation failed:", err);
      return [
        "i couldn't submit that — the transaction simulation failed before broadcast. this usually means the quoted amount or route is stale, or the wallet no longer has enough of the input token. ask me to rebuild it with your current balance.",
      ];
    }
    console.error("⚠️ [iMessage] trade execution failed:", err);
    return ["couldn't submit that onchain — try again in a moment."];
  }
}
