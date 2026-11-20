import {
  isAvantisPnlCardIntent,
  isAvantisPositionsIntent,
  parseSimpleUsdBuy,
} from "@/discovery/ai.js";

export type PendingWizardKind = "launch_name" | "launch_symbol" | "perp_token";

const QUESTION_RE =
  /\?|(?:^|\s)(?:what|how|why|where|when|who|can you|could you|show me|help|instead|wait|never mind|nevermind)\b/i;

const ACTION_PIVOT_RE =
  /\b(swap|trade|buy|sell|send|transfer|deposit|supply|earn|yield|launch|deploy|perp|perps|leverage|long|short|positions?|support|bug|broken|not working)\b/i;

function hasIntentSignals(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (QUESTION_RE.test(t)) return true;
  if (parseSimpleUsdBuy(t)) return true;
  if (isAvantisPnlCardIntent(t) || isAvantisPositionsIntent(t)) return true;
  if (ACTION_PIVOT_RE.test(t)) return true;
  return false;
}

function isValidLaunchName(text: string): boolean {
  const t = text.trim();
  return t.length >= 2 && t.length <= 50;
}

function isValidLaunchSymbol(text: string): boolean {
  const sym = text
    .trim()
    .replace(/^\$/, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
  return sym.length >= 2 && sym.length <= 10;
}

/** True when typed text looks like a new question/intent, not wizard field input. */
export function shouldAbandonPendingWizard(
  text: string,
  kind: PendingWizardKind,
): boolean {
  const trimmed = text.trim().replace(/^(?:@\S+\s+)+/i, "").trim();
  if (!trimmed || !hasIntentSignals(trimmed)) return false;

  if (kind === "launch_name") {
    if (!hasIntentSignals(trimmed)) return false;
    if (QUESTION_RE.test(trimmed)) return true;
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    if (wordCount > 4) return true;
    if (!isValidLaunchName(trimmed)) return true;
    return false;
  }

  if (kind === "launch_symbol") {
    if (isValidLaunchSymbol(trimmed)) return false;
    return true;
  }

  // perp_token — caller checks extractPerpMarketSymbol first
  return true;
}
