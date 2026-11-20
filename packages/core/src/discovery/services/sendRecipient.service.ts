import { UserAdapter } from "@/discovery/adapters/user.adapter.js";
import {
  basenameBareLabel,
  resolveBasename,
  resolveEnsNameForward,
} from "@/discovery/services/basename.util.js";

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/i;
const ETHEREUM_KIND = 0;
const MEMBER_BASENAME_CONCURRENCY = 8;

export type GroupMemberLike = {
  inboxId: string;
  accountIdentifiers: Array<{ identifierKind: number; identifier: string }>;
};

export type ConversationMembersLike = {
  sync?: () => Promise<void>;
  members?: () => Promise<GroupMemberLike[]>;
};

export type XmtpPreferencesLike = {
  inboxStateFromInboxIds?: (
    inboxIds: string[],
    refreshFromNetwork?: boolean,
  ) => Promise<
    Array<{
      inboxId: string;
      identifiers?: Array<{ identifierKind: number; identifier: string }>;
    }>
  >;
};

/** Kept for XMTP probe script; not used for send resolution. */
export interface ResolveSendRecipientCtx {
  userMessage?: string;
  conversation?: ConversationMembersLike;
  client?: { preferences?: XmtpPreferencesLike };
}

export type GroupMemberProfile = {
  inboxId: string;
  wallet: string | null;
  basename: string | null;
  basenameLabel: string | null;
};

const BARE_HANDLE_ERROR =
  "Recipients must be a full basename (name.base.eth) or a 0x address — bare @handles are not supported.";

function normalizeRecipientInput(raw: string): string {
  return raw.trim().replace(/^@+/, "");
}

/** True for full ENS/Basenames only — never bare labels or other TLDs. */
function isEnsOrBasename(raw: string): boolean {
  return /\.(base\.)?eth$/i.test(raw);
}

function isValidSendRecipient(raw: string): boolean {
  const t = normalizeRecipientInput(raw);
  if (!t) return false;
  if (ETH_ADDRESS_RE.test(t)) return true;
  return isEnsOrBasename(t);
}

function ethFromIdentifiers(
  identifiers: Array<{ identifierKind: number; identifier: string }> | undefined,
): string | null {
  const eth = identifiers?.find(
    (id) =>
      id.identifierKind === ETHEREUM_KIND &&
      typeof id.identifier === "string" &&
      ETH_ADDRESS_RE.test(id.identifier),
  );
  return eth?.identifier.toLowerCase() ?? null;
}

function memberEthAddress(member: GroupMemberLike): string | null {
  return ethFromIdentifiers(member.accountIdentifiers);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** For debugging — reverse basename per group member wallet. */
export async function buildGroupMemberProfiles(
  members: GroupMemberLike[],
  client?: ResolveSendRecipientCtx["client"],
): Promise<GroupMemberProfile[]> {
  const wallets = await resolveMemberWalletMap(members, client);
  const entries = [...wallets.entries()];

  return mapWithConcurrency(entries, MEMBER_BASENAME_CONCURRENCY, async ([inboxId, wallet]) => {
    const basename = await resolveBasename(wallet);
    const basenameLabel = basename ? basenameBareLabel(basename) : null;
    return {
      inboxId,
      wallet,
      basename,
      basenameLabel,
    } satisfies GroupMemberProfile;
  });
}

export async function resolveMemberWalletMap(
  members: GroupMemberLike[],
  client?: ResolveSendRecipientCtx["client"],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const needsNetwork: string[] = [];
  const needsDb: string[] = [];

  for (const member of members) {
    const eth = memberEthAddress(member);
    if (eth) {
      map.set(member.inboxId, eth);
    } else {
      needsNetwork.push(member.inboxId);
    }
  }

  if (needsNetwork.length > 0 && client?.preferences?.inboxStateFromInboxIds) {
    try {
      const states = await client.preferences.inboxStateFromInboxIds(needsNetwork, true);
      for (const state of states) {
        if (map.has(state.inboxId)) continue;
        const eth = ethFromIdentifiers(state.identifiers);
        if (eth) map.set(state.inboxId, eth);
        else needsDb.push(state.inboxId);
      }
    } catch {
      needsDb.push(...needsNetwork.filter((id) => !map.has(id)));
    }
  } else {
    needsDb.push(...needsNetwork.filter((id) => !map.has(id)));
  }

  if (needsDb.length > 0) {
    const dbWallets = await UserAdapter.getWalletAddressesByInboxIds(needsDb);
    for (const [inboxId, addr] of dbWallets) {
      if (!map.has(inboxId)) map.set(inboxId, addr);
    }
  }

  return map;
}

/**
 * Resolve a send recipient: 0x address or full basename/ENS only (.base.eth / .eth).
 */
export async function resolveSendRecipient(
  to: string,
  _ctx?: ResolveSendRecipientCtx,
): Promise<{ address: string; display: string } | { error: string }> {
  const trimmed = normalizeRecipientInput(to);
  if (!trimmed) {
    return { error: "missing recipient" };
  }

  if (ETH_ADDRESS_RE.test(trimmed)) {
    // Show a shortened address in labels (0x2113…663c) rather than the full
    // 42-char string — cleaner for non-crypto users. Contact sends override this
    // with the saved name downstream.
    const shortened = `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
    return { address: trimmed.toLowerCase(), display: shortened };
  }

  if (!isEnsOrBasename(trimmed)) {
    return { error: BARE_HANDLE_ERROR };
  }

  const resolved = await resolveEnsNameForward(trimmed);
  if (resolved) return { address: resolved, display: trimmed };

  return {
    error: `couldn't resolve "${trimmed}" to a wallet address. check the basename or paste a 0x address.`,
  };
}

/** Whether a parsed send recipient string is allowed before calling resolveSendRecipient. */
export function isAllowedSendRecipient(raw: string): boolean {
  return isValidSendRecipient(raw);
}
