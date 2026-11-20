import { AccountLinkAdapter, type LinkPlatform } from "./adapter.js";

export { AccountLinkAdapter } from "./adapter.js";
export type { LinkPlatform, AccountLinkMemberRow, ConnectionTokenRow } from "./adapter.js";
export {
  initiateLink,
  redeemLink,
  extractConnectionToken,
  normalizeToken,
  LINK_TOKEN_TTL_MS,
  type LinkIdentity,
  type RedeemResult,
} from "./service.js";
export {
  handleAccountLinkCommand,
  isAccountLinkConnectIntent,
  type AccountLinkCommandInput,
  type AccountLinkCommandResult,
} from "./commands.js";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** Short, human-friendly label for a wallet (e.g. `0x1234…abcd`). */
export function shortWalletLabel(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * Resolve the full, deduped set of wallet addresses to analyze for a user:
 * their own wallet plus every wallet from any account they've linked. Returns
 * lowercased addresses. When nothing is linked, this is just the self wallet.
 */
export async function resolveAllWalletsForUser(
  platform: LinkPlatform,
  userKey: string,
  selfWallet?: string | null,
): Promise<string[]> {
  const wallets = new Set<string>();
  if (selfWallet && ADDRESS_RE.test(selfWallet)) wallets.add(selfWallet.toLowerCase());
  try {
    for (const wallet of await AccountLinkAdapter.getLinkedWallets(platform, userKey)) {
      if (ADDRESS_RE.test(wallet)) wallets.add(wallet.toLowerCase());
    }
  } catch (err) {
    // Best-effort: linking is an enhancement, never block the main flow on it
    // (e.g. the table may not exist yet before migrations run).
    console.error("⚠️ resolveAllWalletsForUser failed; using self wallet only:", err);
  }
  return [...wallets];
}
