import type { Redis } from "ioredis";

import { getRedisOrNull, closeRedis } from "@/infra/redis.js";

/**
 * Shared Redis connection for strategy runtime state. Returns null when Redis is
 * not configured so callers can fall back to durable storage.
 * Delegates to the shared infra/redis singleton — no second connection.
 */
export function getStrategyRedisConnection(): Redis | null {
  return getRedisOrNull();
}

export async function closeStrategyRedisConnection(): Promise<void> {
  await closeRedis();
}
