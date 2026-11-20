import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { db } from "@/discovery/db.js";

export type LinkPlatform = "imessage" | "xmtp" | "whatsapp" | "telegram";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export interface ConnectionTokenRow {
  token_hash: string;
  platform: LinkPlatform;
  user_key: string;
  wallet_address: string | null;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

export interface AccountLinkMemberRow {
  link_id: string;
  platform: LinkPlatform;
  user_key: string;
  wallet_address: string | null;
  added_at: Date;
}

/**
 * Cross-platform account linking storage.
 *
 * Three tables back the connection-string handshake:
 *  - `connection_tokens` holds one-time, short-lived tokens (only the SHA-256
 *    hash is persisted, never the raw string).
 *  - `account_links` is a link group (one row per set of linked identities).
 *  - `account_link_members` maps a (platform, user_key) identity to a link group
 *    and caches the wallet resolved at link time.
 */
export class AccountLinkAdapter {
  static async createTable(): Promise<void> {
    await db.query(`
      CREATE TABLE IF NOT EXISTS connection_tokens (
        token_hash      TEXT PRIMARY KEY,
        platform        TEXT NOT NULL,
        user_key        TEXT NOT NULL,
        wallet_address  TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at      TIMESTAMPTZ NOT NULL,
        consumed_at     TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_connection_tokens_issuer
        ON connection_tokens(platform, user_key);
      CREATE INDEX IF NOT EXISTS idx_connection_tokens_expires
        ON connection_tokens(expires_at);

      CREATE TABLE IF NOT EXISTS account_links (
        id          UUID PRIMARY KEY,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS account_link_members (
        link_id         UUID NOT NULL REFERENCES account_links(id) ON DELETE CASCADE,
        platform        TEXT NOT NULL,
        user_key        TEXT NOT NULL,
        wallet_address  TEXT,
        added_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (platform, user_key)
      );

      CREATE INDEX IF NOT EXISTS idx_account_link_members_link
        ON account_link_members(link_id);
    `);
  }

  /** SHA-256 hex of a raw connection string. Only the hash is ever stored. */
  static hashToken(token: string): string {
    return createHash("sha256").update(token.trim()).digest("hex");
  }

  static async insertToken(input: {
    token: string;
    platform: LinkPlatform;
    userKey: string;
    walletAddress: string | null;
    expiresAt: Date;
  }): Promise<void> {
    await db.query(
      `INSERT INTO connection_tokens (token_hash, platform, user_key, wallet_address, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token_hash) DO NOTHING`,
      [
        this.hashToken(input.token),
        input.platform,
        input.userKey,
        input.walletAddress ? input.walletAddress.toLowerCase() : null,
        input.expiresAt,
      ],
    );
  }

  /** Look up a token by raw value. Returns the row even if expired/consumed. */
  static async getTokenByValue(token: string): Promise<ConnectionTokenRow | null> {
    const result = await db.query<ConnectionTokenRow>(
      `SELECT * FROM connection_tokens WHERE token_hash = $1`,
      [this.hashToken(token)],
    );
    return result.rows[0] ?? null;
  }

  static async getMembership(
    platform: LinkPlatform,
    userKey: string,
  ): Promise<AccountLinkMemberRow | null> {
    const result = await db.query<AccountLinkMemberRow>(
      `SELECT * FROM account_link_members WHERE platform = $1 AND user_key = $2`,
      [platform, userKey],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Atomically consume a token and link the redeeming identity to the token
   * issuer's identity. Handles all four membership states (neither linked, one
   * linked, both already in the same group, both in different groups → merge).
   *
   * The caller is expected to validate self-link / expiry / already-consumed
   * before calling, but the consume step is guarded again here inside the
   * transaction to close races.
   */
  static async redeemAndLink(input: {
    token: string;
    issuer: { platform: LinkPlatform; userKey: string; wallet: string | null };
    redeemer: { platform: LinkPlatform; userKey: string; wallet: string | null };
  }): Promise<{ ok: true; linkId: string } | { ok: false; reason: "consumed" }> {
    const tokenHash = this.hashToken(input.token);
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const consumed = await client.query(
        `UPDATE connection_tokens
         SET consumed_at = CURRENT_TIMESTAMP
         WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
        [tokenHash],
      );
      if ((consumed.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "consumed" };
      }

      const issuerMember = await client.query<AccountLinkMemberRow>(
        `SELECT * FROM account_link_members WHERE platform = $1 AND user_key = $2`,
        [input.issuer.platform, input.issuer.userKey],
      );
      const redeemerMember = await client.query<AccountLinkMemberRow>(
        `SELECT * FROM account_link_members WHERE platform = $1 AND user_key = $2`,
        [input.redeemer.platform, input.redeemer.userKey],
      );
      const issuerLink = issuerMember.rows[0]?.link_id ?? null;
      const redeemerLink = redeemerMember.rows[0]?.link_id ?? null;

      let linkId: string;
      if (issuerLink && redeemerLink) {
        if (issuerLink === redeemerLink) {
          linkId = issuerLink;
        } else {
          // Merge: move redeemer's group into issuer's group, drop the empty one.
          await client.query(
            `UPDATE account_link_members SET link_id = $1 WHERE link_id = $2`,
            [issuerLink, redeemerLink],
          );
          await client.query(`DELETE FROM account_links WHERE id = $1`, [redeemerLink]);
          linkId = issuerLink;
        }
      } else if (issuerLink) {
        linkId = issuerLink;
      } else if (redeemerLink) {
        linkId = redeemerLink;
      } else {
        linkId = randomUUID();
        await client.query(`INSERT INTO account_links (id) VALUES ($1)`, [linkId]);
      }

      await this.upsertMemberTx(client, linkId, input.issuer);
      await this.upsertMemberTx(client, linkId, input.redeemer);

      await client.query("COMMIT");
      return { ok: true, linkId };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private static async upsertMemberTx(
    client: PoolClient,
    linkId: string,
    identity: { platform: LinkPlatform; userKey: string; wallet: string | null },
  ): Promise<void> {
    await client.query(
      `INSERT INTO account_link_members (link_id, platform, user_key, wallet_address)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (platform, user_key) DO UPDATE SET
         link_id = EXCLUDED.link_id,
         wallet_address = COALESCE(EXCLUDED.wallet_address, account_link_members.wallet_address)`,
      [linkId, identity.platform, identity.userKey, identity.wallet ? identity.wallet.toLowerCase() : null],
    );
  }

  /**
   * Resolve the full set of wallet addresses for the link group that contains
   * (platform, userKey). Returns an empty array when the identity is not linked
   * to anything. iMessage members also contribute their stored service address.
   */
  static async getLinkedWallets(
    platform: LinkPlatform,
    userKey: string,
  ): Promise<string[]> {
    const membership = await this.getMembership(platform, userKey);
    if (!membership) return [];

    const members = await db.query<AccountLinkMemberRow>(
      `SELECT * FROM account_link_members WHERE link_id = $1`,
      [membership.link_id],
    );

    const wallets = new Set<string>();
    for (const member of members.rows) {
      if (member.wallet_address && ADDRESS_RE.test(member.wallet_address)) {
        wallets.add(member.wallet_address.toLowerCase());
      }
      if (member.platform === "imessage") {
        const im = await db.query<{ address: string | null }>(
          `SELECT address FROM imessage_wallets WHERE sender_id = $1`,
          [member.user_key],
        );
        const row = im.rows[0];
        if (row?.address && ADDRESS_RE.test(row.address)) wallets.add(row.address.toLowerCase());
      }
    }
    return [...wallets];
  }

  /**
   * All members of the link group that contains (platform, userKey), including
   * the identity itself. Empty when the identity is not linked to anything.
   * Used to resolve a canonical owner across platforms (e.g. a Telegram user's
   * linked XMTP inbox for VibeTrading).
   */
  static async getGroupMembers(
    platform: LinkPlatform,
    userKey: string,
  ): Promise<AccountLinkMemberRow[]> {
    const membership = await this.getMembership(platform, userKey);
    if (!membership) return [];
    const members = await db.query<AccountLinkMemberRow>(
      `SELECT * FROM account_link_members WHERE link_id = $1`,
      [membership.link_id],
    );
    return members.rows;
  }

  /** True when the identity belongs to a link group with more than one member. */
  static async isLinked(platform: LinkPlatform, userKey: string): Promise<boolean> {
    const membership = await this.getMembership(platform, userKey);
    if (!membership) return false;
    const count = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM account_link_members WHERE link_id = $1`,
      [membership.link_id],
    );
    return Number(count.rows[0]?.count ?? "0") > 1;
  }
}
