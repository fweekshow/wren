// Connect codes: the one text a person sends Wren to turn on iMessage or
// WhatsApp. The app pre-fills "Hey Wren 👋 my code is 4F2K9Q"; when it lands, the
// channel is on for the number it came from.
//
// It also finishes sign-in outside the US. Those people sign in with Privy
// email, so we don't know their number yet. Their code is created with the
// pending Privy account, and the number that sends it becomes the account.
// No codes are sent by Wren and no Privy messaging is involved.

import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { db } from "@/discovery/db.js";
import { markOptIn, setPrivyUserId } from "@/messaging/wrenAccount.js";
import { canonicalizeSenderId } from "@/messaging/utils/senderId.utils.js";
import { logger } from "@/utils/logger.js";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const CODE_LENGTH = 6;
const CODE_TTL_MS = 30 * 60 * 1000;
const WALLET_DELEGATION_MS = 365 * 24 * 60 * 60 * 1000;

export type Channel = "imessage" | "whatsapp";

export type PendingAccount = {
  privyUserId: string;
  walletId: string;
  address: string;
};

export type ConnectCode = { code: string; secret: string; expiresAt: string };

let ready: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  ready ??= db
    .query(
      `CREATE TABLE IF NOT EXISTS wren_connect_codes (
         code TEXT PRIMARY KEY,
         secret TEXT NOT NULL,
         owner_phone TEXT,
         privy_user_id TEXT,
         wallet_id TEXT,
         address TEXT,
         phone TEXT,
         channel TEXT,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         expires_at TIMESTAMPTZ NOT NULL,
         used_at TIMESTAMPTZ
       )`,
    )
    .then(() => undefined);
  return ready;
}

function newCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** A signed-in person (owner: their phone), or an email sign-in waiting for a number. */
export async function createConnectCode(
  owner: { phone: string } | { pending: PendingAccount },
): Promise<ConnectCode> {
  await ensureTable();
  const secret = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  const ownerPhone = "phone" in owner ? canonicalizeSenderId(owner.phone) : null;
  const pending = "pending" in owner ? owner.pending : null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    const result = await db.query(
      `INSERT INTO wren_connect_codes (code, secret, owner_phone, privy_user_id, wallet_id, address, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (code) DO NOTHING`,
      [
        code,
        secret,
        ownerPhone,
        pending?.privyUserId ?? null,
        pending?.walletId ?? null,
        pending?.address?.toLowerCase() ?? null,
        expiresAt,
      ],
    );
    if ((result.rowCount ?? 0) > 0) return { code, secret, expiresAt: expiresAt.toISOString() };
  }
  throw new Error("Could not create a connect code.");
}

export function connectPrefill(code: string | null): string {
  return code ? `Hey Wren 👋 my code is ${code}` : "Chirp";
}

// A short text that mentions Wren and carries a code in capitals, e.g.
// "Hey Wren 👋 my code is 47RW8M" or the older "Turn on Wren · 47RW8M".
const CODE_TOKEN = new RegExp(`(?:^|[^A-Za-z0-9])([${ALPHABET}]{${CODE_LENGTH}})(?![A-Za-z0-9])`);

/** "Chirp" (older builds), or a short text mentioning Wren with a connect code. */
export function parseConnectText(text: string): { matched: boolean; code: string | null } {
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === "chirp") return { matched: true, code: null };
  if (/^turn on wren[\s.!]*$/i.test(trimmed)) return { matched: true, code: null };
  if (trimmed.length > 80 || !/\bwren\b/i.test(trimmed)) return { matched: false, code: null };
  const match = CODE_TOKEN.exec(trimmed);
  return match ? { matched: true, code: match[1]! } : { matched: false, code: null };
}

export type ConnectCapture = "not-connect" | "on" | "bad-code";

/**
 * Called for every inbound text that might be a connect text. Anything that
 * parses as one gets a reply from Wren, never the assistant.
 */
export async function captureConnectText(args: {
  senderId: string;
  text: string;
  channel: Channel;
  service?: string | null;
  displayName?: string | null;
}): Promise<ConnectCapture> {
  const parsed = parseConnectText(args.text);
  if (!parsed.matched) return "not-connect";
  const phone = canonicalizeSenderId(args.senderId);
  let codeUsed = false;
  if (parsed.code) {
    try {
      codeUsed = await consumeConnectCode(parsed.code, phone, args.channel);
    } catch (err) {
      logger.warn({ err }, "wren connect code");
    }
  }
  const optedIn = await markOptIn({
    phone,
    channel: args.channel,
    service: args.service ?? null,
    displayName: args.displayName ?? null,
  });
  if (!codeUsed && !optedIn) return parsed.code ? "bad-code" : "not-connect";
  return "on";
}

/** What Wren texts back. */
export function connectReply(result: Exclude<ConnectCapture, "not-connect">): string {
  return result === "on"
    ? "You're all set 👋 Stocks people send you on Wren will land right here."
    : "Hmm, that code didn't work. Open Wren and tap the chat again for a fresh one.";
}

/** True when the code was valid and is now used. */
async function consumeConnectCode(code: string, phone: string, channel: Channel): Promise<boolean> {
  await ensureTable();
  // A signed-in person's code only counts from their own number.
  const result = await db.query<{
    privy_user_id: string | null;
    wallet_id: string | null;
    address: string | null;
    owner_phone: string | null;
  }>(
    `UPDATE wren_connect_codes
        SET used_at = NOW(), phone = $2, channel = $3
      WHERE code = $1
        AND used_at IS NULL
        AND expires_at > NOW()
        AND (owner_phone IS NULL OR owner_phone = $2)
      RETURNING privy_user_id, wallet_id, address, owner_phone`,
    [code, phone, channel],
  );
  const row = result.rows[0];
  if (!row) return false;
  if (row.owner_phone || !row.privy_user_id) return true;

  // Email sign-in: this number becomes the account.
  if (row.address?.startsWith("0x")) {
    await WalletAdapter.setEmbeddedWallet(phone, {
      cdpUserId: row.wallet_id || row.privy_user_id,
      address: row.address,
      delegationId: "privy",
      delegationExpiresAt: new Date(Date.now() + WALLET_DELEGATION_MS),
    });
  } else {
    await WalletAdapter.ensureProfile(await WalletAdapter.resolveSenderKey(phone));
  }
  await setPrivyUserId(phone, row.privy_user_id);
  return true;
}

export type PollResult =
  | { status: "waiting" }
  | { status: "expired" }
  | { status: "done"; phone: string };

/** The app polls this while it waits for the text. The secret never leaves the app. */
export async function pollConnectCode(code: string, secret: string): Promise<PollResult> {
  await ensureTable();
  const result = await db.query<{
    secret: string;
    privy_user_id: string | null;
    owner_phone: string | null;
    phone: string | null;
    used_at: Date | null;
    expires_at: Date;
  }>(
    `SELECT secret, privy_user_id, owner_phone, phone, used_at, expires_at
       FROM wren_connect_codes WHERE code = $1 LIMIT 1`,
    [code.toUpperCase()],
  );
  const row = result.rows[0];
  if (!row || !sameSecret(row.secret, secret)) return { status: "expired" };
  if (row.used_at && row.phone) {
    if (row.owner_phone) return { status: "done", phone: row.owner_phone };
    const linked = await db.query(
      `SELECT 1 FROM imessage_wallets WHERE sender_id = $1 AND privy_user_id = $2 LIMIT 1`,
      [row.phone, row.privy_user_id],
    );
    return (linked.rowCount ?? 0) > 0 ? { status: "done", phone: row.phone } : { status: "expired" };
  }
  if (row.expires_at.getTime() < Date.now()) return { status: "expired" };
  return { status: "waiting" };
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
