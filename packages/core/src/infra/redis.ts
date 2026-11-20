import { Redis } from "ioredis";

import { config } from "@/config/config.js";

let _redis: Redis | null = null;

/**
 * Returns the shared Redis client, creating it lazily on first call.
 * Throws at access time (not import time) if REDIS_URL is unset so services
 * that don't need Redis can still start without the env var.
 */
export function getRedis(): Redis {
  if (_redis) return _redis;

  if (!config.redisUrl) {
    throw new Error(
      "REDIS_URL is required for this feature. Set it in Railway env vars.",
    );
  }

  _redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });

  _redis.on("error", (err) => {
    console.error("[redis] connection error:", err.message);
  });

  return _redis;
}

/**
 * Returns the shared Redis client or null when REDIS_URL is not configured.
 * Use this in callers that should fall back to in-process state when Redis
 * is unavailable (e.g. strategy runner in local dev without a Redis instance).
 */
export function getRedisOrNull(): Redis | null {
  if (!config.redisUrl) return null;
  return getRedis();
}

/** Gracefully close the shared client (call on SIGTERM). */
export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
