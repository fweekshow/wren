import type { AlertDirection, AlertMetric, ParsedAlertIntent } from "./types.js";

const CONTRACT_RE = /0x[a-fA-F0-9]{40}/;
const DOLLAR_TICKER_RE = /\$([a-zA-Z][a-zA-Z0-9]{1,15})/;

/** Pull a contract address out of free text (e.g. a follow-up "0x… this one"). */
export function extractContractAddress(text: string): string | null {
  return text.match(CONTRACT_RE)?.[0] ?? null;
}

/** Words that signal the user wants an alert created. */
const ALERT_INTENT_RE =
  /\b(price\s*alert|set\s+an?\s+alert|alert\s+me|alert|notify|let\s+me\s+know|ping\s+me|tell\s+me\s+when|watch|track)\b/i;

const ABOVE_RE =
  /\b(above|over|greater(?:\s+than)?|more\s+than|exceeds?|moons?|pumps?|breaks?\s+(?:above|over))\b|>=?/i;
const BELOW_RE =
  /\b(below|under|less(?:\s+than)?|dips?|drops?|falls?|breaks?\s+(?:below|under))\b|<=?/i;

const MARKET_CAP_RE = /\b(market\s*cap|mcap|mc|fdv)\b/i;

/** Keywords that introduce the numeric target (so we can pick the right number). */
const TARGET_LEAD_RE =
  /\b(?:at|to|hits?|reach(?:es|ed)?|cross(?:es|ed)?|above|over|below|under|=)\b/i;

/** Numbers like 1,700 / 0.05 / 1M / 1.5k / 2 billion. */
const VALUE_RE =
  /(\d[\d,]*(?:\.\d+)?)\s*(k|m|mm|b|t|thousand|million|billion|trillion)?/gi;

const SUFFIX_MULTIPLIER: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mm: 1e6,
  million: 1e6,
  b: 1e9,
  billion: 1e9,
  t: 1e12,
  trillion: 1e12,
};

const SYMBOL_STOP_WORDS = new Set(
  [
    "price",
    "alert",
    "alerts",
    "me",
    "when",
    "hit",
    "hits",
    "reach",
    "reaches",
    "set",
    "a",
    "an",
    "the",
    "for",
    "on",
    "of",
    "at",
    "to",
    "above",
    "below",
    "over",
    "under",
    "goes",
    "go",
    "cross",
    "crosses",
    "drop",
    "drops",
    "dips",
    "dip",
    "notify",
    "let",
    "know",
    "ping",
    "tell",
    "watch",
    "track",
    "mc",
    "mcap",
    "market",
    "cap",
    "fdv",
    "usd",
    "usdc",
    "and",
    "is",
    "it",
    "if",
    "my",
  ].map((w) => w.toUpperCase()),
);

const LEADING_CHATTER_RE = /^(?:yo|hey|hi|hello|gm|gn|please)[\s,!.:-]+/i;

interface ValueMatch {
  value: number;
  index: number;
  end: number;
  hadSuffix: boolean;
  hadDollar: boolean;
}

function collectValues(text: string): ValueMatch[] {
  const out: ValueMatch[] = [];
  VALUE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VALUE_RE.exec(text)) !== null) {
    const numeric = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(numeric)) continue;
    const suffix = m[2]?.toLowerCase();
    const multiplier = suffix ? (SUFFIX_MULTIPLIER[suffix] ?? 1) : 1;
    const start = m.index;
    out.push({
      value: numeric * multiplier,
      index: start,
      end: VALUE_RE.lastIndex,
      hadSuffix: Boolean(suffix),
      hadDollar: text[start - 1] === "$",
    });
  }
  return out;
}

/** Pick the number the user means as the target threshold. */
function chooseTargetValue(text: string): number | null {
  const candidates = collectValues(text);
  if (candidates.length === 0) return null;

  // Prefer a number that directly follows a lead keyword (at / above / hits ...).
  for (const c of candidates) {
    const before = text.slice(Math.max(0, c.index - 16), c.index);
    if (TARGET_LEAD_RE.test(before)) return c.value;
  }
  // Otherwise prefer an explicit money / magnitude figure.
  const flagged = candidates.find((c) => c.hadDollar || c.hadSuffix);
  if (flagged) return flagged.value;

  return candidates[candidates.length - 1].value;
}

function choosePrimaryTarget(values: ValueMatch[], text: string): ValueMatch | null {
  if (values.length === 0) return null;

  // Prefer a number that directly follows a lead keyword (at / above / hits ...).
  for (const c of values) {
    const before = text.slice(Math.max(0, c.index - 16), c.index);
    if (TARGET_LEAD_RE.test(before)) return c;
  }
  // Otherwise prefer an explicit money / magnitude figure.
  const flagged = values.find((c) => c.hadDollar || c.hadSuffix);
  if (flagged) return flagged;

  return values[values.length - 1];
}

const TARGET_CONNECTOR_RE = /^\s*(?:or|and|,|\/|\+|&)\s*\$?\s*$/i;

/**
 * Pick all thresholds that are part of the same target phrase. This keeps the
 * existing "choose one target" heuristics, then fans out only numbers connected
 * by simple list separators, e.g. "BTC hits 60000 or 61000".
 */
function chooseTargetValues(text: string): number[] {
  const values = collectValues(text);
  const primary = choosePrimaryTarget(values, text);
  if (!primary || primary.value <= 0) return [];

  const primaryIndex = values.indexOf(primary);
  const selected: ValueMatch[] = [primary];

  for (let i = primaryIndex - 1; i >= 0; i -= 1) {
    const between = text.slice(values[i].end, selected[0].index);
    if (!TARGET_CONNECTOR_RE.test(between)) break;
    selected.unshift(values[i]);
  }

  for (let i = primaryIndex + 1; i < values.length; i += 1) {
    const between = text.slice(selected[selected.length - 1].end, values[i].index);
    if (!TARGET_CONNECTOR_RE.test(between)) break;
    selected.push(values[i]);
  }

  return selected.map((v) => v.value);
}

function detectDirection(text: string): AlertDirection | null {
  // "below" checked first so "goes below" isn't shadowed by a stray ">".
  if (BELOW_RE.test(text)) return "below";
  if (ABOVE_RE.test(text)) return "above";
  return null;
}

function detectMetric(text: string): AlertMetric {
  return MARKET_CAP_RE.test(text) ? "market_cap_usd" : "price_usd";
}

function normalizeTokenCandidate(candidate: string): string | null {
  const words = candidate.match(/\b[A-Za-z][A-Za-z0-9]{1,15}\b/g) ?? [];
  const filtered = words.filter((w) => !SYMBOL_STOP_WORDS.has(w.toUpperCase()));
  if (filtered.length === 0) return null;

  return filtered.join(" ").toUpperCase();
}

function extractTokenQuery(text: string): { tokenQuery: string; contractAddress: string | null } | null {
  const contract = text.match(CONTRACT_RE)?.[0] ?? null;
  if (contract) return { tokenQuery: contract, contractAddress: contract };

  const dollar = text.match(DOLLAR_TICKER_RE)?.[1];
  if (dollar) return { tokenQuery: dollar.toUpperCase(), contractAddress: null };

  const focusedText = text.replace(LEADING_CHATTER_RE, "");

  const contextualPatterns = [
    /\bwhen\s+(.+?)\s+(?:hits?|reach(?:es|ed)?|cross(?:es|ed)?|go(?:es)?\s+below|go(?:es)?\s+above|breaks?\s+(?:above|over|below|under)|dips?|drops?|falls?|moons?|pumps?|=|>=?|<=?)\b/i,
    /\bfor\s+(.+?)\s+(?:at|to|above|over|below|under|when|if|=|>=?|<=?)\b/i,
    /\b(?:alert|watch|track|notify)\s+(.+?)\s+(?:at|to|above|over|below|under|when|if|hits?|reach(?:es|ed)?|=|>=?|<=?)\b/i,
  ];
  for (const pattern of contextualPatterns) {
    const contextual = focusedText.match(pattern)?.[1];
    if (!contextual) continue;
    const candidate = normalizeTokenCandidate(contextual);
    if (candidate) return { tokenQuery: candidate, contractAddress: null };
  }

  // Fall back to the first plausible ticker-like word, preferring all-caps.
  const words = focusedText.match(/\b[A-Za-z][A-Za-z0-9]{1,15}\b/g) ?? [];
  const upperFirst = words.find(
    (w) => w === w.toUpperCase() && !SYMBOL_STOP_WORDS.has(w.toUpperCase()),
  );
  const candidate =
    upperFirst ?? words.find((w) => !SYMBOL_STOP_WORDS.has(w.toUpperCase()));
  if (!candidate) return null;
  return { tokenQuery: candidate.toUpperCase(), contractAddress: null };
}

/**
 * Parse a price-alert request from free text. Returns `null` when the message
 * is not an alert request (no alert verb, no number, or no token), so callers
 * can let other handlers process the message.
 */
function parseSingleAlertIntent(
  rawText: string,
  targetValueOverride?: number,
): ParsedAlertIntent | null {
  const text = rawText.trim();
  if (!text) return null;
  if (!ALERT_INTENT_RE.test(text)) return null;

  const targetValue = targetValueOverride ?? chooseTargetValue(text);
  if (targetValue === null || targetValue <= 0) return null;

  const token = extractTokenQuery(text);
  if (!token) return null;

  return {
    tokenQuery: token.tokenQuery,
    contractAddress: token.contractAddress,
    metric: detectMetric(text),
    targetValue,
    direction: detectDirection(text),
  };
}

export function parseAlertIntent(rawText: string): ParsedAlertIntent | null {
  return parseSingleAlertIntent(rawText);
}

export function parseAlertIntents(rawText: string): ParsedAlertIntent[] {
  const text = rawText.trim();
  if (!text) return [];

  const targetValues = chooseTargetValues(text);
  if (targetValues.length === 0) return [];

  const intents: ParsedAlertIntent[] = [];
  for (const targetValue of targetValues) {
    const intent = parseSingleAlertIntent(text, targetValue);
    if (intent) intents.push(intent);
  }
  return intents;
}
