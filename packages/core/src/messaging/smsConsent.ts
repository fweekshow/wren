/**
 * US SMS opt-in for the Spectrum path that is not iMessage.
 * Keyword matching is exact after trim, case-insensitive: CONFIRM, Y, YES, STOP, HELP.
 */

export type SmsConsentStatus = "pending" | "opted_in" | "opted_out";

export type SmsConsentStamp = "opted_in" | "opted_out" | null;

export type SpectrumOutboundPurpose = "payment_or_stock" | "other";

export const SMS_WELCOME =
  "Basemate, a service of Stablemate Labs Inc: texts when a payment or stock is sent to you. Message frequency varies. Message and data rates may apply. Reply HELP for help, STOP to opt out. Terms: https://basemate.app/terms Privacy: https://basemate.app/privacy. Reply Y to confirm.";

export const SMS_ENROLLED =
  "Basemate: You're in. Message frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to cancel.";

export const SMS_STOP = "Basemate: You are unsubscribed. No further messages will be sent.";

export const SMS_HELP =
  "Basemate: For help, email support@basemate.app or visit https://basemate.app/messaging. Reply STOP to unsubscribe.";

/** Number the CONFIRM keyword is handled on (Spectrum line, SMS when it is not iMessage). */
export const SMS_OPT_IN_NUMBER_DISPLAY = "+1 (628) 316-5638";

export const SMS_OPT_IN_ASK =
  `They won't get a text until they text CONFIRM to ${SMS_OPT_IN_NUMBER_DISPLAY} and reply Y.`;

export type SmsKeyword = "confirm" | "yes" | "stop" | "help" | "other";

export type SmsConsentDecision =
  | {
      action: "reply";
      reply: string;
      /** Null means do not write the consent row. */
      status: SmsConsentStatus | null;
      stamp: SmsConsentStamp;
    }
  | { action: "silence" };

export interface SmsConsentStore {
  normalize: (raw: string) => string | null;
  getStatus: (phone: string) => Promise<SmsConsentStatus | null>;
  save: (phone: string, status: SmsConsentStatus, stamp: SmsConsentStamp) => Promise<void>;
}

/** Spectrum SMS DM: not a group, and not an iMessage platform delivery. */
export function isSpectrumSmsDm(isGroup: boolean, platform: string): boolean {
  return !isGroup && platform !== "iMessage";
}

export function classifySmsKeyword(text: string): SmsKeyword {
  const normalized = text.trim().toUpperCase();
  if (normalized === "CONFIRM") return "confirm";
  if (normalized === "Y" || normalized === "YES") return "yes";
  if (normalized === "STOP") return "stop";
  if (normalized === "HELP") return "help";
  return "other";
}

/**
 * Inbound SMS DM decision. The conversational agent is not on this number.
 * CONFIRM is the only text that starts the welcome. Y or YES enrolls only
 * while that welcome is pending. Anything else, except STOP and HELP, is silent.
 */
export function decideSmsConsent(
  status: SmsConsentStatus | null,
  text: string,
): SmsConsentDecision {
  const keyword = classifySmsKeyword(text);

  if (keyword === "help") {
    return { action: "reply", reply: SMS_HELP, status: null, stamp: null };
  }

  if (keyword === "stop") {
    return { action: "reply", reply: SMS_STOP, status: "opted_out", stamp: "opted_out" };
  }

  if (status === "opted_in") {
    return { action: "silence" };
  }

  if (status === "pending") {
    if (keyword === "yes") {
      return { action: "reply", reply: SMS_ENROLLED, status: "opted_in", stamp: "opted_in" };
    }
    return { action: "silence" };
  }

  if (keyword === "confirm") {
    return { action: "reply", reply: SMS_WELCOME, status: "pending", stamp: null };
  }

  return { action: "silence" };
}

/**
 * No consent row means this handle is not on the SMS program (typical iMessage).
 * A row that is not opted_in blocks every proactive Spectrum send.
 * Payment and stock confirmations are the only proactive sends allowed once opted in.
 * Recipient transfer texts use decideRecipientTransfer instead: no row is a hold.
 */
export function decideSpectrumOutbound(
  status: SmsConsentStatus | null,
  purpose: SpectrumOutboundPurpose,
): "send" | "suppress" {
  if (status == null) return "send";
  if (purpose === "payment_or_stock" && status === "opted_in") return "send";
  return "suppress";
}

/** The "someone sent you" text waits until this phone has replied Y. */
export function decideRecipientTransfer(status: SmsConsentStatus | null): "send" | "hold" {
  return status === "opted_in" ? "send" : "hold";
}

export async function applySmsConsent(
  senderId: string,
  text: string,
  deps: SmsConsentStore,
): Promise<{ reply: string | null }> {
  const phone = deps.normalize(senderId);
  if (!phone) return { reply: null };

  const status = await deps.getStatus(phone);
  const decision = decideSmsConsent(status, text);
  if (decision.action === "silence") return { reply: null };
  if (decision.status) await deps.save(phone, decision.status, decision.stamp);
  return { reply: decision.reply };
}
