import { asc, inArray, sql } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import { db } from "@/discovery/db.js";
import { imessageContacts } from "@/db/schema/index.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import {
  isExactContactNameToken,
  normalizeContactNameKey,
  scoreFuzzyContactName,
} from "@/messaging/utils/fuzzyName.utils.js";
import { senderIdLookupKeys } from "@/messaging/utils/senderId.utils.js";

export interface ContactRow {
  id: number;
  name: string;
  /**
   * FK to imessage_wallets(sender_id): the wallet of the user who owns this
   * contact book entry (the sender who saved it).
   */
  contact_owner: string;
  /**
   * FK to imessage_wallets(sender_id): the contact's own custodial wallet,
   * keyed on their canonical E.164 handle. This sender_id IS the contact's
   * phone number. Null for name-only contacts that have no inbound handle to
   * key a reusable wallet on (those can't receive sends).
   */
  contact: string | null;
  /** Normalized E.164 phone for escrow matching; does not require a wallet row. */
  contact_phone: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ResolvedContact {
  address: string;
  phone: string | null;
  /** Reserved for callers that distinguish freshly-provisioned recipients. */
  isNew: boolean;
}

function mapContactRow(row: {
  id: number;
  name: string;
  contactOwner: string;
  contact: string | null;
  contactPhone: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}): ContactRow {
  return {
    id: row.id,
    name: row.name,
    contact_owner: row.contactOwner,
    contact: row.contact ?? null,
    contact_phone: row.contactPhone ?? null,
    created_at: row.createdAt ?? new Date(),
    updated_at: row.updatedAt ?? new Date(),
  };
}

/**
 * Stores iMessage contacts shared by a sender via vCard or chat.
 *
 * The table is fully normalized against imessage_wallets:
 *  - `contact_owner` is the owner's wallet (sender_id).
 *  - `contact_phone` is the contact's E.164 phone (soft-links to wallets.sender_id).
 *  - Receive address is read from imessage_wallets (embedded → base_app), never
 *    from a separate profiles mirror.
 */
export class ContactsAdapter {
  /** @deprecated Tables are now managed via Drizzle migrations. */
  static async createTable(): Promise<void> {
    // Retain the one-time data migration for existing installs.
    await this.migrateToRelations();
  }

  /**
   * One-time migration from the legacy denormalized schema
   * (owner_sender_id / phone / email / wallet_address) to the relation-only
   * schema. Backfills `contact_owner` / `contact` from the legacy columns, then
   * drops them. Guarded on the presence of `owner_sender_id` so it is a no-op
   * (and safe to run on every startup) once the migration has happened.
   */
  static async migrateToRelations(): Promise<void> {
    try {
      const legacy = await db.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'imessage_contacts'
           AND column_name = 'owner_sender_id'`,
      );
      if ((legacy.rowCount ?? 0) === 0) return; // already migrated / fresh install

      await db.query(`
        ALTER TABLE imessage_contacts
          ADD COLUMN IF NOT EXISTS contact_owner TEXT
            REFERENCES imessage_wallets(sender_id)
      `);
      await db.query(`
        ALTER TABLE imessage_contacts
          ADD COLUMN IF NOT EXISTS contact TEXT
            REFERENCES imessage_wallets(sender_id)
      `);
      await db.query(`
        ALTER TABLE imessage_contacts
          ADD COLUMN IF NOT EXISTS contact_phone TEXT
      `);
      const owners = await db.query(
        `UPDATE imessage_contacts c
         SET contact_owner = c.owner_sender_id
         FROM imessage_wallets w
         WHERE c.contact_owner IS NULL
           AND c.owner_sender_id = w.sender_id`,
      );
      const contacts = await db.query(
        `UPDATE imessage_contacts c
         SET contact_phone = regexp_replace(c.phone, '[^0-9+]', '', 'g'),
             contact = w.sender_id
         FROM imessage_wallets w
         WHERE c.contact IS NULL
           AND c.phone IS NOT NULL
           AND regexp_replace(c.phone, '[^0-9+]', '', 'g') = w.sender_id`,
      );
      await db.query(
        `UPDATE imessage_contacts
         SET contact_phone = regexp_replace(phone, '[^0-9+]', '', 'g')
         WHERE contact_phone IS NULL
           AND phone IS NOT NULL
           AND regexp_replace(phone, '[^0-9+]', '', 'g') ~ '^\\+[0-9]{7,15}$'`,
      );
      await db.query(`DROP INDEX IF EXISTS idx_imessage_contacts_owner_phone`);
      await db.query(`DROP INDEX IF EXISTS idx_imessage_contacts_owner_name`);
      await db.query(`DROP INDEX IF EXISTS idx_imessage_contacts_contact_owner`);
      await db.query(`ALTER TABLE imessage_contacts DROP COLUMN IF EXISTS email`);
      await db.query(`ALTER TABLE imessage_contacts DROP COLUMN IF EXISTS wallet_address`);
      await db.query(`ALTER TABLE imessage_contacts DROP COLUMN IF EXISTS phone`);
      await db.query(`ALTER TABLE imessage_contacts DROP COLUMN IF EXISTS owner_sender_id`);

      console.log(
        `imessage_contacts migrated to relation-only schema (linked ${owners.rowCount ?? 0} owner(s), ${contacts.rowCount ?? 0} contact(s)).`,
      );
    } catch (error) {
      console.error("Error migrating imessage_contacts to relation schema:", error);
    }
  }

  /**
   * Canonicalize a phone number to the exact E.164 form iMessage delivers an
   * inbound sender handle in (`+<countrycode><number>`) — so a contact's wallet
   * is keyed on precisely the handle the recipient will arrive with when they
   * first text the bot, and the funds land in the wallet they'll reuse.
   *
   * Returns null when the number has no leading country code (`+`): we can't
   * reliably guess one, and keying on a wrong handle would both strand the
   * funds and provision a duplicate wallet on the recipient's first message.
   *
   * Digit-only Spectrum handles are canonicalized at ingest via
   * {@link canonicalizeSenderId} — contact-card / chat saves still require `+`.
   */
  static normalizeHandle(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const cleaned = raw.replace(/[^\d+]/g, "");
    // Strict E.164 only. We deliberately do NOT infer a country code from a bare
    // number: a wrong guess (e.g. a 10-digit UK number treated as US +1) would
    // lock escrowed funds against a phone hash the real recipient can never
    // match, stranding the money. Callers must reject numbers without a "+".
    return /^\+\d{7,15}$/.test(cleaned) ? cleaned : null;
  }

  /**
   * Upsert a contact into the sender's contact book.
   *
   * Partial unique indexes (`WHERE contact_phone IS NOT NULL`) require raw SQL
   * for the ON CONFLICT clause since Drizzle doesn't support conditional indexes
   * in `onConflictDoUpdate` yet.
   */
  static async saveContact(
    ownerSenderId: string,
    name: string,
    phone?: string,
  ): Promise<void> {
    try {
      const ownerKey = await WalletAdapter.resolveSenderKey(ownerSenderId);
      await WalletAdapter.ensureProfile(ownerKey);
      const handle = this.normalizeHandle(phone);
      if (handle) {
        await db.query(
          `INSERT INTO imessage_contacts (name, contact_owner, contact_phone)
           VALUES ($1, $2, $3)
           ON CONFLICT (contact_owner, contact_phone) WHERE contact_phone IS NOT NULL
           DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()`,
          [name, ownerKey, handle],
        );
      } else {
        await drizzleDb.insert(imessageContacts).values({ name, contactOwner: ownerKey });
      }
    } catch (error) {
      console.error("Error saving contact:", error);
      throw error;
    }
  }

  /**
   * Look up a contact by name (case-insensitive exact match).
   * Returns the first matching row for the given owner, or null if not found.
   */
  static async findByName(
    ownerSenderId: string,
    name: string,
  ): Promise<ContactRow | null> {
    try {
      const ownerKeys = senderIdLookupKeys(ownerSenderId);
      if (ownerKeys.length === 0) return null;
      const rows = await drizzleDb
        .select()
        .from(imessageContacts)
        .where(
          sql`${inArray(imessageContacts.contactOwner, ownerKeys)}
              AND lower(${imessageContacts.name}) = lower(${name})`,
        )
        .orderBy(asc(imessageContacts.createdAt))
        .limit(1);
      const row = rows[0];
      return row ? mapContactRow(row) : null;
    } catch (error) {
      console.error("Error finding contact by name:", error);
      return null;
    }
  }

  /**
   * Owner-scoped fuzzy name match. Exact match is preferred; otherwise scores
   * candidates and returns the best unique hit, or multiple when ambiguous.
   */
  static async findByNameFuzzy(
    ownerSenderId: string,
    name: string,
  ): Promise<{ matches: ContactRow[]; ambiguous: boolean }> {
    const contacts = await this.listContacts(ownerSenderId);
    const queryKey = normalizeContactNameKey(name);
    if (!queryKey) return { matches: [], ambiguous: false };

    // Prefer complete saved-name matches, but never silently pick the first row
    // when two different contacts were saved under the same full name.
    const exactFullNameMatches = contacts.filter(
      (contact) => normalizeContactNameKey(contact.name) === queryKey,
    );
    if (exactFullNameMatches.length > 0) {
      return {
        matches: exactFullNameMatches,
        ambiguous: exactFullNameMatches.length > 1,
      };
    }

    // A single word can be either a first or last name. Treat all exact token
    // matches as equally valid so "send Alex..." cannot select Alex Smith over
    // Alex Jones merely because one full name happens to be shorter.
    const exactTokenMatches = contacts.filter((contact) =>
      isExactContactNameToken(name, contact.name),
    );
    if (exactTokenMatches.length > 0) {
      return {
        matches: exactTokenMatches,
        ambiguous: exactTokenMatches.length > 1,
      };
    }

    const scored = contacts
      .map((c) => {
        const score = scoreFuzzyContactName(name, c.name);
        return score ? { contact: c, score } : null;
      })
      .filter((x): x is { contact: ContactRow; score: NonNullable<ReturnType<typeof scoreFuzzyContactName>> } => !!x)
      .sort((a, b) => a.score.rank - b.score.rank || a.score.distance - b.score.distance);

    if (scored.length === 0) return { matches: [], ambiguous: false };

    const best = scored[0]!;
    const ties = scored.filter(
      (s) => s.score.rank === best.score.rank && s.score.distance === best.score.distance,
    );
    // Distinct phones/names at the same score → ambiguous
    const uniqueKeys = new Set(
      ties.map((t) => `${t.contact.name.toLowerCase()}|${t.contact.contact_phone ?? t.contact.contact ?? ""}`),
    );
    if (uniqueKeys.size > 1) {
      return { matches: ties.map((t) => t.contact), ambiguous: true };
    }
    return { matches: [best.contact], ambiguous: false };
  }

  /** Look up the name an owner saved for a contact's canonical phone handle. */
  static async findByPhone(
    ownerSenderId: string,
    phone: string,
  ): Promise<ContactRow | null> {
    const handle = this.normalizeHandle(phone);
    const phoneKeys = handle ? senderIdLookupKeys(handle) : senderIdLookupKeys(phone);
    if (phoneKeys.length === 0) return null;
    try {
      const ownerKeys = senderIdLookupKeys(ownerSenderId);
      if (ownerKeys.length === 0) return null;
      const rows = await drizzleDb
        .select()
        .from(imessageContacts)
        .where(
          sql`${inArray(imessageContacts.contactOwner, ownerKeys)}
              AND (
                ${inArray(imessageContacts.contactPhone, phoneKeys)}
                OR ${inArray(imessageContacts.contact, phoneKeys)}
              )`,
        )
        .orderBy(asc(imessageContacts.createdAt))
        .limit(1);
      const row = rows[0];
      return row ? mapContactRow(row) : null;
    } catch (error) {
      console.error("Error finding contact by phone:", error);
      return null;
    }
  }

  /** Batch lookup saved names by phone for dashboard feeds. */
  static async findByPhones(
    ownerSenderId: string,
    phones: string[],
  ): Promise<Map<string, ContactRow>> {
    const map = new Map<string, ContactRow>();
    const normalized = [
      ...new Set(
        phones
          .map((p) => this.normalizeHandle(p) ?? p)
          .filter(Boolean) as string[],
      ),
    ];
    if (!normalized.length) return map;
    const ownerKeys = senderIdLookupKeys(ownerSenderId);
    if (ownerKeys.length === 0) return map;
    try {
      const rows = await drizzleDb
        .select()
        .from(imessageContacts)
        .where(
          sql`${inArray(imessageContacts.contactOwner, ownerKeys)}
              AND (
                ${inArray(imessageContacts.contactPhone, normalized)}
                OR ${inArray(imessageContacts.contact, normalized)}
              )`,
        );
      for (const row of rows) {
        const c = mapContactRow(row);
        const phone = c.contact_phone ?? c.contact;
        if (phone) map.set(phone, c);
      }
    } catch (error) {
      console.error("Error finding contacts by phones:", error);
    }
    return map;
  }

  /** List every contact saved by a given owner, oldest first. */
  static async listContacts(ownerSenderId: string): Promise<ContactRow[]> {
    try {
      const ownerKeys = senderIdLookupKeys(ownerSenderId);
      if (ownerKeys.length === 0) return [];
      const rows = await drizzleDb
        .select()
        .from(imessageContacts)
        .where(inArray(imessageContacts.contactOwner, ownerKeys))
        .orderBy(asc(imessageContacts.createdAt));
      return rows.map(mapContactRow);
    } catch (error) {
      console.error("Error listing contacts:", error);
      return [];
    }
  }

  /**
   * Resolve the receive wallet address for a named contact.
   *
   * Joins the contact book against imessage_wallets on contact_phone so any
   * Basemate user with an embedded wallet can be paid directly.
   */
  static async resolveWallet(
    ownerSenderId: string,
    name: string,
  ): Promise<ResolvedContact | null> {
    try {
      const ownerKeys = senderIdLookupKeys(ownerSenderId);
      if (ownerKeys.length === 0) return null;
      const result = await db.query<{ address: string; phone: string | null }>(
        `SELECT NULLIF(w.embedded_address, '') AS address,
                COALESCE(c.contact_phone, c.contact) AS phone
         FROM imessage_contacts c
         JOIN imessage_wallets w
           ON w.sender_id = COALESCE(c.contact_phone, c.contact)
           OR (
             COALESCE(c.contact_phone, c.contact) IS NOT NULL
             AND (
               w.sender_id = '+' || regexp_replace(COALESCE(c.contact_phone, c.contact), '[^0-9]', '', 'g')
               OR regexp_replace(w.sender_id, '[^0-9]', '', 'g')
                  = regexp_replace(COALESCE(c.contact_phone, c.contact), '[^0-9]', '', 'g')
             )
           )
         WHERE c.contact_owner = ANY($1::text[])
           AND lower(c.name) = lower($2)
           AND (w.embedded_address ~ '^0x[a-fA-F0-9]{40}$')
         ORDER BY c.created_at ASC
         LIMIT 1`,
        [ownerKeys, name],
      );
      const row = result.rows[0];
      return row ? { address: row.address, phone: row.phone, isNew: false } : null;
    } catch (error) {
      console.error("Error resolving contact wallet:", error);
      return null;
    }
  }

  /**
   * Reverse-lookup a saved contact by their linked receive wallet address.
   * Keeps send confirms human (name + phone) even when the recipient was
   * already rewritten to a 0x address.
   */
  static async findByWalletAddress(
    ownerSenderId: string,
    walletAddress: string,
  ): Promise<ContactRow | null> {
    const addr = walletAddress.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;
    try {
      const ownerKeys = senderIdLookupKeys(ownerSenderId);
      if (ownerKeys.length === 0) return null;
      const result = await db.query<{
        id: number;
        name: string;
        contact_owner: string;
        contact: string | null;
        contact_phone: string | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT c.id,
                c.name,
                c.contact_owner,
                c.contact,
                c.contact_phone,
                c.created_at,
                c.updated_at
         FROM imessage_contacts c
         JOIN imessage_wallets w
           ON w.sender_id = COALESCE(c.contact_phone, c.contact)
           OR (
             COALESCE(c.contact_phone, c.contact) IS NOT NULL
             AND regexp_replace(w.sender_id, '[^0-9]', '', 'g')
                 = regexp_replace(COALESCE(c.contact_phone, c.contact), '[^0-9]', '', 'g')
           )
         WHERE c.contact_owner = ANY($1::text[])
           AND lower(w.embedded_address) = $2
         ORDER BY c.created_at ASC
         LIMIT 1`,
        [ownerKeys, addr],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        name: row.name,
        contact_owner: row.contact_owner,
        contact: row.contact,
        contact_phone: row.contact_phone,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    } catch (error) {
      console.error("Error finding contact by wallet address:", error);
      return null;
    }
  }
}
