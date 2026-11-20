/**
 * mockDb — lightweight pg query stub for tests.
 *
 * Replaces the real postgres client (db from @/db/connection) with a mock
 * that you configure per-test via mockDb.mockQuery().
 *
 * Usage:
 *   vi.mock("@/db/connection.js", () => ({ db: createMockDb() }));
 *
 *   mockDb.mockQuery({ rows: [{ address: "0xabc" }] });
 */

export interface MockQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface MockDb {
  query<T = Record<string, unknown>>(
    _sql: string,
    _params?: unknown[],
  ): Promise<MockQueryResult<T>>;
  _enqueue(result: Partial<MockQueryResult>): void;
  _setDefault(result: Partial<MockQueryResult>): void;
  _calls: Array<{ sql: string; params?: unknown[] }>;
  _reset(): void;
}

export function createMockDb(): MockDb {
  const queue: Array<Partial<MockQueryResult>> = [];
  let defaultResult: Partial<MockQueryResult> = { rows: [], rowCount: 0 };
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const db: MockDb = {
    _calls: calls,

    async query<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<MockQueryResult<T>> {
      calls.push({ sql, params });
      const next = queue.shift() ?? defaultResult;
      return {
        rows: (next.rows ?? []) as T[],
        rowCount: next.rowCount ?? (next.rows?.length ?? 0),
      };
    },

    _enqueue(result: Partial<MockQueryResult>): void {
      queue.push(result);
    },

    _setDefault(result: Partial<MockQueryResult>): void {
      defaultResult = result;
    },

    _reset(): void {
      queue.length = 0;
      calls.length = 0;
      defaultResult = { rows: [], rowCount: 0 };
    },
  };

  return db;
}
