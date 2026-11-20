// Activity: the stocks you sent, newest first, with where each one is.
//
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

export function sendState(row: {
  txHash: string | null;
  failed: boolean;
  recipientKind: string | null;
  escrowStatus: string | null;
}): SendState {
  if (row.txHash) {
    if (row.recipientKind !== "claim_phone") return "in_account";
    const claim = claimStateFromEscrowStatus(row.escrowStatus);
    if (claim === "claimed") return "in_account";
    if (claim === "returned") return "returned";
    return "waiting";
  }
  return row.failed ? "failed" : "sending";
}

export type ActivityItem = {
  id: string;
  name: string | null;
  phone: string | null;
  symbol: string;
  stockName: string;
  usd: number;
  state: SendState;
  at: string;
};

export async function listActivity(senderId: string, limit = 50): Promise<ActivityItem[]> {
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
      }),
      at: new Date(r.created_at).toISOString(),
    };
  });
}
