import { ContactsAdapter } from "./contacts.adapter.js";
import { SmsConsentAdapter } from "./smsConsent.adapter.js";
import {
  applySmsConsent,
  decideRecipientTransfer,
  decideSpectrumOutbound,
  SMS_OPT_IN_ASK,
  type SpectrumOutboundPurpose,
} from "./smsConsent.js";
import { logger } from "@/utils/logger.js";

export type { SpectrumOutboundPurpose };

export function applySmsConsentInbound(
  senderId: string,
  text: string,
): Promise<{ reply: string | null }> {
  return applySmsConsent(senderId, text, {
    normalize: (raw) => ContactsAdapter.normalizeHandle(raw),
    getStatus: (phone) => SmsConsentAdapter.getStatus(phone),
    save: (phone, status, stamp) => SmsConsentAdapter.save(phone, status, stamp),
  });
}

/**
 * True only after this phone has texted CONFIRM and replied Y.
 * No row, pending, and opted out all hold the text. The poller leaves the
 * row pending and sends it on a later tick once status is opted_in.
 */
export async function recipientTransferAllowed(phone: string): Promise<boolean> {
  try {
    const normalized = ContactsAdapter.normalizeHandle(phone);
    if (!normalized) return false;
    const status = await SmsConsentAdapter.getStatus(normalized);
    return decideRecipientTransfer(status) === "send";
  } catch (err) {
    logger.warn({ err, phone }, "SMS consent lookup failed — holding recipient transfer");
    return false;
  }
}

/** Line to add to the sender's reply when this phone has not finished CONFIRM and Y. */
export async function smsOptInAskFor(phone: string | null | undefined): Promise<string | null> {
  const normalized = phone ? ContactsAdapter.normalizeHandle(phone) : null;
  if (!normalized) return null;
  const allowed = await recipientTransferAllowed(normalized);
  return allowed ? null : SMS_OPT_IN_ASK;
}

export async function spectrumOutboundDecision(
  phone: string,
  purpose: SpectrumOutboundPurpose,
): Promise<"send" | "suppress"> {
  try {
    const normalized = ContactsAdapter.normalizeHandle(phone);
    if (!normalized) return "send";
    const status = await SmsConsentAdapter.getStatus(normalized);
    return decideSpectrumOutbound(status, purpose);
  } catch (err) {
    logger.warn({ err, phone, purpose }, "SMS consent lookup failed — suppressing outbound");
    return "suppress";
  }
}
