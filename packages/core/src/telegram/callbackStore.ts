import { randomUUID } from "node:crypto";

import { db } from "@/discovery/db.js";

/**
 * Durable, opaque Telegram callback store.
 *
 * Telegram `callback_data` is capped at 64 bytes and is fully attacker-supplied
 * on the wire, so we NEVER encode intent (strategy id, action, owner) into it.
 * Instead every button carries an opaque `cb_<uuid>` id whose real payload lives
 * server-side here, keyed to the exact user + chat + strategy owner it was minted
 * for. Redemption is single-use (a nonce is cleared atomically) and expiring, so
 * forged, replayed, cross-user, or stale button presses all fail closed.
 *
 * This intentionally does NOT reuse the deprecated Grammy in-memory registry or
 * its IDOR-prone `verb:id` callback_data scheme.
 */

export interface TelegramCallbackPayload {
  /** Telegram numeric user id the button was minted for. */
  telegramUserId: string;
  /** Telegram chat id (DM) the button was sent to. */
  chatId: string;
  /** Canonical XMTP inbox id that owns the strategy/wallet (never a telegram id). */
  ownerInboxId: string;
  /** Target strategy, when the action is strategy-scoped. */
  strategyId: string | null;
  /** Strategy config/version guard so a stale card can't act on a changed strategy. */
  version: number | null;
  /** Logical action, e.g. "go_live", "stop", "open_detail". */
  action: string;
  /** Arbitrary extra params (pair, collateral, etc.). */
  params: Record<string, string>;
}

export interface StoredTelegramCallback extends TelegramCallbackPayload {
  id: string;
  createdAt: Date;
  expiresAt: Date;
}

export type RedeemResult =
  | { ok: true; payload: StoredTelegramCallback }
  | {
      ok: false;
      reason: "not_found" | "expired" | "wrong_user" | "wrong_chat" | "already_used";
    };

/** Default lifetime of a callback button before it must be refreshed. */
export const TELEGRAM_CALLBACK_TTL_MS = 30 * 60 * 1000;

const CALLBACK_ID_RE = /^cb_[0-9a-f]{32}$/;

export function isTelegramCallbackId(value: string | null | undefined): value is string {
  return typeof value === "string" && CALLBACK_ID_RE.test(value.trim());
}

export class TelegramCallbackAdapter {
  static async createTable(): Promise<void> {
    await db.query(`
      CREATE TABLE IF NOT EXISTS telegram_callbacks (
        id               TEXT PRIMARY KEY,
        telegram_user_id TEXT NOT NULL,
        chat_id          TEXT NOT NULL,
        owner_inbox_id   TEXT NOT NULL,
        strategy_id      TEXT,
        version          INTEGER,
        action           TEXT NOT NULL,
        params           JSONB NOT NULL DEFAULT '{}'::jsonb,
        nonce            TEXT NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at       TIMESTAMPTZ NOT NULL,
        consumed_at      TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_telegram_callbacks_expires
        ON telegram_callbacks(expires_at);
    `);
  }

  /** Mint a new opaque callback id for a button. */
  static async mint(
    payload: TelegramCallbackPayload,
    ttlMs = TELEGRAM_CALLBACK_TTL_MS,
  ): Promise<string> {
    const id = `cb_${randomUUID().replace(/-/g, "").slice(0, 32)}`;
    const nonce = randomUUID();
    const expiresAt = new Date(Date.now() + ttlMs);
    await db.query(
      `INSERT INTO telegram_callbacks
         (id, telegram_user_id, chat_id, owner_inbox_id, strategy_id, version, action, params, nonce, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        payload.telegramUserId,
        payload.chatId,
        payload.ownerInboxId,
        payload.strategyId,
        payload.version,
        payload.action,
        JSON.stringify(payload.params ?? {}),
        nonce,
        expiresAt,
      ],
    );
    return id;
  }

  /**
   * Atomically redeem a callback id, enforcing single-use + ownership. The
   * caller passes the pressing user's telegram id and chat id; both must match
   * what the button was minted for. The nonce is cleared in the same UPDATE so a
   * double-tap or replay can only succeed once.
   */
  static async redeem(input: {
    id: string;
    telegramUserId: string;
    chatId: string;
  }): Promise<RedeemResult> {
    if (!isTelegramCallbackId(input.id)) return { ok: false, reason: "not_found" };

    const row = await db.query<{
      id: string;
      telegram_user_id: string;
      chat_id: string;
      owner_inbox_id: string;
      strategy_id: string | null;
      version: number | null;
      action: string;
      params: Record<string, string> | null;
      created_at: Date;
      expires_at: Date;
      consumed_at: Date | null;
    }>(`SELECT * FROM telegram_callbacks WHERE id = $1`, [input.id]);
    const found = row.rows[0];
    if (!found) return { ok: false, reason: "not_found" };
    if (found.consumed_at) return { ok: false, reason: "already_used" };
    if (found.expires_at.getTime() <= Date.now()) return { ok: false, reason: "expired" };
    if (found.telegram_user_id !== input.telegramUserId) return { ok: false, reason: "wrong_user" };
    if (found.chat_id !== input.chatId) return { ok: false, reason: "wrong_chat" };

    // Single-use: only the first redeemer flips consumed_at.
    const consumed = await db.query(
      `UPDATE telegram_callbacks
         SET consumed_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND consumed_at IS NULL`,
      [input.id],
    );
    if ((consumed.rowCount ?? 0) === 0) return { ok: false, reason: "already_used" };

    return {
      ok: true,
      payload: {
        id: found.id,
        telegramUserId: found.telegram_user_id,
        chatId: found.chat_id,
        ownerInboxId: found.owner_inbox_id,
        strategyId: found.strategy_id,
        version: found.version,
        action: found.action,
        params: found.params ?? {},
        createdAt: found.created_at,
        expiresAt: found.expires_at,
      },
    };
  }

  /** Best-effort cleanup of expired/consumed rows (call from a periodic job). */
  static async purgeExpired(): Promise<void> {
    await db
      .query(
        `DELETE FROM telegram_callbacks
         WHERE expires_at < NOW() - INTERVAL '1 day' OR consumed_at IS NOT NULL`,
      )
      .catch(() => undefined);
  }
}
