/** A half-finished launch wizard older than this is dropped on the next message. */
export const PENDING_LAUNCH_TTL_MS = 15 * 60 * 1000;

/**
 * Scope id for a launch session. Mirrors perpFlowKey's `a:b` shape, but keyed
 * conversation-first so a group thread owns its own launches.
 */
export function launchFlowKey(conversationId: string, senderId: string): string {
  return `${conversationId}:${senderId}`;
}
