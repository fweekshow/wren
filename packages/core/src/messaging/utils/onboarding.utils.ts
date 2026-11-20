import { type AIResponse } from "@/discovery/ai.js";

// ── Text classification helpers ───────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function looksLikeEmail(text: string): boolean {
  return EMAIL_RE.test(text.trim());
}

/**
 * Returns the parsed dollar amount if the text is clearly a wallet fund intent,
 * or undefined if it isn't. Handles patterns like:
 *   "add $25", "add 25", "fund $50", "fund my wallet", "add funds", "top up $100", "onramp $10"
 * Returns "0" for "add funds" / "top up" with no amount (triggers preset menu).
 */
export function isFundIntent(text: string): string | undefined {
  const t = text.trim().toLowerCase();

  const withAmount = /(?:^|\b)(?:add|fund|deposit|top[\s-]?up|put in|load)\s+\$?\s*([0-9][\d,]*(?:\.\d+)?)\b/i.exec(text);
  if (withAmount) {
    const n = Number(withAmount[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return String(n);
  }

  const onrampAmount = /\b(?:on\s*ramp|onramp)\b.*?\$?\s*([0-9][\d,]*(?:\.\d+)?)\b/i.exec(text);
  if (onrampAmount) {
    const n = Number(onrampAmount[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return String(n);
  }

  const dollarFirst = /^\$([0-9][\d,]*(?:\.\d+)?)\s+(?:to\s+(?:my\s+)?(?:wallet|account))/i.exec(text);
  if (dollarFirst) {
    const n = Number(dollarFirst[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return String(n);
  }

  if (/^(?:add\s+funds?|fund\s+(?:my\s+)?(?:wallet|account)|top[\s-]?up|load\s+(?:my\s+)?wallet|deposit\s+(?:funds?|money)|on\s*ramp|onramp)$/i.test(t)) {
    return "0";
  }

  return undefined;
}

export function isRampIntent(text: string): boolean {
  const normalized = text.toLowerCase().replaceAll("-", " ");
  if (/\b(?:on\s*ramp|onramp|off\s*ramp|offramp)\b/.test(normalized)) return true;
  if (/\b(?:buy\s+crypto|sell\s+(?:crypto|usdc|eth|weth|token|tokens)\s+(?:for|to)\s+fiat|convert\s+(?:to\s+)?cash)\b/.test(normalized)) {
    return true;
  }
  if (/\b(?:cash\s*out|cashout|withdraw\s+to\s+(?:my\s+)?bank|send\s+to\s+(?:my\s+)?bank)\b/.test(normalized)) {
    return true;
  }
  if (/\b(?:apple\s*pay|card|debit|credit|bank)\b/.test(normalized) && /\b(?:buy|fund|add|top\s*up|deposit|load|cash\s*out|sell)\b/.test(normalized)) {
    return true;
  }
  return isFundIntent(text) !== undefined;
}

export function rampComingSoonText(): string {
  return "onramp and offramp are coming soon - and they're going to make moving money in and out of basemate feel effortless. you're early, this is one of the next big pieces we're excited to ship, and it's going to be worth the wait.";
}

export function looksLikeOtp(text: string): boolean {
  return /^\d{6}$/.test(text.trim());
}

export function displayNamePrompt(): string {
  return 'Before we get started, what should I call you? Reply with your name, or "skip" for now.';
}

export function parseDisplayName(text: string): string | null {
  const name = text.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 50) return null;
  if (
    /^(?:0x[a-f0-9]+|\+?\d[\d\s()-]+)$/i.test(name) ||
    /\b(?:send|swap|buy|sell|fund|deposit|withdraw|balance|portfolio|trade|bet|connect|wallet)\b/i.test(name)
  ) {
    return null;
  }
  return /^[\p{L}\p{M}][\p{L}\p{M}\p{N} .'-]*$/u.test(name) ? name : null;
}

export function isCasualConversationText(text: string): boolean {
  return /^(?:hi+|hello+|hey+|yo+|gm|good morning|sup|what'?s up|how are you|thanks?|thank you|ok(?:ay)?|cool|nice|bet|lol|lmao|haha+)[!.?\s]*$/i.test(
    text.trim(),
  );
}

// ── One-time notes ────────────────────────────────────────────────────────────

/** One-time note after linking; iMessage transactions default to the managed wallet. */
// ── Intent routing helpers ────────────────────────────────────────────────────

// LLM-first routing: DiscoveryAI is the default handler, not the exception.
// The Tier-1 state machines above handle stateful flows (OTP, pending confirms,
// account link steps). Everything else — including intents not caught by any
// Tier-3 handler — goes to the LLM. No dead-ends.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function shouldRouteToGeneralAi(_action: string): boolean {
  return true;
}

export function requiresWalletBeforeGeneralAi(action: string): boolean {
  return new Set([
    "main_wallet_balance",
    "main_wallet_fund",
    "main_wallet_transfer",
    "main_wallet_offramp",
    "swap",
    "yield",
  ]).has(action);
}

export function isBalanceFastPathIntent(text: string): boolean {
  const normalized = text.toLowerCase();
  return /\b(show|check|view|see|what'?s|whats|what is|how much)\b/.test(normalized) &&
    /\b(balance|balances|portfolio|wallet|holdings)\b/.test(normalized);
}

// ── Portfolio empty-state checks ──────────────────────────────────────────────

export function isEmptyPortfolioSummaryText(text: string): boolean {
  return text.includes("Your portfolio is about $0.0000") &&
    text.includes("No tracked Base coin balances yet");
}

export function isEmptyPortfolioSummaryResponse(resp: AIResponse): boolean {
  return "text" in resp &&
    typeof resp.text === "string" &&
    isEmptyPortfolioSummaryText(resp.text);
}

// ── Onboarding copy ───────────────────────────────────────────────────────────

export function walletOnboardingEmailPrompt(): string {
  return [
    "One more thing — to enable Apple Pay funding I need your email address.",
    "",
    "By continuing you agree to Coinbase's Guest Checkout Terms of Service (pay.coinbase.com/legal).",
    "",
    "Reply with your email, or \"skip\" to fund via crypto transfer only.",
  ].join("\n");
}
