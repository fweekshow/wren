import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbStore = new Map<string, unknown>();
const redisStore = new Map<string, string>();
let redisAvailable = true;

vi.mock("@/discovery/db.js", () => ({
  db: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const pair = String(params[0] ?? "");
      if (/select\s+samples/i.test(sql)) {
        const samples = dbStore.get(pair);
        return { rows: samples ? [{ samples }] : [] };
      }
      if (/insert\s+into\s+strategy_mark_buffers/i.test(sql)) {
        dbStore.set(pair, JSON.parse(String(params[1])));
        return { rows: [] };
      }
      return { rows: [] };
    }),
  },
}));

vi.mock("./redis.js", () => ({
  getStrategyRedisConnection: () =>
    redisAvailable
      ? {
          get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
          setex: vi.fn(async (key: string, _ttl: number, value: string) => {
            redisStore.set(key, value);
            return "OK";
          }),
        }
      : null,
}));

import { clearMarkSampleCache, pushMarkSample } from "./priceHistory.js";

const NOW = 1_800_000_000_000;

describe("strategy price history persistence", () => {
  beforeEach(() => {
    dbStore.clear();
    redisStore.clear();
    redisAvailable = true;
    clearMarkSampleCache();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hydrates from Redis after an in-memory restart", async () => {
    await pushMarkSample("ETH", 100);
    await Promise.resolve();
    clearMarkSampleCache();

    const samples = await pushMarkSample("ETH-USD", 101);

    expect(samples.map((sample) => sample.price)).toEqual([100, 101]);
    expect(redisStore.has("strategy:mark:ETH-USD")).toBe(true);
  });

  it("normalizes bare assets to the shared USD pair key", async () => {
    await pushMarkSample("eth", 100);
    await Promise.resolve();

    expect(redisStore.has("strategy:mark:ETH-USD")).toBe(true);
    expect(dbStore.has("ETH-USD")).toBe(true);
  });

  it("prunes stale samples during hydration", async () => {
    dbStore.set("ETH-USD", [
      { ts: NOW - 21 * 60_000, price: 99 },
      { ts: NOW - 60_000, price: 100 },
    ]);

    const samples = await pushMarkSample("ETH-USD", 101);

    expect(samples.map((sample) => sample.price)).toEqual([100, 101]);
  });

  it("falls back to Postgres when Redis is unavailable", async () => {
    redisAvailable = false;
    dbStore.set("ETH-USD", [{ ts: NOW - 60_000, price: 100 }]);

    const samples = await pushMarkSample("ETH-USD", 102);
    await Promise.resolve();

    expect(samples.map((sample) => sample.price)).toEqual([100, 102]);
    expect(dbStore.get("ETH-USD")).toEqual(samples);
  });
});
