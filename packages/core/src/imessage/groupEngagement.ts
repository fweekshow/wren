// Explicit handles may include the ENS suffix shown by iMessage. Bare
// "Basemate" is only an invocation at the start of a message or after a
// greeting; matching every occurrence would mistake the BASEMATE token symbol
// (for example "buy $BASEMATE") for a bot mention.
const explicitMentionRegex = /(^|[^A-Za-z0-9_])@\s*basemate(?:\.(?:base\.)?eth)?\b/i;
const leadingBareMentionRegex = /^\s*basemate\b[\s,:;.!?-]*/i;
const greetedBareMentionRegex = /\b(hey|hi|hello|yo)(\s*[,!:;-]?\s*)basemate\b[\s,:;.!?-]*/i;

export function isImessageMentioned(text: string): boolean {
  return (
    explicitMentionRegex.test(text) ||
    leadingBareMentionRegex.test(text) ||
    greetedBareMentionRegex.test(text)
  );
}

export function removeImessageMention(text: string): string {
  if (explicitMentionRegex.test(text)) {
    return text.replace(explicitMentionRegex, "$1").replace(/\s+/g, " ").trim();
  }
  if (leadingBareMentionRegex.test(text)) {
    return text.replace(leadingBareMentionRegex, "").replace(/\s+/g, " ").trim();
  }
  return text.replace(greetedBareMentionRegex, "$1 ").replace(/\s+/g, " ").trim();
}

interface ImessageReplyMessage {
  isFromMe: boolean;
  replyTargetGuid?: string;
}

/**
 * Spectrum delivers inbound replies as ordinary text and does not include the
 * iMessage thread target in its webhook payload. Hydrate the native message,
 * then verify that its canonical reply target was sent by this iMessage line.
 */
export async function isReplyToOwnImessage(
  messageId: string,
  getMessage: (messageId: string) => Promise<ImessageReplyMessage>,
): Promise<boolean> {
  const inbound = await getMessage(messageId);
  if (!inbound.replyTargetGuid) return false;

  const target = await getMessage(inbound.replyTargetGuid);
  return target.isFromMe;
}
