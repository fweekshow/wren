import { db } from "@/discovery/db.js";
import { canonicalizeSenderId } from "@/messaging/utils/senderId.utils.js";

let ready: Promise<void> | null = null;

export function ensureWrenColumns(): Promise<void> {
  ready ??= db
    .query(
      `ALTER TABLE imessage_wallets
         ADD COLUMN IF NOT EXISTS privy_user_id TEXT,
         ADD COLUMN IF NOT EXISTS imessage_opted_in_at TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS imessage_service TEXT,
         ADD COLUMN IF NOT EXISTS whatsapp_opted_in_at TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS whatsapp_display_name TEXT,
         ADD COLUMN IF NOT EXISTS push_tokens JSONB NOT NULL DEFAULT '[]'::jsonb`,
    )
    .then(() => undefined);
  return ready;
}

export type ConnectState = {
  phone: string;
  imessageOptedInAt: string | null;
  imessageService: string | null;
  whatsappOptedInAt: string | null;
  whatsappDisplayName: string | null;
};

export async function readConnectState(senderId: string): Promise<ConnectState | null> {
  await ensureWrenColumns();
  const phone = canonicalizeSenderId(senderId);
  const result = await db.query<{
    sender_id: string;
    imessage_opted_in_at: Date | null;
    imessage_service: string | null;
    whatsapp_opted_in_at: Date | null;
    whatsapp_display_name: string | null;
  }>(
    `SELECT sender_id, imessage_opted_in_at, imessage_service, whatsapp_opted_in_at, whatsapp_display_name
       FROM imessage_wallets WHERE sender_id = $1 LIMIT 1`,
    [phone],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    phone: row.sender_id,
    imessageOptedInAt: row.imessage_opted_in_at?.toISOString() ?? null,
    imessageService: row.imessage_service,
    whatsappOptedInAt: row.whatsapp_opted_in_at?.toISOString() ?? null,
    whatsappDisplayName: row.whatsapp_display_name,
  };
}

export async function setPrivyUserId(senderId: string, privyUserId: string): Promise<void> {
  await ensureWrenColumns();
  await db.query(`UPDATE imessage_wallets SET privy_user_id = $2 WHERE sender_id = $1`, [
    canonicalizeSenderId(senderId),
    privyUserId,
  ]);
}

/** The account a Privy user already has, if any (email sign-ins come back here). */
export async function phoneForPrivyUser(privyUserId: string): Promise<string | null> {
  await ensureWrenColumns();
  const result = await db.query<{ sender_id: string }>(
    `SELECT sender_id FROM imessage_wallets WHERE privy_user_id = $1 LIMIT 1`,
    [privyUserId],
  );
  return result.rows[0]?.sender_id ?? null;
}

/** Turns a channel on for a number. False when the number has no account. */
export async function markOptIn(args: {
  phone: string;
  channel: "imessage" | "whatsapp";
  service?: string | null;
  displayName?: string | null;
}): Promise<boolean> {
  try {
    await ensureWrenColumns();
    const phone = canonicalizeSenderId(args.phone);
    if (args.channel === "whatsapp") {
      const result = await db.query(
        `UPDATE imessage_wallets
            SET whatsapp_opted_in_at = COALESCE(whatsapp_opted_in_at, NOW()),
                whatsapp_display_name = COALESCE($2, whatsapp_display_name)
          WHERE sender_id = $1`,
        [phone, args.displayName ?? null],
      );
      return (result.rowCount ?? 0) > 0;
    }
    const result = await db.query(
      `UPDATE imessage_wallets
          SET imessage_opted_in_at = COALESCE(imessage_opted_in_at, NOW()),
              imessage_service = COALESCE($2, imessage_service, 'iMessage')
        WHERE sender_id = $1`,
      [phone, args.service ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Older builds text "Chirp". Kept for callers that still import it. */
export async function captureChirp(args: {
  senderId: string;
  text: string;
  channel: "imessage" | "whatsapp";
  service?: string | null;
  displayName?: string | null;
}): Promise<boolean> {
  if (args.text.trim().toLowerCase() !== "chirp") return false;
  return markOptIn({ phone: args.senderId, channel: args.channel, service: args.service, displayName: args.displayName });
}

export async function clearOptIn(senderId: string, channel: "imessage" | "whatsapp"): Promise<void> {
  await ensureWrenColumns();
  const phone = canonicalizeSenderId(senderId);
  if (channel === "whatsapp") {
    await db.query(
      `UPDATE imessage_wallets
          SET whatsapp_opted_in_at = NULL, whatsapp_display_name = NULL
        WHERE sender_id = $1`,
      [phone],
    );
    return;
  }
  await db.query(
    `UPDATE imessage_wallets SET imessage_opted_in_at = NULL, imessage_service = NULL WHERE sender_id = $1`,
    [phone],
  );
}

export async function addPushToken(senderId: string, token: string): Promise<void> {
  await ensureWrenColumns();
  await db.query(
    `UPDATE imessage_wallets
        SET push_tokens = (
          SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
            FROM jsonb_array_elements_text(push_tokens || to_jsonb($2::text)) AS value
        )
      WHERE sender_id = $1`,
    [canonicalizeSenderId(senderId), token],
  );
}

export async function listPushTokens(senderId: string): Promise<string[]> {
  await ensureWrenColumns();
  const result = await db.query<{ push_tokens: string[] | null }>(
    `SELECT push_tokens FROM imessage_wallets WHERE sender_id = $1 LIMIT 1`,
    [canonicalizeSenderId(senderId)],
  );
  const raw = result.rows[0]?.push_tokens;
  return Array.isArray(raw) ? raw.filter((token) => typeof token === "string") : [];
}

export async function outboundChannel(phone: string): Promise<"whatsapp" | "imessage" | "template"> {
  const state = await readConnectState(phone);
  if (state?.whatsappOptedInAt) return "whatsapp";
  if (state?.imessageOptedInAt) return "imessage";
  return "template";
}
