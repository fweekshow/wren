const MAX_TRANSFER_MESSAGE_LENGTH = 500;
const EXPLICIT_TRANSFER_MESSAGE_RE =
  /\b(?:with\s+(?:a\s+)?(?:message|note)|(?:message|note)\s*:)\s*(?:is\s+)?([\s\S]+)$/i;

export function normalizeTransferMessage(value: string): string | null {
  const trimmed = value
    .trim()
    .replace(/^(["'“‘])([\s\S]*)(["'”’])$/, "$2")
    .trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_TRANSFER_MESSAGE_LENGTH);
}

/**
 * Extracts only explicit message/note clauses. Broader implied memos such as
 * "for lunch" remain the responsibility of the send-token AI tool.
 */
export function extractExplicitTransferMessage(text: string): string | null {
  const match = text.match(EXPLICIT_TRANSFER_MESSAGE_RE);
  return match?.[1] ? normalizeTransferMessage(match[1]) : null;
}

export function stripExplicitTransferMessage(text: string): string {
  return text.replace(EXPLICIT_TRANSFER_MESSAGE_RE, "").trim();
}

export function isTransferMessageSkip(text: string): boolean {
  return /^(?:skip|no|none|nope|without (?:a )?(?:message|note)|no (?:message|note))$/i.test(
    text.trim(),
  );
}
