import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import { imessageWallets } from "@/db/schema/index.js";
import { canonicalizeSenderId, senderIdLookupKeys } from "@/messaging/utils/senderId.utils.js";
import { getOrCreateUserWallet } from "@/wallet/cdp.js";
import { logger } from "@/utils/logger.js";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * True when a stored value is a usable on-chain address. Profile rows are
 * seeded with an empty address (`ensureProfile`), and bad data can leave a
 * blank/whitespace value behind — both must be treated as "no wallet yet" so
 * they get re-provisioned rather than silently flowing into transactions.
 */
function isUsableAddress(value: string | null | undefined): value is string {
  return !!value && ADDRESS_RE.test(value.trim());
}

export interface UserWallet {
  /** The custodial wallet's Base address. */
  address: string;
  /** CDP account name (derived from the iMessage sender id). */
  accountName: string;
  /** True only when the wallet was just provisioned (first message). */
  isNew: boolean;
}

/**
 * Maps an iMessage sender id to a custodial CDP server wallet.
 *
 * iMessage sender ids (phone numbers, emails, GUIDs) are not valid CDP account
 * names, so we derive a deterministic, collision-resistant name and persist the
 * mapping in Postgres. `getOrCreate` provisions the wallet on first contact.
 */
export class WalletAdapter {
  /** @deprecated Tables are now managed via Drizzle migrations. */
  static async createTable(): Promise<void> {}

  /**
   * Derive a CDP-safe account name from a sender id. CDP names must be 2-36
   * chars of [a-zA-Z0-9-]; we use a stable hash prefix to satisfy that.
   */
  static accountNameFor(senderId: string): string {
    const hash = createHash("sha256").update(senderId).digest("hex");
    return `im-${hash.slice(0, 30)}`; // 33 chars total
  }

  /** Resolve the canonical DB key for a sender, preferring an existing row. */
  static async resolveSenderKey(senderId: string): Promise<string> {
    const keys = senderIdLookupKeys(senderId);
    if (keys.length === 0) return canonicalizeSenderId(senderId) || senderId.trim();
    try {
      const row = await drizzleDb.query.imessageWallets.findFirst({
        columns: { senderId: true },
        where: (w, { inArray }) => inArray(w.senderId, keys),
        orderBy: (w, { desc }) => desc(w.lastActiveAt),
      });
      if (row?.senderId) return row.senderId;
    } catch (error) {
      logger.error({ err: error }, "Error resolving sender key");
    }
    return canonicalizeSenderId(senderId) || keys[0]!;
  }

  /** Return an existing iMessage wallet without provisioning a new one. */
  static async findBySenderId(senderId: string): Promise<Omit<UserWallet, "isNew"> | null> {
    try {
      const keys = senderIdLookupKeys(senderId);
      if (keys.length === 0) return null;
      const row = await drizzleDb.query.imessageWallets.findFirst({
        columns: { accountName: true, address: true },
        where: (w, { inArray }) => inArray(w.senderId, keys),
        orderBy: (w, { desc }) => desc(w.lastActiveAt),
      });
      return isUsableAddress(row?.address)
        ? { address: row!.address.trim(), accountName: row!.accountName }
        : null;
    } catch (error) {
      logger.error({ err: error }, "Error fetching iMessage wallet");
      return null;
    }
  }

  /**
   * Ensure the iMessage profile row exists without provisioning a CDP wallet.
   * Embedded-wallet flows use this row to store contact ownership and wallet
   * connection metadata.
   */
  static async ensureProfile(senderId: string): Promise<void> {
    const key = await this.resolveSenderKey(senderId);
    const accountName = this.accountNameFor(key);
    await drizzleDb
      .insert(imessageWallets)
      .values({ senderId: key, accountName, address: "" })
      .onConflictDoUpdate({
        target: imessageWallets.senderId,
        set: { lastActiveAt: sql`NOW()` },
      });
  }

  /**
   * Return the user's wallet, provisioning it on first contact. `isNew` is true
   * only when the wallet was created during this call (used to trigger
   * onboarding). Touches last_active_at on every call.
   */
  static async getOrCreate(senderId: string): Promise<UserWallet> {
    const key = await this.resolveSenderKey(senderId);
    const existing = await drizzleDb.query.imessageWallets.findFirst({
      where: (w, { eq }) => eq(w.senderId, key),
    });

    if (existing) {
      if (!isUsableAddress(existing.address)) {
        const accountName = existing.accountName || this.accountNameFor(key);
        const { address } = await getOrCreateUserWallet(accountName);
        await drizzleDb
          .update(imessageWallets)
          .set({ address, accountName, lastActiveAt: sql`NOW()` })
          .where(eq(imessageWallets.senderId, key));
        return { address, accountName, isNew: true };
      }
      // A wallet provisioned because someone sent the user funds before they
      // ever texted: treat their first message as a new user (so they get the
      // welcome + their funded address) and clear the flag so it fires once.
      const firstTouch = existing.provisionedViaContact === true;
      await drizzleDb
        .update(imessageWallets)
        .set({ lastActiveAt: sql`NOW()`, provisionedViaContact: false })
        .where(eq(imessageWallets.senderId, key));
      return { address: existing.address, accountName: existing.accountName || this.accountNameFor(key), isNew: firstTouch };
    }

    const accountName = this.accountNameFor(key);
    const { address } = await getOrCreateUserWallet(accountName);

    // ON CONFLICT guards against a race where two messages provision at once.
    await drizzleDb
      .insert(imessageWallets)
      .values({ senderId: key, accountName, address })
      .onConflictDoNothing();

    return { address, accountName, isNew: true };
  }

  /**
   * Provision (or fetch) the custodial wallet for a recipient identified by
   * their iMessage handle (phone/email), used when someone sends them funds
   * before they've ever texted the bot. It is keyed by the handle in
   * `imessage_wallets` — exactly the row `getOrCreate` returns on their first
   * message — so the funds land in the same wallet they'll reuse, regardless of
   * who sent them or in what order. Flagged so that first message is welcomed.
   */
  static async getOrCreateForHandle(handle: string): Promise<{ address: string }> {
    const key = await this.resolveSenderKey(handle);
    const existing = await this.findBySenderId(key);
    if (existing) return { address: existing.address };

    const accountName = this.accountNameFor(key);
    const { address } = await getOrCreateUserWallet(accountName);
    await drizzleDb
      .insert(imessageWallets)
      .values({ senderId: key, accountName, address, provisionedViaContact: true })
      .onConflictDoNothing();
    return { address };
  }

  /** Look up the CDP account name for a sender id, if a wallet exists. */
  static async getAccountName(senderId: string): Promise<string | null> {
    try {
      const key = await this.resolveSenderKey(senderId);
      const row = await drizzleDb.query.imessageWallets.findFirst({
        columns: { accountName: true },
        where: (w, { eq }) => eq(w.senderId, key),
      });
      return row?.accountName ?? null;
    } catch (error) {
      logger.error({ err: error }, "Error fetching wallet account name");
      return null;
    }
  }

  /** Return the user-owned display name used in contact-send notifications. */
  static async getDisplayName(senderId: string): Promise<string | null> {
    try {
      const keys = senderIdLookupKeys(senderId);
      if (keys.length === 0) return null;
      const row = await drizzleDb.query.imessageWallets.findFirst({
        columns: { displayName: true },
        where: (w, { inArray }) => inArray(w.senderId, keys),
        orderBy: (w, { desc }) => desc(w.lastActiveAt),
      });
      return row?.displayName?.trim() || null;
    } catch (error) {
      logger.error({ err: error }, "Error fetching iMessage display name");
      return null;
    }
  }

  /** Persist a user-owned display name for future notifications. */
  static async setDisplayName(senderId: string, displayName: string): Promise<void> {
    const normalized = displayName.trim();
    if (!normalized) throw new Error("Display name cannot be empty");
    const key = await this.resolveSenderKey(senderId);
    await this.ensureProfile(key);
    await drizzleDb
      .update(imessageWallets)
      .set({ displayName: normalized })
      .where(eq(imessageWallets.senderId, key));
  }

  /**
   * The address that should RECEIVE funds for a user (escrow releases, claim
   * links, incoming sends). CDP Embedded Wallet is the only active wallet.
   */
  static async getReceiveAddress(senderId: string): Promise<string | null> {
    const embedded = await this.getEmbeddedWallet(senderId);
    if (embedded?.address && isUsableAddress(embedded.address)) return embedded.address;
    return null;
  }

  /**
   * Identity / registry view of a wallet row (no CDP provisioning).
   * Null when the handle has never been seen.
   */
  static async getIdentity(
    senderId: string,
  ): Promise<{
    senderId: string;
    basename: string | null;
    receiveAddress: string | null;
  } | null> {
    try {
      const keys = senderIdLookupKeys(senderId);
      if (keys.length === 0) return null;
      const row = await drizzleDb.query.imessageWallets.findFirst({
        columns: {
          senderId: true,
          basename: true,
          embeddedAddress: true,
        },
        where: (w, { inArray }) => inArray(w.senderId, keys),
        orderBy: (w, { desc }) => desc(w.lastActiveAt),
      });
      if (!row) return null;
      const embedded =
        row.embeddedAddress && isUsableAddress(row.embeddedAddress)
          ? row.embeddedAddress.trim()
          : null;
      return {
        senderId: row.senderId,
        basename: row.basename?.trim() || null,
        receiveAddress: embedded,
      };
    } catch (error) {
      logger.error({ err: error }, "Error fetching wallet identity");
      return null;
    }
  }

  /** Cached basename for a user, if known. */
  static async getBasename(senderId: string): Promise<string | null> {
    const identity = await this.getIdentity(senderId);
    return identity?.basename ?? null;
  }

  /** Persist a reverse-resolved basename on the user row. */
  static async setBasename(senderId: string, basename: string): Promise<void> {
    const normalized = basename.trim();
    if (!normalized) return;
    const key = await this.resolveSenderKey(senderId);
    await this.ensureProfile(key);
    await drizzleDb
      .update(imessageWallets)
      .set({ basename: normalized })
      .where(eq(imessageWallets.senderId, key));
  }

  /** Reverse lookup: sender_id that owns an embedded receive address. */
  static async findByReceiveAddress(address: string): Promise<string | null> {
    if (!isUsableAddress(address)) return null;
    const addr = address.trim().toLowerCase();
    try {
      const row = await drizzleDb.query.imessageWallets.findFirst({
        columns: { senderId: true },
        where: (w, { eq }) => eq(w.embeddedAddress, addr),
        orderBy: (w, { desc }) => desc(w.lastActiveAt),
      });
      return row?.senderId ?? null;
    } catch (error) {
      logger.error({ err: error }, "Error resolving sender by receive address");
      return null;
    }
  }

  /**
   * Embedded-wallet signing mode: 'manual' (confirm every tx) or 'quick'
   * (auto-execute up to the limit). Defaults to 'manual' when unset.
   */
  static async getEmbeddedPayMode(senderId: string): Promise<EmbeddedPayMode> {
    try {
      const key = await this.resolveSenderKey(senderId);
      const row = await drizzleDb.query.imessageWallets.findFirst({
        columns: { embeddedPayMode: true },
        where: (w, { eq }) => eq(w.senderId, key),
      });
      return row?.embeddedPayMode === "quick" ? "quick" : "manual";
    } catch (error) {
      logger.error({ err: error }, "Error fetching embedded pay mode");
      return "manual";
    }
  }

  static async setEmbeddedPayMode(senderId: string, mode: EmbeddedPayMode): Promise<void> {
    try {
      const key = await this.resolveSenderKey(senderId);
      await drizzleDb
        .update(imessageWallets)
        .set({ embeddedPayMode: mode })
        .where(eq(imessageWallets.senderId, key));
    } catch (error) {
      logger.error({ err: error }, "Error saving embedded pay mode");
    }
  }

  /** Per-transaction USD auto-approve ceiling (quick mode). Null = fall back to the default cap. */
  static async getAutoSendLimit(senderId: string): Promise<number | null> {
    try {
      const key = await this.resolveSenderKey(senderId);
      const row = await drizzleDb.query.imessageWallets.findFirst({
        columns: { autoSendLimitUsd: true },
        where: (w, { eq }) => eq(w.senderId, key),
      });
      const raw = row?.autoSendLimitUsd;
      if (raw == null) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    } catch (error) {
      logger.error({ err: error }, "Error fetching auto-send limit");
      return null;
    }
  }

  static async setAutoSendLimit(senderId: string, usd: number | null): Promise<void> {
    try {
      const key = await this.resolveSenderKey(senderId);
      await drizzleDb
        .update(imessageWallets)
        .set({ autoSendLimitUsd: usd == null ? null : usd.toFixed(2) })
        .where(eq(imessageWallets.senderId, key));
    } catch (error) {
      logger.error({ err: error }, "Error saving auto-send limit");
    }
  }

  /**
   * Reverse lookup: the senderId that owns an embedded wallet address. Deterministic
   * (most recently active wins) since two handles could in theory share an address.
   */
  static async findByEmbeddedAddress(address: string): Promise<string | null> {
    if (!isUsableAddress(address)) return null;
    try {
      const row = await drizzleDb.query.imessageWallets.findFirst({
        columns: { senderId: true },
        where: (w, { eq }) => eq(w.embeddedAddress, address.toLowerCase()),
        orderBy: (w, { desc }) => desc(w.lastActiveAt),
      });
      return row?.senderId ?? null;
    } catch (error) {
      logger.error({ err: error }, "Error resolving sender by embedded address");
      return null;
    }
  }

  /** Reverse lookup: the senderId that owns a CDP end-user id. */
  static async findByCdpUserId(cdpUserId: string): Promise<string | null> {
    if (!cdpUserId?.trim()) return null;
    try {
      const row = await drizzleDb.query.imessageWallets.findFirst({
        columns: { senderId: true },
        where: (w, { eq }) => eq(w.cdpUserId, cdpUserId.trim()),
        orderBy: (w, { desc }) => desc(w.lastActiveAt),
      });
      return row?.senderId ?? null;
    } catch (error) {
      logger.error({ err: error }, "Error resolving sender by CDP user id");
      return null;
    }
  }

  /** Read the user's Basemate Pay signing mode (Quick Pay vs Approve Each Time). */
  static async getPayMode(senderId: string): Promise<PayMode | null> {
    try {
      const key = await this.resolveSenderKey(senderId);
      const row = await drizzleDb.query.imessageWallets.findFirst({
        columns: { payMode: true },
        where: (w, { eq }) => eq(w.senderId, key),
      });
      const mode = row?.payMode;
      return mode === "quick" || mode === "manual" ? mode : null;
    } catch (error) {
      logger.error({ err: error }, "Error fetching pay mode");
      return null;
    }
  }

  /** Persist the user's Basemate Pay signing mode. */
  static async setPayMode(senderId: string, mode: PayMode): Promise<void> {
    try {
      const key = await this.resolveSenderKey(senderId);
      await drizzleDb
        .update(imessageWallets)
        .set({ payMode: mode })
        .where(eq(imessageWallets.senderId, key));
    } catch (error) {
      logger.error({ err: error }, "Error saving pay mode");
    }
  }

  /** Read the user's Basemate CDP embedded wallet + delegation, if connected. */
  static async getEmbeddedWallet(senderId: string): Promise<EmbeddedWalletRecord | null> {
    try {
      const keys = senderIdLookupKeys(senderId);
      if (keys.length === 0) return null;
      const row = await drizzleDb.query.imessageWallets.findFirst({
        columns: {
          cdpUserId: true,
          embeddedAddress: true,
          delegationId: true,
          delegationExpiresAt: true,
        },
        where: (w, { inArray }) => inArray(w.senderId, keys),
        orderBy: (w, { desc }) => desc(w.lastActiveAt),
      });
      if (!row?.cdpUserId || !row.embeddedAddress) return null;
      return {
        cdpUserId: row.cdpUserId,
        address: row.embeddedAddress,
        delegationId: row.delegationId ?? null,
        delegationExpiresAt: row.delegationExpiresAt ?? null,
      };
    } catch (error) {
      logger.error({ err: error }, "Error fetching embedded wallet");
      return null;
    }
  }

  /**
   * Persist the user's Basemate CDP embedded wallet + delegation grant.
   *
   * Refuses to repoint a handle at a different address once the old address has
   * launched a token: Doppler locks the launcher in as the 75% fee beneficiary
   * on-chain, so a rebind would orphan those fees behind a wallet the user can
   * no longer reach from this handle.
   */
  static async setEmbeddedWallet(senderId: string, record: EmbeddedWalletRecord): Promise<void> {
    const key = await this.resolveSenderKey(senderId);
    const nextAddress = record.address.toLowerCase();
    await this.assertEmbeddedRebindAllowed(key, nextAddress);

    try {
      await this.ensureProfile(key);
      await drizzleDb
        .update(imessageWallets)
        .set({
          cdpUserId: record.cdpUserId,
          embeddedAddress: nextAddress,
          delegationId: record.delegationId,
          delegationExpiresAt: record.delegationExpiresAt,
        })
        .where(eq(imessageWallets.senderId, key));
    } catch (error) {
      logger.error({ err: error }, "Error saving embedded wallet");
    }
  }

  /**
   * Throws EmbeddedRebindBlockedError when `key` already points at a different
   * embedded address that has a successful launch on record. A read failure is
   * non-fatal — we don't want a transient DB blip to block reconnecting.
   */
  private static async assertEmbeddedRebindAllowed(
    key: string,
    nextAddress: string,
  ): Promise<void> {
    let currentAddress: string | null = null;
    try {
      const row = await drizzleDb.query.imessageWallets.findFirst({
        columns: { embeddedAddress: true },
        where: (w, { eq }) => eq(w.senderId, key),
      });
      currentAddress = isUsableAddress(row?.embeddedAddress)
        ? row!.embeddedAddress!.trim().toLowerCase()
        : null;
    } catch (error) {
      logger.error({ err: error }, "Error reading embedded wallet before rebind");
      return;
    }
    if (!currentAddress || currentAddress === nextAddress) return;

    let hasLaunched = false;
    try {
      const { TokenLaunchAdapter } = await import("@/discovery/adapters/tokenLaunch.adapter.js");
      hasLaunched = await TokenLaunchAdapter.hasSuccessfulLaunch(currentAddress);
    } catch (error) {
      logger.error({ err: error }, "Error checking launch history before rebind");
      return;
    }
    if (!hasLaunched) return;

    throw new EmbeddedRebindBlockedError(currentAddress, nextAddress);
  }

  static async getSwearJarOptIn(senderId: string): Promise<boolean> {
    try {
      const key = await this.resolveSenderKey(senderId);
      const row = await drizzleDb.query.imessageWallets.findFirst({
        columns: { swearJarOptIn: true },
        where: (w, { eq }) => eq(w.senderId, key),
      });
      return row?.swearJarOptIn === true;
    } catch (error) {
      logger.error({ err: error }, "Error fetching swear jar opt-in");
      return false;
    }
  }

  static async setSwearJarOptIn(senderId: string, optIn: boolean): Promise<void> {
    const key = await this.resolveSenderKey(senderId);
    await this.ensureProfile(key);
    await drizzleDb
      .update(imessageWallets)
      .set({ swearJarOptIn: optIn })
      .where(eq(imessageWallets.senderId, key));
  }
}

/** Thrown when a handle with launched tokens tries to switch embedded wallets. */
export class EmbeddedRebindBlockedError extends Error {
  readonly currentAddress: string;
  readonly requestedAddress: string;
  constructor(currentAddress: string, requestedAddress: string) {
    super(
      `This Basemate handle is already linked to ${currentAddress}, which has launched a token. ` +
        `Doppler locked that address in as the fee beneficiary on-chain, so it can't be moved to ` +
        `${requestedAddress} — sign in with the original wallet, or contact support.`,
    );
    this.name = "EmbeddedRebindBlockedError";
    this.currentAddress = currentAddress;
    this.requestedAddress = requestedAddress;
  }
}

export type PayMode = "quick" | "manual";
export type EmbeddedPayMode = "manual" | "quick";
/** Default per-transaction USD auto-approve ceiling when the user hasn't set one. */
export const DEFAULT_AUTO_SEND_LIMIT_USD = 100;
export interface EmbeddedWalletRecord {
  cdpUserId: string;
  address: string;
  delegationId: string | null;
  delegationExpiresAt: Date | null;
}
