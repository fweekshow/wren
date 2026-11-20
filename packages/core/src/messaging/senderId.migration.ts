import { db } from "@/discovery/db.js";
import { config } from "@/config/config.js";
import { canonicalizeSenderId, isEmailHandle } from "@/messaging/utils/senderId.utils.js";
import { keccak256, toHex } from "viem";

/**
 * One-time / idempotent migration: rewrite digit-only Spectrum sender_ids to
 * canonical `+E.164`, cascade contact + escrow phone fields, and re-hash
 * pending escrow phone_hash values so claim release still matches.
 *
 * Safe to run on every startup.
 */
export class SenderIdMigration {
  static async migrate(): Promise<void> {
    try {
      await this.migrateWalletSenderIds();
      await this.migrateContactPhones();
      await this.migrateEscrowPhones();
    } catch (err) {
      console.error("[SenderIdMigration] failed:", err);
    }
  }

  private static async migrateWalletSenderIds(): Promise<void> {
    const result = await db.query<{ sender_id: string }>(
      `SELECT sender_id
       FROM imessage_wallets
       WHERE sender_id ~ '^[0-9]{7,15}$'`,
    );
    let moved = 0;
    for (const row of result.rows) {
      const oldId = row.sender_id;
      const newId = canonicalizeSenderId(oldId);
      if (!newId || newId === oldId || isEmailHandle(newId)) continue;

      const existing = await db.query(`SELECT 1 FROM imessage_wallets WHERE sender_id = $1`, [
        newId,
      ]);
      if ((existing.rowCount ?? 0) > 0) {
        // Prefer the canonical row: retarget contacts, then drop the legacy PK.
        await db.query(`UPDATE imessage_contacts SET contact_owner = $1 WHERE contact_owner = $2`, [
          newId,
          oldId,
        ]);
        await db.query(`UPDATE imessage_contacts SET contact = $1 WHERE contact = $2`, [
          newId,
          oldId,
        ]);
        await db.query(`DELETE FROM imessage_wallets WHERE sender_id = $1`, [oldId]);
        moved += 1;
        continue;
      }

      // Insert canonical copy, retarget FKs, delete old.
      await db.query(
        `INSERT INTO imessage_wallets (
           sender_id, account_name, address, display_name, basename,
           first_seen_at, last_active_at, tx_pref,
           pay_mode, embedded_pay_mode, auto_send_limit_usd,
           cdp_user_id, embedded_address, delegation_id, delegation_expires_at,
           provisioned_via_contact
         )
         SELECT
           $1, account_name, address, display_name, basename,
           first_seen_at, last_active_at, tx_pref,
           pay_mode, embedded_pay_mode, auto_send_limit_usd,
           cdp_user_id, embedded_address, delegation_id, delegation_expires_at,
           provisioned_via_contact
         FROM imessage_wallets
         WHERE sender_id = $2
         ON CONFLICT (sender_id) DO NOTHING`,
        [newId, oldId],
      );
      await db.query(`UPDATE imessage_contacts SET contact_owner = $1 WHERE contact_owner = $2`, [
        newId,
        oldId,
      ]);
      await db.query(`UPDATE imessage_contacts SET contact = $1 WHERE contact = $2`, [
        newId,
        oldId,
      ]);
      await db.query(`UPDATE imessage_phone_escrows SET sender_id = $1 WHERE sender_id = $2`, [
        newId,
        oldId,
      ]);
      await db.query(`DELETE FROM imessage_wallets WHERE sender_id = $1`, [oldId]);
      moved += 1;
    }
    if (moved > 0) {
      console.log(`[SenderIdMigration] remapped ${moved} wallet sender_id(s) to +E.164`);
    }
  }

  private static async migrateContactPhones(): Promise<void> {
    const result = await db.query(
      `UPDATE imessage_contacts
       SET contact_phone = '+' || contact_phone
       WHERE contact_phone ~ '^[0-9]{7,15}$'`,
    );
    if ((result.rowCount ?? 0) > 0) {
      console.log(`[SenderIdMigration] normalized ${result.rowCount} contact_phone value(s)`);
    }
  }

  private static async migrateEscrowPhones(): Promise<void> {
    if (!config.phoneEscrow?.phoneHashSalt) return;
    const result = await db.query<{
      id: number;
      recipient_phone: string;
    }>(
      `SELECT id, recipient_phone
       FROM imessage_phone_escrows
       WHERE recipient_phone ~ '^[0-9]{7,15}$'`,
    );

    let updated = 0;
    for (const row of result.rows) {
      const canonical = canonicalizeSenderId(row.recipient_phone);
      if (!canonical || !/^\+\d{7,15}$/.test(canonical) || canonical === row.recipient_phone) {
        continue;
      }
      const phoneHash = keccak256(toHex(`${config.phoneEscrow.phoneHashSalt}:${canonical}`));
      await db.query(
        `UPDATE imessage_phone_escrows
         SET recipient_phone = $1, phone_hash = $2, updated_at = now()
         WHERE id = $3`,
        [canonical, phoneHash, row.id],
      );
      updated += 1;
    }
    if (updated > 0) {
      console.log(`[SenderIdMigration] remapped ${updated} escrow recipient phone(s)`);
    }
  }
}
