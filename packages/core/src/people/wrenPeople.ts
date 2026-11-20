// People, moves and privacy for Wren.
//
// - Moves are what someone did and when ("Mom bought Apple"). Never dollars:
//   no amount is stored or returned.
// - Who sees your moves: only_me | your_people. New accounts start on
//   your_people (no row = your_people); change it in Settings.
// - Contacts only, both ways: you see someone's moves only if you both share
//   and each of you has the other's number saved. Never strangers.
// - Rows saved as "everyone" (an option we dropped) read as your_people.
// - Profiles show holdings as shares of the account (percent), never dollars.

import { db } from "@/discovery/db.js";
import { ContactsAdapter } from "@/messaging/contacts.adapter.js";
import { buildPortfolioForAppDashboard } from "@/portfolio/service.js";
import { listSpotBuyableOffers } from "@/discovery/doppler/stockCatalog.js";

export type Visibility = "only_me" | "your_people";
export const VISIBILITIES: Visibility[] = ["only_me", "your_people"];
export type MoveKind = "bought";

let ready: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  ready ??= db
    .query(
      `CREATE TABLE IF NOT EXISTS wren_moves (
         id      BIGSERIAL PRIMARY KEY,
         owner   TEXT NOT NULL,
         kind    TEXT NOT NULL,
         symbol  TEXT NOT NULL,
         tx_hash TEXT,
         at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (owner, kind, tx_hash)
       );
       CREATE INDEX IF NOT EXISTS idx_wren_moves_owner_at ON wren_moves (owner, at DESC);
       CREATE TABLE IF NOT EXISTS wren_privacy (
         owner      TEXT PRIMARY KEY,
         visibility TEXT NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       );
       CREATE TABLE IF NOT EXISTS wren_follows (
         owner      TEXT NOT NULL,
         target     TEXT NOT NULL,
         notify     BOOLEAN NOT NULL DEFAULT TRUE,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (owner, target)
       );`,
    )
    .then(() => undefined)
    .catch((err) => {
      ready = null;
      throw err;
    });
  return ready;
}

const norm = (phone: string) => ContactsAdapter.normalizeHandle(phone) ?? phone;

// ── Moves ──────────────────────────────────────────────────────────────────

export async function recordMove(owner: string, kind: MoveKind, symbol: string, txHash?: string | null): Promise<void> {
  await ensureTables();
  await db.query(
    `INSERT INTO wren_moves (owner, kind, symbol, tx_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner, kind, tx_hash) DO NOTHING`,
    [norm(owner), kind, symbol, txHash ?? null],
  );
}

// ── Privacy ────────────────────────────────────────────────────────────────

export async function getVisibility(owner: string): Promise<{ visibility: Visibility; chosen: boolean }> {
  await ensureTables();
  const { rows } = await db.query(`SELECT visibility FROM wren_privacy WHERE owner = $1`, [norm(owner)]);
  const raw = rows[0]?.visibility as string | undefined;
  const v = (raw === "everyone" ? "your_people" : raw) as Visibility | undefined;
  return v && VISIBILITIES.includes(v) ? { visibility: v, chosen: true } : { visibility: "your_people", chosen: false };
}

export async function setVisibility(owner: string, visibility: Visibility): Promise<void> {
  if (!VISIBILITIES.includes(visibility)) throw new Error("bad visibility");
  await ensureTables();
  await db.query(
    `INSERT INTO wren_privacy (owner, visibility) VALUES ($1, $2)
     ON CONFLICT (owner) DO UPDATE SET visibility = EXCLUDED.visibility, updated_at = NOW()`,
    [norm(owner), visibility],
  );
}

/** Pure rule, so it can be tested: can `viewer` see `target`'s moves? */
export function decideCanSee(args: {
  viewerVisibility: Visibility;
  targetVisibility: Visibility;
  viewerInTargetsContacts: boolean;
  targetInViewersContacts: boolean;
}): boolean {
  if (args.viewerVisibility === "only_me") return false; // share yours to see theirs
  if (args.targetVisibility === "only_me") return false;
  return args.viewerInTargetsContacts && args.targetInViewersContacts;
}

export async function canSee(viewer: string, target: string): Promise<boolean> {
  if (norm(viewer) === norm(target)) return true;
  const [v, t] = await Promise.all([getVisibility(viewer), getVisibility(target)]);
  if (v.visibility === "only_me" || t.visibility === "only_me") return false;
  const [viewerInTargets, targetInViewers] = await Promise.all([
    ContactsAdapter.findByPhone(target, viewer).then(Boolean),
    ContactsAdapter.findByPhone(viewer, target).then(Boolean),
  ]);
  return decideCanSee({
    viewerVisibility: v.visibility,
    targetVisibility: t.visibility,
    viewerInTargetsContacts: viewerInTargets,
    targetInViewersContacts: targetInViewers,
  });
}

// ── People ─────────────────────────────────────────────────────────────────

/** Phones (of these) that have a Wren account. */
export async function onWren(phones: string[]): Promise<Set<string>> {
  const list = [...new Set(phones.map(norm).filter(Boolean))];
  if (!list.length) return new Set();
  const { rows } = await db.query(
    `SELECT sender_id FROM imessage_wallets
      WHERE sender_id = ANY($1) AND (embedded_address IS NOT NULL OR privy_user_id IS NOT NULL)`,
    [list],
  );
  return new Set((rows as { sender_id: string }[]).map((r) => r.sender_id));
}

export type Person = { name: string; phone: string };

export async function listPeople(owner: string): Promise<{ onWren: Person[]; notOnWren: Person[] }> {
  const contacts = await ContactsAdapter.listContacts(owner);
  const seen = new Set<string>();
  const people: Person[] = [];
  for (const c of contacts) {
    const phone = c.contact_phone ?? c.contact;
    if (!phone) continue;
    const p = norm(phone);
    if (seen.has(p) || p === norm(owner)) continue;
    seen.add(p);
    people.push({ name: c.name, phone: p });
  }
  const wren = await onWren(people.map((p) => p.phone));
  const byName = (a: Person, b: Person) => a.name.localeCompare(b.name);
  return {
    onWren: people.filter((p) => wren.has(p.phone)).sort(byName),
    notOnWren: people.filter((p) => !wren.has(p.phone)).sort(byName),
  };
}

/** Your people's moves you're allowed to see, newest first. Never amounts. */
export async function movesFor(viewer: string, limit = 30): Promise<
  { name: string; phone: string; kind: MoveKind; symbol: string; stockName: string; at: string }[]
> {
  await ensureTables();
  const mine = await getVisibility(viewer);
  if (mine.visibility === "only_me") return [];
  const { onWren: people } = await listPeople(viewer);
  const visible: Person[] = [];
  for (const p of people) if (await canSee(viewer, p.phone)) visible.push(p);
  if (!visible.length) return [];
  const names = new Map(visible.map((p) => [p.phone, p.name] as const));
  const stockNames = new Map(listSpotBuyableOffers().map((o) => [o.symbol, o.name] as const));
  const { rows } = await db.query(
    `SELECT owner, kind, symbol, at FROM wren_moves
      WHERE owner = ANY($1) AND at > NOW() - INTERVAL '30 days'
      ORDER BY at DESC LIMIT $2`,
    [visible.map((p) => p.phone), limit],
  );
  return (rows as { owner: string; kind: MoveKind; symbol: string; at: Date }[]).map((r) => ({
    name: names.get(r.owner) ?? "",
    phone: r.owner,
    kind: r.kind,
    symbol: r.symbol,
    stockName: stockNames.get(r.symbol) ?? r.symbol,
    at: new Date(r.at).toISOString(),
  }));
}

// ── Profile ────────────────────────────────────────────────────────────────

/** Turns dollar holdings into shares of the whole (percent, 1 decimal). */
export function holdingShares(holdings: { symbol: string; name: string; valueUsd: number }[]): {
  symbol: string;
  name: string;
  pct: number;
}[] {
  const total = holdings.reduce((s, h) => s + Math.max(0, h.valueUsd), 0);
  if (!(total > 0)) return [];
  return holdings
    .filter((h) => h.valueUsd > 0)
    .map((h) => ({ symbol: h.symbol, name: h.name, pct: Math.round((h.valueUsd / total) * 1000) / 10 }))
    .sort((a, b) => b.pct - a.pct);
}

export async function profile(viewer: string, targetPhone: string): Promise<{
  name: string | null;
  phone: string;
  hasWren: boolean;
  canSeeMoves: boolean;
  holdings: { symbol: string; name: string; pct: number }[];
  between: { from: "you" | "them"; symbol: string; usd: number | null; at: string }[];
  notify: boolean;
}> {
  await ensureTables();
  const target = norm(targetPhone);
  const me = norm(viewer);
  const [contact, wren, visible, follow, between] = await Promise.all([
    ContactsAdapter.findByPhone(me, target),
    onWren([target]),
    canSee(me, target),
    db.query(`SELECT notify FROM wren_follows WHERE owner = $1 AND target = $2`, [me, target]),
    db.query(
      `SELECT sender_id, intent->>'symbol' AS symbol, intent->>'usd' AS usd, created_at
         FROM stock_gifts
        WHERE gift_tx_hash IS NOT NULL
          AND ((sender_id = $1 AND intent->'recipient'->>'phone' = $2)
            OR (sender_id = $2 AND intent->'recipient'->>'phone' = $1))
        ORDER BY created_at DESC LIMIT 20`,
      [me, target],
    ).catch(() => ({ rows: [] })),
  ]);

  let holdings: { symbol: string; name: string; pct: number }[] = [];
  if (visible && wren.has(target)) {
    const stocks = new Map(listSpotBuyableOffers().map((o) => [o.symbol.toUpperCase(), o] as const));
    const portfolio = await buildPortfolioForAppDashboard(target).catch(() => null);
    const coins = ((portfolio as { coins?: { symbol?: string; valueUsd?: number }[] } | null)?.coins ?? [])
      .map((c) => ({ c, o: stocks.get(String(c.symbol ?? "").toUpperCase()) }))
      .filter((x) => x.o)
      .map((x) => ({ symbol: x.o!.symbol, name: x.o!.name, valueUsd: Number(x.c.valueUsd ?? 0) }));
    holdings = holdingShares(coins);
  }

  return {
    name: contact?.name ?? null,
    phone: target,
    hasWren: wren.has(target),
    canSeeMoves: visible,
    holdings,
    between: (between.rows as { sender_id: string; symbol: string; usd: string | null; created_at: Date }[]).map((r) => ({
      from: r.sender_id === me ? "you" : "them",
      symbol: r.symbol,
      usd: r.usd ? Number(r.usd) : null,
      at: new Date(r.created_at).toISOString(),
    })),
    notify: Boolean(follow.rows[0]?.notify),
  };
}

export async function setNotify(owner: string, target: string, notify: boolean): Promise<void> {
  await ensureTables();
  await db.query(
    `INSERT INTO wren_follows (owner, target, notify) VALUES ($1, $2, $3)
     ON CONFLICT (owner, target) DO UPDATE SET notify = EXCLUDED.notify`,
    [norm(owner), norm(target), notify],
  );
}

/** People who turned on Notify for `target` and are allowed to see them. */
export async function followersToNotify(target: string): Promise<string[]> {
  await ensureTables();
  const { rows } = await db.query(`SELECT owner FROM wren_follows WHERE target = $1 AND notify`, [norm(target)]);
  const out: string[] = [];
  for (const r of rows as { owner: string }[]) if (await canSee(r.owner, target)) out.push(r.owner);
  return out;
}
