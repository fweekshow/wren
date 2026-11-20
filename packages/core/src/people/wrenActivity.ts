// Activity: what you did with your money, newest first — sends and buys.
// Only you see it, so buys keep their dollar amount here (the shared "moves"
// feed never stores one).
//
// A send's state:
// sending    paid, Wren is buying and passing it over
// in_account it landed in their Wren (they had an account, or they got it)
// waiting    they don't have Wren yet; the link is open
// returned   nobody opened the link in time, so it came back to you
// failed     it didn't go through
//
// Checkouts that were never paid aren't sends, so they don't show.

import { db } from "@/discovery/db.js";
import { ContactsAdapter } from "@/messaging/contacts.adapter.js";
import { listSpotBuyableOffers } from "@/discovery/doppler/stockCatalog.js";
import { PhoneEscrowAdapter } from "@/wallet/phoneEscrow.js";
import { claimStateFromEscrowStatus } from "@/portfolio/claimState.js";

export type SendState = "sending" | "in_account" | "waiting" | "returned" | "failed";
export type ActivityState = SendState | "bought";

export function sendState(row: {
  txHash: string | null;
  failed: boolean;
  recipientKind: string | null;
  escrowStatus: string | null;
  startedAt?: Date | null;
  now?: Date;
}): SendState {
  if (row.txHash) {
    if (row.recipientKind !== "claim_phone") return "in_account";
    const claim = claimStateFromEscrowStatus(row.escrowStatus);
    if (claim === "claimed") return "in_account";
    if (claim === "returned") return "returned";
    return "waiting";
  }
  if (row.failed) return "failed";
  // A send that never reached the chain within an hour isn't going to.
  const started = row.startedAt?.getTime();
  if (started != null && (row.now ?? new Date()).getTime() - started > STALE_SEND_MS) return "failed";
  return "sending";
}

const STALE_SEND_MS = 60 * 60 * 1000;

export type ActivityItem = {
  id: string;
  kind: "send" | "buy";
  name: string | null;
  phone: string | null;
  symbol: string;
  stockName: string;
  usd: number;
  state: ActivityState;
  at: string;
};

let buysReady: Promise<void> | null = null;
function ensureBuys(): Promise<void> {
  buysReady ??= db
    .query(
      `CREATE TABLE IF NOT EXISTS wren_buys (
         id      BIGSERIAL PRIMARY KEY,
         owner   TEXT NOT NULL,
         symbol  TEXT NOT NULL,
         usd     NUMERIC NOT NULL,
         tx_hash TEXT UNIQUE,
         at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
       );
       CREATE INDEX IF NOT EXISTS wren_buys_owner_at ON wren_buys (owner, at DESC);`,
    )
    .then(() => undefined)
    .catch((err) => {
      buysReady = null;
      throw err;
    });
  return buysReady;
}

/** A Buy, for your own Activity only. */
export async function recordBuy(owner: string, symbol: string, usd: number, txHash: string | null): Promise<void> {
  await ensureBuys();
  await db.query(
    `INSERT INTO wren_buys (owner, symbol, usd, tx_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (tx_hash) DO NOTHING`,
    [owner, symbol, usd, txHash],
  );
}

async function listBuys(owner: string, limit: number): Promise<ActivityItem[]> {
  await ensureBuys();
  const { rows } = await db.query(
    `SELECT id, symbol, usd, at FROM wren_buys WHERE owner = $1 ORDER BY at DESC LIMIT $2`,
    [owner, limit],
  );
  const stockNames = new Map(listSpotBuyableOffers().map((o) => [o.symbol, o.name] as const));
  return (rows as { id: string; symbol: string; usd: string; at: Date }[]).map((r) => ({
    id: `buy-${r.id}`,
    kind: "buy" as const,
    name: null,
    phone: null,
    symbol: r.symbol,
    stockName: stockNames.get(r.symbol) ?? r.symbol.replace(/c$/, ""),
    usd: Number(r.usd),
    state: "bought" as const,
    at: new Date(r.at).toISOString(),
  }));
}

export async function listActivity(senderId: string, limit = 50): Promise<ActivityItem[]> {
  const [sends, buys] = await Promise.all([
    listSends(senderId, limit),
    listBuys(senderId, limit).catch(() => [] as ActivityItem[]),
  ]);
  return [...sends, ...buys].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}

async function listSends(senderId: string, limit: number): Promise<ActivityItem[]> {
  const { rows } = await db
    .query(
      `SELECT id, intent, amount_usd, gift_tx_hash, gift_failed_at, gift_started_at, created_at
         FROM stock_gifts
        WHERE sender_id = $1 AND (gift_started_at IS NOT NULL OR gift_tx_hash IS NOT NULL OR gift_failed_at IS NOT NULL)
        ORDER BY created_at DESC LIMIT $2`,
      [senderId, limit],
    )
    .catch(() => ({ rows: [] as Record<string, unknown>[] }));

  type Row = {
    id: string;
    intent: { symbol?: string; usd?: string; recipient?: { kind?: string; phone?: string | null; name?: string } };
    amount_usd: string | number;
    gift_tx_hash: string | null;
    gift_failed_at: Date | null;
    gift_started_at: Date | null;
    created_at: Date;
  };
  const list = rows as Row[];
  const hashes = list.map((r) => r.gift_tx_hash).filter(Boolean) as string[];
  const phones = [...new Set(list.map((r) => r.intent?.recipient?.phone).filter(Boolean) as string[])];
  const [escrows, contacts] = await Promise.all([
    PhoneEscrowAdapter.listByDepositTxHashes(senderId, hashes).catch(() => []),
    ContactsAdapter.findByPhones(senderId, phones).catch(() => new Map()),
  ]);
  const escrowByTx = new Map(escrows.map((e) => [e.depositTxHash.toLowerCase(), e.status] as const));
  const stockNames = new Map(listSpotBuyableOffers().map((o) => [o.symbol, o.name] as const));

  return list.map((r) => {
    const recipient = r.intent?.recipient ?? {};
    const phone = recipient.phone ?? null;
    const symbol = String(r.intent?.symbol ?? "");
    const contact = phone ? (contacts as Map<string, { name?: string }>).get(phone) : undefined;
    return {
      id: r.id,
      kind: "send" as const,
      name: contact?.name ?? recipient.name ?? null,
      phone,
      symbol,
      stockName: stockNames.get(symbol) ?? symbol.replace(/c$/, ""),
      usd: Number(r.intent?.usd ?? r.amount_usd ?? 0),
      state: sendState({
        txHash: r.gift_tx_hash,
        failed: Boolean(r.gift_failed_at),
        recipientKind: recipient.kind ?? null,
        escrowStatus: r.gift_tx_hash ? (escrowByTx.get(r.gift_tx_hash.toLowerCase()) ?? null) : null,
        startedAt: r.gift_started_at ? new Date(r.gift_started_at) : new Date(r.created_at),
      }),
      at: new Date(r.created_at).toISOString(),
    };
  });
}
