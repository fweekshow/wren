import { randomBytes } from "node:crypto";

import { AccountLinkAdapter, type LinkPlatform } from "./adapter.js";

/** Connection strings are valid for five minutes. */
export const LINK_TOKEN_TTL_MS = 5 * 60 * 1000;

const TOKEN_PREFIX = "BM-";
// Crockford-style alphabet (no I, L, O, U, 0, 1) to avoid copy/paste ambiguity.
const TOKEN_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const TOKEN_BODY_LEN = 20;
const TOKEN_RE = new RegExp(`${TOKEN_PREFIX}[${TOKEN_ALPHABET}]{${TOKEN_BODY_LEN}}`, "i");

export interface LinkIdentity {
  platform: LinkPlatform;
  userKey: string;
  wallet?: string | null;
}

export type RedeemResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "expired" | "consumed" | "self" };

function generateTokenString(): string {
  const bytes = randomBytes(TOKEN_BODY_LEN);
  let body = "";
  for (let i = 0; i < bytes.length; i++) {
    body += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  }
  return `${TOKEN_PREFIX}${body}`;
}

/** Normalize a pasted token so casing/whitespace differences still match. */
export function normalizeToken(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Extract a connection string from arbitrary user text, if present. */
export function extractConnectionToken(text: string): string | null {
  const match = text.match(TOKEN_RE);
  return match ? normalizeToken(match[0]) : null;
}

/**
 * Create a one-time connection string for the requesting identity. The raw
 * token is returned exactly once; only its hash is persisted.
 */
export async function initiateLink(identity: LinkIdentity): Promise<string> {
  const token = generateTokenString();
  await AccountLinkAdapter.insertToken({
    token,
    platform: identity.platform,
    userKey: identity.userKey,
    walletAddress: identity.wallet ?? null,
    expiresAt: new Date(Date.now() + LINK_TOKEN_TTL_MS),
  });
  return token;
}

/**
 * Verify a pasted connection string and link the redeeming identity to the
 * issuer. Rejects invalid/expired/already-consumed tokens and self-links.
 */
export async function redeemLink(args: {
  token: string;
  redeemer: LinkIdentity;
}): Promise<RedeemResult> {
  const token = normalizeToken(args.token);
  const row = await AccountLinkAdapter.getTokenByValue(token);
  if (!row) return { ok: false, reason: "invalid" };
  if (row.consumed_at) return { ok: false, reason: "consumed" };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: "expired" };

  if (row.platform === args.redeemer.platform && row.user_key === args.redeemer.userKey) {
    return { ok: false, reason: "self" };
  }

  const result = await AccountLinkAdapter.redeemAndLink({
    token,
    issuer: { platform: row.platform, userKey: row.user_key, wallet: row.wallet_address },
    redeemer: {
      platform: args.redeemer.platform,
      userKey: args.redeemer.userKey,
      wallet: args.redeemer.wallet ?? null,
    },
  });
  if (!result.ok) return { ok: false, reason: "consumed" };
  return { ok: true };
}
