import { createHash } from "node:crypto";

import { StrategyAdapter } from "@/discovery/adapters/strategy.adapter.js";
import {
  getOrCreateStrategySmartWallet,
  getOrCreateUserWallet,
  isCdpEnabled,
  isStrategyPaymasterEnabled,
} from "@/wallet/cdp.js";

import { ownerWalletIdentity, parseStrategyOwner } from "./owner.js";

export interface ResolvedExecutionWallet {
  walletName: string;
  walletAddress: string;
}

export type StrategyWalletPlatform = "xmtp" | "telegram" | "imessage" | "whatsapp";

/** User-facing name for the automated PerpMate / strategy CDP wallet (not Base App). */
export const BASEMATE_WALLET_LABEL = "Basemate wallet";

/** Optional override for local/dev — e.g. cp-6760e41bee74448d0abba2c34b577a */
const STRATEGY_WALLET_NAME_OVERRIDE = process.env.STRATEGY_WALLET_NAME?.trim() || "";

export function strategyUserWalletName(
  platform: StrategyWalletPlatform,
  userKey: string,
): string {
  const hash = createHash("sha256").update(`${platform}:${userKey}`).digest("hex");
  return `cp-${hash.slice(0, 30)}`;
}

async function resolveNamedStrategyWallet(walletName: string): Promise<ResolvedExecutionWallet> {
  // Paymaster mode: always return the smart account address (funding target).
  // Legacy: return the named EOA address.
  if (isStrategyPaymasterEnabled() && walletName.startsWith("cp-")) {
    const smart = await getOrCreateStrategySmartWallet(walletName);
    return { walletName, walletAddress: smart.walletAddress };
  }
  const walletAddress = (await getOrCreateUserWallet(walletName)).address;
  return { walletName, walletAddress };
}

/**
 * Per-user Basemate CDP wallet (`cp-...`) used by strategy execution.
 *
 * When STRATEGY_USE_CDP_PAYMASTER=true, walletAddress is the CDP smart account
 * (not the owner EOA). Callers that persist execution_wallet_address should
 * re-bind when this address changes.
 */
export async function resolveBasemateServerWallet(
  platform: StrategyWalletPlatform,
  userKey: string,
): Promise<ResolvedExecutionWallet | null> {
  if (!isCdpEnabled()) return null;

  if (STRATEGY_WALLET_NAME_OVERRIDE) {
    return resolveNamedStrategyWallet(STRATEGY_WALLET_NAME_OVERRIDE);
  }

  if (platform === "xmtp") {
    const existing = await StrategyAdapter.getExistingExecutionWallet(userKey);
    if (existing?.walletName) {
      // Always re-resolve when paymaster is on so a cached EOA is not trusted.
      if (isStrategyPaymasterEnabled() && existing.walletName.startsWith("cp-")) {
        return resolveNamedStrategyWallet(existing.walletName);
      }
      const walletAddress =
        existing.walletAddress && /^0x[a-fA-F0-9]{40}$/.test(existing.walletAddress)
          ? existing.walletAddress
          : (await getOrCreateUserWallet(existing.walletName)).address;
      return { walletName: existing.walletName, walletAddress };
    }
  }

  const walletName = strategyUserWalletName(platform, userKey);
  return resolveNamedStrategyWallet(walletName);
}

/**
 * Per-owner isolated CDP wallet for strategy execution.
 *
 * The owner key is the value stored in `strategies.creator_inbox_id`: either a
 * raw XMTP inbox id (Base App owners) or a `tg:<userId>` key (Telegram-native
 * owners). Each resolves to that owner's own isolated `cp-` wallet. Returns null
 * when the key is unrecognized so callers fail safe rather than throw.
 */
export async function resolveCreatorExecutionWallet(
  ownerKey: string,
): Promise<ResolvedExecutionWallet | null> {
  let identity: { platform: StrategyWalletPlatform; userKey: string };
  try {
    identity = ownerWalletIdentity(parseStrategyOwner(ownerKey));
  } catch {
    return null;
  }
  return resolveBasemateServerWallet(identity.platform, identity.userKey);
}

export function shortAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
