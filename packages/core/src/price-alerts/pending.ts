import type { ParsedAlertIntent } from "./types.js";
import {
  convKey,
  stateDelete,
  stateGet,
  stateHas,
  stateSet,
} from "@/state/conversationState.store.js";

/** Default TTL for pending alert disambiguation state: 10 minutes. */
const ALERT_TTL_SECONDS = 10 * 60;

/**
 * Remembers an in-progress alert while we wait on the user for a disambiguating
 * contract address. Keyed per platform + user + conversation so a follow-up
 * message (e.g. "0x… this one") can complete the original request.
 *
 * Now backed by Redis via ConversationStateStore so the state survives process
 * restarts and is safe under horizontal scaling.
 */
class PendingAlertStore {
  set(key: string, intent: ParsedAlertIntent): void {
    stateSet<ParsedAlertIntent>(key, intent, ALERT_TTL_SECONDS).catch((err) =>
      console.error("[PendingAlertStore] set failed:", err),
    );
  }

  async getAsync(key: string): Promise<ParsedAlertIntent | null> {
    return stateGet<ParsedAlertIntent>(key);
  }

  /** @deprecated Use getAsync() — sync .get() always returns null in Redis mode. */
  get(_key: string): ParsedAlertIntent | null {
    return null;
  }

  has(key: string): boolean {
    // Sync check cannot reach Redis. Use hasAsync() for accurate checks.
    return false;
  }

  async hasAsync(key: string): Promise<boolean> {
    return stateHas(key);
  }

  /** Clear all pending alerts (no-op for Redis keys — rely on natural TTL expiry). */
  clear(): void {
    // In Redis mode, entries expire via TTL. In-process fallback will also
    // expire. No need for an explicit full-scan clear in production.
  }

  delete(key: string): void {
    stateDelete(key).catch((err) =>
      console.error("[PendingAlertStore] delete failed:", err),
    );
  }
}

export const pendingAlerts = new PendingAlertStore();

export function pendingAlertKey(
  platform: string,
  userKey: string,
  conversationId: string | null,
): string {
  return convKey(platform, `${userKey}:${conversationId ?? ""}`, "pendingAlert");
}
