import { config } from "@/config/config.js";
import { ContactsAdapter } from "../contacts.adapter.js";
import type { ParsedContactSave } from "../handler.types.js";
import { extractPrimaryPersonTag } from "./groupTag.utils.js";

/** True when the trimmed text is *only* a phone-like token (digits + separators). */
export function looksLikeBarePhone(text: string): boolean {
  const cleaned = text.trim().replace(/[\s().\-]/g, "");
  return /^\+?\d{7,15}$/.test(cleaned);
}

/**
 * Normalize a raw phone candidate to E.164 (`+<country code><number>`), or null
 * when it has no usable country code.
 */
export function normalizeContactPhone(raw: string): string | null {
  return ContactsAdapter.normalizeHandle(raw);
}

/**
 * Human-friendly rendering of an E.164 number for a save-confirm prompt, so the
 * user can eyeball the country code + digits before we store it. US/Canada
 * (+1) gets the familiar `+1 (415) 555-0123`; everything else shows raw E.164.
 */
export function formatPhoneDisplay(e164: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (us) return `+1 (${us[1]}) ${us[2]}-${us[3]}`;
  return e164;
}

export function phoneNumberForHeadlessOnramp(senderId: string): string {
  if (/^\+1[2-9]\d{9}$/.test(senderId)) return senderId;
  if (config.cdp.onrampSandbox) return "+12345678901";
  return senderId;
}

/**
 * Detect a contact-save message: either `Name: <number>` (saved immediately) or
 * a bare phone number (the caller then asks for the name). Returns null when the
 * text isn't a contact-save attempt.
 */
export function parseContactSaveText(text: string): ParsedContactSave | null {
  const trimmed = text.trim();
  const labeled = /^([^:]{1,40}):\s*(\+?[\d\s().\-]{6,})$/.exec(trimmed);
  if (labeled) {
    const name = labeled[1].trim().replace(/^(save|add|new|contact)\s+/i, "").trim();
    const phoneRaw = labeled[2].trim();
    if (name && looksLikeBarePhone(phoneRaw)) {
      return { name, phoneRaw };
    }
  }
  if (looksLikeBarePhone(trimmed)) {
    return { phoneRaw: trimmed };
  }
  return null;
}

/** Persist a chat-typed contact and return the user-facing confirmation. */
export async function saveImessageContactFromChat(
  senderId: string,
  name: string,
  phone: string,
): Promise<string> {
  try {
    await ContactsAdapter.saveContact(senderId, name, phone);
  } catch (err) {
    console.error("⚠️ [iMessage] failed to save contact from chat:", err);
    return "hmm, something went wrong saving that contact — try again in a sec";
  }
  return `saved ${name} (${phone}) — next time say "send 10 USDC to ${name}" and i'll use this contact`;
}

/**
 * Extract a recipient name from a send/pay/transfer phrase.
 * Used as a fallback when the LLM intent engine ran the local fast-path rule
 * and did not populate `intent.targetName`.
 *
 * Supports multi-word names (up to 4 words, e.g. "Austin Basile").
 * Returns null for dotted names (ENS/basename — handled by the ENS path)
 * and for 0x addresses (handled by the targetAddress path).
 */
const SEND_VERBS = "send|transfer|pay|tip|give|shoot|toss|fire";
const RECIPIENT_NAME =
  "((?:[a-z][a-z0-9_-]{0,39})(?:\\s+[a-z][a-z0-9_-]{0,39}){0,3})";
/** Amount after recipient-first name: $N, .01, or word amounts. */
const AMOUNT_LOOKAHEAD =
  "(?=\\$?\\s*(?:\\d|\\.\\d)|(?:a|one|\\d+)\\s+(?:penny|cent|cents|nickel|dime|quarter|dollar|buck|bucks)|(?:penny|cent)\\b)";
const NON_RECIPIENT =
  /^(?:a|one|usdc|usd|eth|weth|stables|stable|dollars?|bucks?|lunch|dinner|rent|birthday|coffee|gas|food|thanks|please)$/i;

/**
 * Pull a plain contact name from a send-like message.
 * Prefers an @person tag (group tag-to-send), then explicit `to <name>`,
 * recipient-first verb forms, then `for <name>` when not a memo word.
 */
export function extractRecipientName(text: string): string | null {
  const tagged = extractPrimaryPersonTag(text);
  if (tagged && !NON_RECIPIENT.test(tagged)) return tagged;

  const toMatch = text.match(new RegExp(`\\bto\\s+@?${RECIPIENT_NAME}(?:\\s|$|[?.!,])`, "i"));
  if (toMatch?.[1] && !toMatch[1].includes(".")) {
    const raw = toMatch[1].trim();
    if (!NON_RECIPIENT.test(raw)) return raw;
  }

  const leading = text.match(
    new RegExp(`\\b(?:${SEND_VERBS})\\s+@?${RECIPIENT_NAME}\\s+${AMOUNT_LOOKAHEAD}`, "i"),
  );
  if (leading?.[1] && !leading[1].includes(".")) {
    const raw = leading[1].trim();
    if (!NON_RECIPIENT.test(raw)) return raw;
  }

  // "send $2 for Alice" — treat `for` as recipient only when not a memo word.
  const forMatch = text.match(new RegExp(`\\bfor\\s+@?${RECIPIENT_NAME}(?:\\s|$|[?.!,])`, "i"));
  if (forMatch?.[1] && !forMatch[1].includes(".")) {
    const raw = forMatch[1].trim();
    if (!NON_RECIPIENT.test(raw)) return raw;
  }

  return null;
}
