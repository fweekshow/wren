import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const events: string[] = [];
  const where = vi.fn(async () => {
    events.push("supersede");
  });
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const returning = vi.fn(async () => {
    events.push("create");
    return [{ id: "new-session" }];
  });
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  const transaction = vi.fn(async (callback: (tx: unknown) => unknown) =>
    callback({ update, insert }),
  );

  return { events, where, set, update, returning, values, insert, transaction };
});

vi.mock("@/db/client.js", () => ({
  drizzleDb: { transaction: db.transaction },
}));

describe("OfframpSessionAdapter.create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.events.length = 0;
  });

  it("silently supersedes older pending sessions before creating the latest one", async () => {
    const { OfframpSessionAdapter } = await import("./offrampSession.js");

    const result = await OfframpSessionAdapter.create({
      platform: "imessage",
      userKey: "+15550001111",
      sourceAddress: "0xABCDEF",
      requestedAmount: "2",
    });

    expect(db.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "expired",
        notifiedAt: expect.any(Date),
        updatedAt: expect.any(Date),
      }),
    );
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "imessage",
        userKey: "+15550001111",
        sourceAddress: "0xabcdef",
        requestedAmount: "2",
      }),
    );
    expect(db.events).toEqual(["supersede", "create"]);
    expect(result.session).toEqual({ id: "new-session" });
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});
