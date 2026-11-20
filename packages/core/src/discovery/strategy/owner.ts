/**
 * Strategy ownership — dual platform.
 *
 * A strategy (and its isolated `cp-` execution wallet) is owned by EITHER:
 *  - an XMTP inbox id (Base App users), or
 *  - a Telegram user id (Telegram-native users).
 *
 * Each owner gets their own isolated custodial wallet derived from
 * `(platform, key)` (see `strategyUserWalletName`). Telegram-native users do NOT
 * need a Base App account — the Telegram identity is the canonical owner. The
 * two surfaces coexist: XMTP-owned and Telegram-owned strategies live side by
 * side, distinguished by how `creator_inbox_id` is encoded.
 */

/** XMTP inbox ids are 64 hex chars. Telegram user ids are numeric. */
const XMTP_INBOX_ID_RE = /^[0-9a-f]{64}$/i;
/** Prefix stored in `creator_inbox_id` for Telegram-owned strategies. */
export const TELEGRAM_OWNER_PREFIX = "tg:";

export type OwnerPlatform = "xmtp" | "telegram";

export type StrategyOwner =
  | { platform: "xmtp"; inboxId: string }
  | { platform: "telegram"; userId: string };

export function isXmtpInboxId(value: string | null | undefined): value is string {
  return typeof value === "string" && XMTP_INBOX_ID_RE.test(value.trim());
}

/** Encode an owner into the value stored in `strategies.creator_inbox_id`. */
export function encodeStrategyOwner(owner: StrategyOwner): string {
  return owner.platform === "xmtp"
    ? owner.inboxId
    : `${TELEGRAM_OWNER_PREFIX}${owner.userId}`;
}

/** Parse a stored owner key back into a StrategyOwner. Throws on unknown shapes. */
export function parseStrategyOwner(ownerKey: string): StrategyOwner {
  const key = (ownerKey ?? "").trim();
  if (key.startsWith(TELEGRAM_OWNER_PREFIX)) {
    const userId = key.slice(TELEGRAM_OWNER_PREFIX.length);
    if (!userId) throw new Error("empty telegram owner id");
    return { platform: "telegram", userId };
  }
  if (isXmtpInboxId(key)) return { platform: "xmtp", inboxId: key };
  throw new Error(`unrecognized strategy owner key: "${String(ownerKey).slice(0, 16)}…"`);
}

/** The (platform, userKey) used to derive the owner's isolated cp- wallet. */
export function ownerWalletIdentity(owner: StrategyOwner): {
  platform: OwnerPlatform;
  userKey: string;
} {
  return owner.platform === "xmtp"
    ? { platform: "xmtp", userKey: owner.inboxId }
    : { platform: "telegram", userKey: owner.userId };
}

export type CanonicalOwnerResult =
  | { ok: true; owner: StrategyOwner; ownerKey: string }
  | { ok: false; reason: "invalid_inbox" | "unsupported"; message: string };

/**
 * Resolve the canonical owner for a caller on a given surface.
 *  - `xmtp`: the userKey is the inbox id (validated for shape).
 *  - `telegram`: the Telegram user is its own canonical owner — no Base App
 *    account or linking required.
 */
export function resolveCanonicalStrategyOwner(input: {
  platform: OwnerPlatform;
  userKey: string;
}): CanonicalOwnerResult {
  if (input.platform === "xmtp") {
    if (!isXmtpInboxId(input.userKey)) {
      return { ok: false, reason: "invalid_inbox", message: "expected an XMTP inbox id" };
    }
    const owner: StrategyOwner = { platform: "xmtp", inboxId: input.userKey.trim() };
    return { ok: true, owner, ownerKey: encodeStrategyOwner(owner) };
  }
  if (input.platform === "telegram") {
    if (!input.userKey.trim()) {
      return { ok: false, reason: "unsupported", message: "missing telegram user id" };
    }
    const owner: StrategyOwner = { platform: "telegram", userId: input.userKey.trim() };
    return { ok: true, owner, ownerKey: encodeStrategyOwner(owner) };
  }
  return { ok: false, reason: "unsupported", message: "unsupported owner platform" };
}
