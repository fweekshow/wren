import { sanitizeAmount } from "./sanitizeAmount.js";

/**
 * Normalize casual word amounts into numeric strings for send_token.
 * Returns null when the input is not a recognized word amount (caller should
 * fall through to sanitizeAmount for numeric forms).
 */
const WORD_AMOUNT_MAP: Record<string, string> = {
  "a penny": "0.01",
  penny: "0.01",
  "one penny": "0.01",
  "a cent": "0.01",
  cent: "0.01",
  "one cent": "0.01",
  "1 cent": "0.01",
  "a nickel": "0.05",
  nickel: "0.05",
  "a dime": "0.10",
  dime: "0.10",
  "a quarter": "0.25",
  quarter: "0.25",
  "one dollar": "1",
  "a dollar": "1",
  "a buck": "1",
  buck: "1",
};

export function normalizeWordAmount(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!trimmed) return null;
  if (WORD_AMOUNT_MAP[trimmed]) return WORD_AMOUNT_MAP[trimmed];

  // "one cent worth", "a penny in usdc" style fragments — match known phrases
  // as a prefix/substring when the whole string is prose-heavy.
  for (const [phrase, value] of Object.entries(WORD_AMOUNT_MAP)) {
    if (trimmed === phrase || trimmed.startsWith(`${phrase} `) || trimmed.endsWith(` ${phrase}`)) {
      return value;
    }
    if (trimmed.includes(` ${phrase} `)) return value;
  }
  return null;
}

/** Resolve a send amount: try word amounts first, then sanitizeAmount. */
export function resolveSendAmount(raw: string): string | null {
  return normalizeWordAmount(raw) ?? sanitizeAmount(raw);
}
