const MAX_IDS_PER_CONVERSATION = 500;

const agentMessageIds = new Map<string, Set<string>>();

export function rememberAgentMessage(conversationId: string, messageId: string): void {
  if (!conversationId || !messageId) return;

  let ids = agentMessageIds.get(conversationId);
  if (!ids) {
    ids = new Set();
    agentMessageIds.set(conversationId, ids);
  }

  ids.add(messageId);
  if (ids.size > MAX_IDS_PER_CONVERSATION) {
    const oldest = ids.values().next().value;
    if (oldest) ids.delete(oldest);
  }
}

export function isKnownAgentMessage(conversationId: string, messageId: string): boolean {
  return agentMessageIds.get(conversationId)?.has(messageId) ?? false;
}
