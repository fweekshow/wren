import { randomBytes } from "node:crypto";

import { db } from "@/discovery/db.js";

const SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * Longer TTL for proactive claim invites. The standard setup flow is tapped
 * within minutes, but a claim invite may not be opened for hours or days.
 */
export const CLAIM_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Issues opaque wallet-connect sessions. The legacy database table name is
 * intentionally retained so existing sessions and schema remain compatible.
 */
/** A signup session that completed but hasn't had its welcome DM sent yet. */
export interface PendingWelcomeSession {
  token: string;
  senderId: string;
}

export class WalletSetupSessionAdapter {
  static async create(senderId: string, ttlMs: number = SESSION_TTL_MS): Promise<string> {
    const token = randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + ttlMs);

    await db.query(
      `CREATE TABLE IF NOT EXISTS base_account_setup_sessions (
        token TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    );

    await db.query(
      `INSERT INTO base_account_setup_sessions (token, sender_id, expires_at)
       VALUES ($1, $2, $3)`,
      [token, senderId, expiresAt],
    );

    return token;
  }

  /** Ensure the welcome-tracking column exists (idempotent). */
  static async ensureWelcomeColumn(): Promise<void> {
    await db.query(
      `ALTER TABLE base_account_setup_sessions ADD COLUMN IF NOT EXISTS welcome_sent_at TIMESTAMPTZ`,
    );
  }

  /**
   * Users who finished signup but have NEVER received the welcome DM. Deduped
   * per sender (one row per user, not per session) and excludes any sender that
   * already has a welcomed session — so re-onboarding or multiple setup links
   * never trigger a second welcome. Powers the WalletWelcomePoller.
   */
  static async listPendingWelcomes(limit = 50): Promise<PendingWelcomeSession[]> {
    await this.ensureWelcomeColumn();
    const result = await db.query(
      `SELECT DISTINCT ON (sender_id) token, sender_id
         FROM base_account_setup_sessions s
        WHERE completed_at IS NOT NULL
          AND welcome_sent_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM base_account_setup_sessions w
             WHERE w.sender_id = s.sender_id AND w.welcome_sent_at IS NOT NULL
          )
        ORDER BY sender_id, completed_at ASC
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      token: row.token as string,
      senderId: row.sender_id as string,
    }));
  }

  /**
   * Claim the welcome for a whole SENDER (marks welcome_sent_at on all of that
   * user's completed sessions) — returns true only for the caller that won the
   * race, so the DM fires at most once per user even with multiple sessions,
   * overlapping ticks, or multiple instances.
   */
  static async claimWelcome(senderId: string): Promise<boolean> {
    const result = await db.query(
      `UPDATE base_account_setup_sessions
          SET welcome_sent_at = NOW()
        WHERE sender_id = $1 AND completed_at IS NOT NULL AND welcome_sent_at IS NULL`,
      [senderId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Roll back a sender's welcome claim so a later tick can retry (on delivery failure). */
  static async unclaimWelcome(senderId: string): Promise<void> {
    await db.query(
      `UPDATE base_account_setup_sessions SET welcome_sent_at = NULL WHERE sender_id = $1`,
      [senderId],
    );
  }
}
