/**
 * Country-calling-code → local Base stablecoin routing for phone sends.
 *
 * When a user sends USDC to an E.164 number whose country code is mapped here,
 * we try to swap USDC → local stable and deliver that instead. Unmapped codes
 * and failed quotes fall back to USDC.
 */
import { verifiedStableBySymbol, type VerifiedStable } from "@/portfolio/verifiedStables.js";

/** ISO calling codes (digits only, no '+') → corridor stable symbol. */
const CORRIDOR_CALLING_CODES: Record<string, string> = {
  "52": "MXNB", // Mexico
  "55": "BRZ", // Brazil
  "27": "ZARP", // South Africa
  "65": "XSGD", // Singapore
  "62": "IDRX", // Indonesia
  "60": "MYRC", // Malaysia
  "61": "AUDD", // Australia
  "44": "TGBP", // UK
  "41": "VCHF", // Switzerland
  "46": "SEKAU", // Sweden
};

/** Longest-first so e.g. future +1242 wouldn't steal a shorter prefix incorrectly. */
const CALLING_CODES_LONGEST_FIRST = Object.keys(CORRIDOR_CALLING_CODES).sort(
  (a, b) => b.length - a.length,
);

const USD_SEND_ASSETS = new Set(["USDC", "USD", "USDBC", "USDB"]);

/** True when the requested send asset should trigger corridor auto-swap. */
export function isUsdSendAsset(symbol: string | null | undefined): boolean {
  if (!symbol) return true;
  const s = symbol.trim().toUpperCase();
  if (!s) return true;
  if (s === "$" || s.startsWith("$")) return true;
  return USD_SEND_ASSETS.has(s);
}

/**
 * Extract the corridor stable for an E.164 phone via longest-prefix calling-code match.
 * Returns null when the number is invalid or the country is unmapped / not verified.
 */
export function resolveCorridorStable(phone: string | null | undefined): VerifiedStable | null {
  if (!phone) return null;
  const digits = phone.trim().replace(/^\+/, "").replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;

  for (const cc of CALLING_CODES_LONGEST_FIRST) {
    if (!digits.startsWith(cc)) continue;
    // National number must remain after the country code.
    if (digits.length <= cc.length) continue;
    const symbol = CORRIDOR_CALLING_CODES[cc];
    if (!symbol) continue;
    const stable = verifiedStableBySymbol(symbol);
    if (!stable || stable.status !== "verified" || !stable.address) return null;
    return stable;
  }
  return null;
}

/** Exported for tests — calling code → symbol map (digits only). */
export function corridorCallingCodeMap(): Readonly<Record<string, string>> {
  return CORRIDOR_CALLING_CODES;
}
