/**
 * mockRedis — lightweight in-memory Redis mock for tests.
 *
 * Implements just enough of the ioredis API that stateGet/stateSet/stateDelete
 * from conversationState.store work without a real Redis connection.
 *
 * Usage:
 *   vi.mock("@/infra/redis.js", () => ({ getRedis: () => createMockRedis() }));
 */

export interface MockRedis {
  store: Map<string, { value: string; expiresAt: number }>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<"OK">;
  del(key: string): Promise<number>;
  unlink(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  on(event: string, handler: (...args: unknown[]) => void): MockRedis;
  clear(): void;
}

export function createMockRedis(): MockRedis {
  const store = new Map<string, { value: string; expiresAt: number }>();

  function isAlive(entry: { value: string; expiresAt: number }): boolean {
    return entry.expiresAt > Date.now();
  }

  const redis: MockRedis = {
    store,

    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry || !isAlive(entry)) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },

    async set(key: string, value: string, ...args: unknown[]): Promise<"OK"> {
      let ttlMs = 24 * 60 * 60 * 1000; // default 24h
      let nx = false;

      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "EX" && typeof args[i + 1] === "number") {
          ttlMs = (args[i + 1] as number) * 1000;
          i++;
        } else if (arg === "PX" && typeof args[i + 1] === "number") {
          ttlMs = args[i + 1] as number;
          i++;
        } else if (arg === "NX") {
          nx = true;
        }
      }

      if (nx) {
        const existing = store.get(key);
        if (existing && isAlive(existing)) return "OK"; // NX failed — return OK anyway (mock simplification)
      }

      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return "OK";
    },

    async del(key: string): Promise<number> {
      return store.delete(key) ? 1 : 0;
    },

    async unlink(...keys: string[]): Promise<number> {
      let count = 0;
      for (const key of keys) {
        if (store.delete(key)) count++;
      }
      return count;
    },

    async exists(...keys: string[]): Promise<number> {
      let count = 0;
      for (const key of keys) {
        const entry = store.get(key);
        if (entry && isAlive(entry)) count++;
      }
      return count;
    },

    on(_event: string, _handler: (...args: unknown[]) => void): MockRedis {
      return redis;
    },

    clear(): void {
      store.clear();
    },
  };

  return redis;
}
