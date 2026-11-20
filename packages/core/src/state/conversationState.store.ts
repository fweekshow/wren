/**
 * ConversationStateStore — Redis-backed conversation state with in-memory fallback.
 *
 * Keys are namespaced as `conv:{platform}:{conversationId}:{stateKey}` and
 * expire automatically via Redis TTLs, eliminating the in-process Map leak that
 * occurs when conversations go idle.
 *
 * When Redis is unavailable (REDIS_URL unset, or connection error) the store
 * falls back to an in-process Map so the bot continues to function. A warning
 * is logged on first fallback. This makes the migration safe to deploy
 * incrementally before Redis is fully wired in every environment.
 */

import { getRedis } from "@/infra/redis.js";

/** Default TTL for conversation state entries (30 minutes). */
const DEFAULT_TTL_SECONDS = 30 * 60;

/** Longer TTL for flows that can legitimately take many hours (e.g. email OTP). */
export const LONG_TTL_SECONDS = 4 * 60 * 60;

/** Whether we've already logged the Redis fallback warning this process. */
let warnedAboutFallback = false;

function warnFallback(err: unknown): void {
  if (!warnedAboutFallback) {
    warnedAboutFallback = true;
    console.warn(
      "[ConversationStateStore] Redis unavailable — falling back to in-process Map.",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** The in-process fallback store (keyed by full Redis key). */
const fallbackStore = new Map<string, { value: string; expiresAt: number }>();

export function __clearConversationStateForTests(): void {
  if (process.env.NODE_ENV === "test") fallbackStore.clear();
}

function fallbackGet(key: string): string | null {
  const entry = fallbackStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    fallbackStore.delete(key);
    return null;
  }
  return entry.value;
}

function fallbackSet(key: string, value: string, ttlSeconds: number): void {
  fallbackStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

function fallbackDelete(key: string): void {
  fallbackStore.delete(key);
}

function fallbackHas(key: string): boolean {
  return fallbackGet(key) !== null;
}

/**
 * Build the canonical Redis key for a piece of conversation state.
 *
 * @param platform   "imessage" | "whatsapp" | "xmtp" | …
 * @param scopeId    The conversation or user ID that scopes this state.
 * @param stateKey   Logical name for this state slot, e.g. "pendingTrade".
 */
export function convKey(platform: string, scopeId: string, stateKey: string): string {
  return `conv:${platform}:${scopeId}:${stateKey}`;
}

/**
 * Retrieve a typed value from the store.
 * Returns `null` if the key does not exist or has expired.
 */
export async function stateGet<T>(key: string): Promise<T | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    warnFallback(err);
    const raw = fallbackGet(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  }
}

/**
 * Store a typed value, optionally with a TTL (defaults to 30 min).
 */
export async function stateSet<T>(
  key: string,
  value: T,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<void> {
  const serialized = JSON.stringify(value);
  try {
    const redis = getRedis();
    await redis.set(key, serialized, "EX", ttlSeconds);
  } catch (err) {
    warnFallback(err);
    fallbackSet(key, serialized, ttlSeconds);
  }
}

/**
 * Delete a key from the store (no-op if already absent).
 */
export async function stateDelete(key: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.del(key);
  } catch (err) {
    warnFallback(err);
    fallbackDelete(key);
  }
}

/**
 * Check whether a key exists in the store (respects TTL).
 */
export async function stateHas(key: string): Promise<boolean> {
  try {
    const redis = getRedis();
    return (await redis.exists(key)) === 1;
  } catch (err) {
    warnFallback(err);
    return fallbackHas(key);
  }
}

/**
 * Delete multiple keys in a single round trip (UNLINK is non-blocking).
 * Silently no-ops for any keys that don't exist.
 */
export async function stateDeleteMany(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    const redis = getRedis();
    await redis.unlink(...keys);
  } catch (err) {
    warnFallback(err);
    keys.forEach(fallbackDelete);
  }
}

/**
 * Check whether ANY of the given keys exist. Useful for the
 * `hasPendingInteraction` check that scans all pending-flow slots at once.
 */
export async function stateHasAny(keys: string[]): Promise<boolean> {
  if (keys.length === 0) return false;
  try {
    const redis = getRedis();
    return (await redis.exists(...keys)) > 0;
  } catch (err) {
    warnFallback(err);
    return keys.some(fallbackHas);
  }
}

// ─── Distributed lock (SET NX PX) ────────────────────────────────────────────

/**
 * Attempt to acquire a distributed lock.
 *
 * Returns `true` if the lock was acquired, `false` if it was already held.
 * The lock expires automatically after `ttlMs` milliseconds.
 *
 * Usage:
 * ```ts
 * const acquired = await acquireLock("lock:strategy:42", 60_000);
 * if (!acquired) return; // another instance is running
 * try { ... } finally { await releaseLock("lock:strategy:42"); }
 * ```
 */
export async function acquireLock(key: string, ttlMs: number): Promise<boolean> {
  try {
    const redis = getRedis();
    const result = await redis.set(key, "1", "PX", ttlMs, "NX");
    return result === "OK";
  } catch (err) {
    warnFallback(err);
    // In fallback mode, use the same in-process Map as a mock lock.
    if (fallbackHas(key)) return false;
    fallbackSet(key, "1", Math.ceil(ttlMs / 1000));
    return true;
  }
}

/**
 * Release a distributed lock acquired with `acquireLock`.
 */
export async function releaseLock(key: string): Promise<void> {
  await stateDelete(key);
}
