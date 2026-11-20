/**
 * Canonical Spectrum / channel identity helpers.
 *
 * Phones are stored as E.164 with a leading `+`. Spectrum and WhatsApp sometimes
 * deliver digit-only handles that already include the country code — we only
 * prepend `+`, never invent a country code. Emails stay emails.
 */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/i;
const E164_RE = /^\+\d{7,15}$/;
const DIGITS_ONLY_RE = /^\d{7,15}$/;

/** True when the handle is an email (non-phone) identity. */
export function isEmailHandle(value: string | null | undefined): boolean {
  if (!value) return false;
  return EMAIL_RE.test(value.trim());
}

/**
 * Canonicalize an inbound channel handle before any DB write.
 * - email → trimmed as-is
 * - `+E.164` → cleaned E.164
 * - digit-only 7–15 (country code already present) → prepend `+`
 * - otherwise → trimmed raw (caller may reject)
 */
export function canonicalizeSenderId(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (isEmailHandle(trimmed)) return trimmed;

  const cleaned = trimmed.replace(/[^\d+]/g, "");
  if (E164_RE.test(cleaned)) return cleaned;
  if (DIGITS_ONLY_RE.test(cleaned)) return `+${cleaned}`;
  return trimmed;
}

/**
 * Lookup key variants for a phone-like sender id so joins work across legacy
 * digit-only rows and canonical `+E.164` rows during / after migration.
 */
export function senderIdLookupKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (isEmailHandle(trimmed)) return [trimmed];

  const canonical = canonicalizeSenderId(trimmed);
  const keys = new Set<string>();
  keys.add(trimmed);
  if (canonical) keys.add(canonical);
  const digits = trimmed.replace(/\D/g, "");
  if (DIGITS_ONLY_RE.test(digits)) {
    keys.add(digits);
    keys.add(`+${digits}`);
  }
  return [...keys];
}

/** True when this identity can participate in phone-claim / escrow flows. */
export function isPhoneClaimHandle(value: string | null | undefined): boolean {
  if (!value) return false;
  const canonical = canonicalizeSenderId(value);
  return E164_RE.test(canonical) && !isEmailHandle(canonical);
}
