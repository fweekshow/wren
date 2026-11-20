type Checker = (key: string) => boolean | Promise<boolean>;
const checkers: Checker[] = [];

/** Group-safe pending key — one slot per user per chat (DMs use the same shape). */
export function pendingUserKey(inboxId: string, conversationId: string): string {
  return `${inboxId}:${conversationId}`;
}

export function registerPendingInteractionChecker(fn: Checker): void {
  checkers.push(fn);
}

export async function hasPendingInteraction(key: string): Promise<boolean> {
  for (const fn of checkers) {
    if (await fn(key)) return true;
  }
  return false;
}
