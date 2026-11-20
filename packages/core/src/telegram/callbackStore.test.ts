import { beforeEach, describe, expect, it, vi } from "vitest";

/** In-memory Postgres stand-in for the telegram_callbacks table. */
interface Row {
  id: string;
  telegram_user_id: string;
  chat_id: string;
  owner_inbox_id: string;
  strategy_id: string | null;
  version: number | null;
  action: string;
  params: Record<string, string>;
  nonce: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

const store = new Map<string, Row>();

const query = vi.fn(async (sql: string, params?: unknown[]) => {
  const text = sql.trim();
  if (text.startsWith("CREATE TABLE")) return { rows: [], rowCount: 0 };
  if (text.startsWith("INSERT INTO telegram_callbacks")) {
    const p = params as unknown[];
    const row: Row = {
      id: String(p[0]),
      telegram_user_id: String(p[1]),
      chat_id: String(p[2]),
      owner_inbox_id: String(p[3]),
      strategy_id: (p[4] as string | null) ?? null,
      version: (p[5] as number | null) ?? null,
      action: String(p[6]),
      params: JSON.parse(String(p[7])),
      nonce: String(p[8]),
      created_at: new Date(),
      expires_at: p[9] as Date,
      consumed_at: null,
    };
    store.set(row.id, row);
    return { rows: [], rowCount: 1 };
  }
  if (text.startsWith("SELECT * FROM telegram_callbacks WHERE id")) {
    const row = store.get(String((params as unknown[])[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (text.startsWith("UPDATE telegram_callbacks")) {
    const row = store.get(String((params as unknown[])[0]));
    if (row && row.consumed_at == null) {
      row.consumed_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  return { rows: [], rowCount: 0 };
});

vi.mock("@/discovery/db.js", () => ({ db: { query: (sql: string, p?: unknown[]) => query(sql, p) } }));

const { TelegramCallbackAdapter, isTelegramCallbackId } = await import("./callbackStore.js");

const payload = {
  telegramUserId: "555",
  chatId: "555",
  ownerInboxId: "a".repeat(64),
  strategyId: "s1",
  version: 1,
  action: "go_live",
  params: { pair: "ETH-USD" },
};

beforeEach(() => {
  store.clear();
  query.mockClear();
});

describe("isTelegramCallbackId", () => {
  it("accepts minted ids, rejects arbitrary callback_data", () => {
    expect(isTelegramCallbackId("cb_" + "a".repeat(32))).toBe(true);
    expect(isTelegramCallbackId("go_live:s1")).toBe(false);
    expect(isTelegramCallbackId("")).toBe(false);
  });
});

describe("TelegramCallbackAdapter redemption", () => {
  it("mints an opaque id and redeems it once for the right user+chat", async () => {
    const id = await TelegramCallbackAdapter.mint(payload);
    expect(id).toMatch(/^cb_[0-9a-f]{32}$/);

    const first = await TelegramCallbackAdapter.redeem({ id, telegramUserId: "555", chatId: "555" });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.payload.ownerInboxId).toBe(payload.ownerInboxId);
      expect(first.payload.action).toBe("go_live");
      expect(first.payload.params.pair).toBe("ETH-USD");
    }

    // Replay / double-tap fails.
    const second = await TelegramCallbackAdapter.redeem({ id, telegramUserId: "555", chatId: "555" });
    expect(second).toMatchObject({ ok: false, reason: "already_used" });
  });

  it("rejects a forged / unknown id", async () => {
    const res = await TelegramCallbackAdapter.redeem({
      id: "cb_" + "f".repeat(32),
      telegramUserId: "555",
      chatId: "555",
    });
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("rejects a cross-user press", async () => {
    const id = await TelegramCallbackAdapter.mint(payload);
    const res = await TelegramCallbackAdapter.redeem({ id, telegramUserId: "999", chatId: "555" });
    expect(res).toMatchObject({ ok: false, reason: "wrong_user" });
  });

  it("rejects a wrong-chat press", async () => {
    const id = await TelegramCallbackAdapter.mint(payload);
    const res = await TelegramCallbackAdapter.redeem({ id, telegramUserId: "555", chatId: "111" });
    expect(res).toMatchObject({ ok: false, reason: "wrong_chat" });
  });

  it("rejects an expired button", async () => {
    const id = await TelegramCallbackAdapter.mint(payload, -1);
    const res = await TelegramCallbackAdapter.redeem({ id, telegramUserId: "555", chatId: "555" });
    expect(res).toMatchObject({ ok: false, reason: "expired" });
  });
});
