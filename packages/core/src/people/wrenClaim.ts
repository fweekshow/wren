// Wren claim links: the link a sender texts a friend after a send.
//
// /c/<code> unfurls in iMessage and WhatsApp into a card ("Mateo sent you
// $50 of Apple"), and its page sends the friend into the Wren app to claim.
// The page never completes a claim itself: the friend claims by signing into
// Wren with that phone number (Privy proves the number), after which the
// escrow release poller pays the stock out to their Wren account.
//
// Codes are random, so gift ids and phone numbers never appear in a link.

import { randomBytes } from "node:crypto";

import { db } from "@/discovery/db.js";
import { listSpotBuyableOffers } from "@/discovery/doppler/stockCatalog.js";
import { claimStateFromEscrowStatus } from "@/portfolio/claimState.js";
import { StockGiftAdapter, type StockGiftRow } from "@/wallet/stockGift.js";
import { PhoneEscrowAdapter } from "@/wallet/phoneEscrow.js";
import { config } from "@/config/config.js";
import { ContactsAdapter } from "@/messaging/contacts.adapter.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { senderIdLookupKeys } from "@/messaging/utils/senderId.utils.js";

const DEFAULT_ORIGIN = "https://wren-production-a91c91ca.up.railway.app";

export function wrenPublicOrigin(): string {
  return (process.env.WREN_PUBLIC_ORIGIN?.trim() || DEFAULT_ORIGIN).replace(/\/$/, "");
}

let ready: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  ready ??= db
    .query(
      `CREATE TABLE IF NOT EXISTS wren_claim_links (
         code       TEXT PRIMARY KEY,
         gift_id    TEXT NOT NULL UNIQUE,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    )
    .then(() => undefined)
    .catch((err) => {
      ready = null;
      throw err;
    });
  return ready;
}

const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newClaimCode(length = 10): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export const isClaimCode = (code: string): boolean => /^[A-Za-z0-9]{6,20}$/.test(code);

/** The gift's code, made on first ask. */
export async function claimCodeFor(giftId: string): Promise<string> {
  await ensureTable();
  const { rows } = await db.query(
    `INSERT INTO wren_claim_links (code, gift_id) VALUES ($1, $2)
     ON CONFLICT (gift_id) DO UPDATE SET gift_id = EXCLUDED.gift_id
     RETURNING code`,
    [newClaimCode(), giftId],
  );
  return String((rows[0] as { code: string }).code);
}

export async function claimLink(giftId: string): Promise<string> {
  return `${wrenPublicOrigin()}/c/${await claimCodeFor(giftId)}`;
}

export async function giftForCode(code: string): Promise<StockGiftRow | null> {
  if (!isClaimCode(code)) return null;
  await ensureTable();
  const { rows } = await db.query(`SELECT gift_id FROM wren_claim_links WHERE code = $1`, [code]);
  const id = (rows[0] as { gift_id?: string } | undefined)?.gift_id;
  return id ? StockGiftAdapter.get(id) : null;
}

// ── The card ─────────────────────────────────────────────────────────────────

export type CardState = "waiting" | "claimed" | "returned" | "sending" | "delivered";

export type ClaimCard = {
  giftId: string;
  /** Sender's first name when we know it, else null ("You've been sent…"). */
  from: string | null;
  amount: string;
  stockName: string;
  ticker: string;
  colors: { bg: string; ink: string; soft: string };
  state: CardState;
  holdHours: number;
};

// Same palette and fixed picks as the app (apps/mobile/src/theme.ts).
const PALETTE = [
  { bg: "#0050FA", ink: "#FFFFFF", soft: "#BCCDFB" },
  { bg: "#C6F432", ink: "#0A0B0D", soft: "#3A3D44" },
  { bg: "#FFB199", ink: "#0A0B0D", soft: "#3A3D44" },
  { bg: "#B9A7FF", ink: "#0A0B0D", soft: "#3A3D44" },
  { bg: "#7FE0C2", ink: "#0A0B0D", soft: "#3A3D44" },
  { bg: "#FF8A3D", ink: "#0A0B0D", soft: "#3A3D44" },
  { bg: "#0A0B0D", ink: "#FFFFFF", soft: "#A7ADB8" },
];
const FIXED: Record<string, number> = { AAPL: 0, NVDA: 1, TSLA: 2, META: 3, MSFT: 4, AMZN: 5, GOOGL: 6, MSTR: 3, SNDK: 4, SPCX: 6 };

export function stockCardColors(symbol: string): ClaimCard["colors"] {
  const t = symbol.replace(/c$/, "").toUpperCase();
  const i = FIXED[t] ?? [...t].reduce((a, ch) => a + ch.charCodeAt(0), 0) % PALETTE.length;
  return PALETTE[i];
}

export function amountText(intent: StockGiftRow["intent"]): string {
  if (intent.usd) {
    const n = Number(intent.usd);
    return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
  }
  if (intent.qty) return `${intent.qty} ${Number(intent.qty) === 1 ? "share" : "shares"}`;
  return "";
}

export function cardState(row: Pick<StockGiftRow, "giftTxHash">, escrowStatus: string | null): CardState {
  if (!row.giftTxHash) return "sending";
  const claim = claimStateFromEscrowStatus(escrowStatus);
  if (claim === "claimed") return "claimed";
  if (claim === "returned") return "returned";
  return "waiting";
}

// Words people save a contact under that mean something only to them.
const RELATION = new Set([
  "mom", "mum", "mama", "mother", "dad", "papa", "father", "bro", "brother", "sis", "sister",
  "babe", "baby", "honey", "love", "wife", "husband", "hubby", "grandma", "grandpa", "nana",
  "son", "daughter", "uncle", "aunt", "auntie", "cousin", "me",
]);

/**
 * What the recipient should see as the sender's name, from shared contacts:
 * 1. what the recipient saved the sender as (if they're on Wren: "Mom"),
 * 2. the sender's profile name,
 * 3. the first name most of the sender's friends saved them under,
 *    skipping relationship words ("Mom" in a sibling's phone isn't a name).
 */
async function senderFirstName(senderId: string, recipientPhone: string | null): Promise<string | null> {
  const first = (name: string | null | undefined) => {
    const t = String(name ?? "").trim().split(/\s+/)[0] ?? "";
    return t && !/^\+?\d/.test(t) ? t : null;
  };
  try {
    if (recipientPhone) {
      const saved = await ContactsAdapter.findByPhone(recipientPhone, senderId).catch(() => null);
      if (saved?.name?.trim()) return saved.name.trim();
    }
    const profile = await WalletAdapter.getDisplayName(senderId).catch(() => null);
    if (first(profile)) return first(profile);
    const keys = senderIdLookupKeys(senderId);
    const { rows } = await db.query(
      `SELECT name, COUNT(DISTINCT contact_owner) AS n FROM imessage_contacts
        WHERE contact_phone = ANY($1) AND name IS NOT NULL
        GROUP BY name ORDER BY n DESC LIMIT 10`,
      [keys],
    );
    for (const r of rows as { name: string }[]) {
      const f = first(r.name);
      if (f && !RELATION.has(f.toLowerCase())) return f;
    }
    const { rows: wa } = await db.query(
      `SELECT whatsapp_display_name AS name FROM imessage_wallets WHERE sender_id = $1 LIMIT 1`,
      [senderId],
    );
    return first((wa[0] as { name?: string } | undefined)?.name);
  } catch {
    return null;
  }
}

export async function cardFor(row: StockGiftRow): Promise<ClaimCard> {
  const symbol = String(row.intent.symbol ?? "");
  const offer = listSpotBuyableOffers().find((o) => o.symbol === symbol);
  const escrows = row.giftTxHash
    ? await PhoneEscrowAdapter.listByDepositTxHashes(row.senderId, [row.giftTxHash]).catch(() => [])
    : [];
  return {
    giftId: row.id,
    from: await senderFirstName(
      row.senderId,
      (row.intent.recipient as { phone?: string | null } | undefined)?.phone ?? null,
    ),
    amount: amountText(row.intent),
    stockName: offer?.name ?? symbol.replace(/c$/, ""),
    ticker: symbol.replace(/c$/, ""),
    colors: stockCardColors(symbol),
    // Sent to someone already on Wren: no claim, it's in their account.
    state:
      row.giftTxHash && (row.intent.recipient as { kind?: string } | undefined)?.kind === "wallet"
        ? "delivered"
        : cardState(row, escrows[0]?.status ?? null),
    holdHours: config.phoneEscrow.claimTtlHours,
  };
}

/** "Mateo sent you $50 of Apple" / "You've been sent $50 of Apple". */
export function cardTitle(card: Pick<ClaimCard, "from" | "amount" | "stockName">): string {
  const what = card.amount ? `${card.amount} of ${card.stockName}` : card.stockName;
  return card.from ? `${card.from} sent you ${what}` : `You've been sent ${what}`;
}

export function cardLine(card: Pick<ClaimCard, "state" | "from" | "holdHours">): string {
  switch (card.state) {
    case "claimed":
      return "Already claimed.";
    case "delivered":
      return "It's in your Wren account.";
    case "returned":
      return `This one went back to ${card.from ?? "the sender"}.`;
    case "sending":
      return "On its way. Open Wren to claim it.";
    default:
      return `Claim it on Wren within ${card.holdHours >= 24 ? `${Math.round(card.holdHours / 24)} days` : `${card.holdHours} hours`}.`;
  }
}
