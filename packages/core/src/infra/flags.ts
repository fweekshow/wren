/**
 * Redis-backed feature flags.
 *
 * Keys are stored as plain strings under `flag:{name}`.
 * A flag is considered ON when its value is the string "1".
 *
 * Usage:
 *   await setFlag("WORLD_CUP_ENABLED", true);
 *   if (await getFlag("WORLD_CUP_ENABLED")) { ... }
 *   await deleteFlag("WORLD_CUP_ENABLED");
 *
 * Falls back to false (never throws) when Redis is unavailable.
 */
import { getRedis } from "@/infra/redis.js";
import { logger } from "@/utils/logger.js";

const KEY_PREFIX = "flag:";

function flagKey(name: string): string {
  return `${KEY_PREFIX}${name}`;
}

/** Returns true when the flag is explicitly set to "1" in Redis. */
export async function getFlag(name: string): Promise<boolean> {
  try {
    const val = await getRedis().get(flagKey(name));
    return val === "1";
  } catch (err) {
    logger.warn({ err, flag: name }, "[flags] getFlag failed — defaulting to false");
    return false;
  }
}

/** Set a flag on or off. Pass an optional TTL in seconds. */
export async function setFlag(name: string, on: boolean, ttlSeconds?: number): Promise<void> {
  const redis = getRedis();
  const key = flagKey(name);
  if (ttlSeconds != null && ttlSeconds > 0) {
    await redis.set(key, on ? "1" : "0", "EX", ttlSeconds);
  } else {
    await redis.set(key, on ? "1" : "0");
  }
}

/** Remove a flag entirely (getFlag will return false). */
export async function deleteFlag(name: string): Promise<void> {
  await getRedis().del(flagKey(name));
}
