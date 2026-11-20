import { resolveBasename } from "@/discovery/services/basename.util.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";

/**
 * Thin façade over `imessage_wallets` (formerly `basemate_user_profiles`).
 *
 * Kept so existing call sites (handler, app router) keep working while identity
 * lives solely on the wallets table.
 */
export class UserProfileAdapter {
  /**
   * Ensure the user row exists and touch last_active_at.
   * Fire-and-forget safe — never throws to the caller.
   */
  static async ensureProfile(senderId: string): Promise<void> {
    try {
      await WalletAdapter.ensureProfile(senderId);
    } catch (err) {
      console.error("[UserProfileAdapter] ensureProfile failed:", err);
    }
  }

  /**
   * Called after a user connects an embedded receive wallet.
   * Receive address is already on wallets; this caches basename async.
   * Fire-and-forget safe — never throws to the caller.
   */
  static async onWalletLinked(senderId: string, walletAddress: string): Promise<void> {
    try {
      await WalletAdapter.ensureProfile(senderId);
    } catch (err) {
      console.error("[UserProfileAdapter] onWalletLinked (ensure) failed:", err);
    }
    void UserProfileAdapter.cacheBasename(senderId, walletAddress);
  }

  /**
   * Reverse-resolves the wallet address to a basename and caches it on wallets.
   */
  static async cacheBasename(senderId: string, walletAddress: string): Promise<void> {
    try {
      const basename = await resolveBasename(walletAddress);
      if (!basename) return;
      await WalletAdapter.setBasename(senderId, basename);
    } catch (err) {
      console.error("[UserProfileAdapter] cacheBasename failed:", err);
    }
  }

  /**
   * Look up a registered Basemate user by their E.164 phone / handle.
   *
   * `isFullyRegistered` means they have a receive address (embedded or Base App).
   * Returns null if the phone has never been seen by Basemate.
   */
  static async getByPhone(
    phone: string,
  ): Promise<{ walletAddress: string | null; basename: string | null; isFullyRegistered: boolean } | null> {
    try {
      const identity = await WalletAdapter.getIdentity(phone);
      if (!identity) return null;
      return {
        walletAddress: identity.receiveAddress,
        basename: identity.basename,
        isFullyRegistered: Boolean(identity.receiveAddress),
      };
    } catch (err) {
      console.error("[UserProfileAdapter] getByPhone failed:", err);
      return null;
    }
  }
}
