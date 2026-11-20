import { db } from "@/discovery/db.js";

export class WhatsappCursorAdapter {
  static async createTable(): Promise<void> {
    await db.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_event_cursors (
        key        TEXT PRIMARY KEY,
        cursor     TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  static async get(key: string): Promise<string | null> {
    const result = await db.query<{ cursor: string }>(
      `SELECT cursor FROM whatsapp_event_cursors WHERE key = $1`,
      [key],
    );
    return result.rows[0]?.cursor ?? null;
  }

  static async set(key: string, cursor: string): Promise<void> {
    await db.query(
      `INSERT INTO whatsapp_event_cursors (key, cursor, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (key)
       DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = CURRENT_TIMESTAMP`,
      [key, cursor],
    );
  }
}
