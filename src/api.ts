// Thin client for the Wren backend (the Basemate "channels" service).
//
// API host comes from EXPO_PUBLIC_WREN_API_HOST and must be the channels /
// iMessage host — the Express service that mounts /api/app/* and /api/muse/*
// (see packages/core/src/entries/channelsApp.ts). It is NOT the xmtp-agent
// URL. Empty default — until it's set, every call rejects and the UI stays
// put (Home keeps Send, Amount restores Continue, etc).
//
// Auth is session credentials: /api/app/* reads `user` and `token` from the
// query string or the JSON body (see `authed()` in app.router.ts), not from
// headers. We send them as ?user=…&token=… on GETs and in the JSON body on
// POSTs. /api/muse/* is unauthenticated and rate-limited by the server.

import { getSession } from './auth';

const HOST = (process.env.EXPO_PUBLIC_WREN_API_HOST ?? '').replace(/\/$/, '');

export function apiHost(): string {
  return HOST;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

type RequestOpts = {
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | undefined>;
  json?: Record<string, unknown>;
  /** Whether to attach the session user/token to the request (default true). */
  auth?: boolean;
};

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  if (!HOST) throw new ApiError('API host not set.', 0, null);
  const method = opts.method ?? 'GET';
  const authed = opts.auth !== false;

  const session = authed ? await getSession() : null;
  if (authed && !session) throw new ApiError('Not signed in.', 401, null);

  // Build the URL with query params for GET; for POST we include auth in the body.
  const params = new URLSearchParams();
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }
  }
  if (session && method === 'GET') {
    params.set('user', session.user);
    params.set('token', session.token);
  }
  const qs = params.toString();
  const url = `${HOST}${path}${qs ? (path.includes('?') ? '&' : '?') + qs : ''}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: string | undefined;
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    const payload: Record<string, unknown> = { ...(opts.json ?? {}) };
    if (session) {
      payload.user = session.user;
      payload.token = session.token;
    }
    body = JSON.stringify(payload);
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error.';
    throw new ApiError(message, 0, null);
  }
  const text = await res.text();
  let parsed: Json = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as Json;
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const serverMsg =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `Request failed (${res.status}).`;
    throw new ApiError(serverMsg, res.status, parsed);
  }
  return parsed as T;
}

// ---------- Portfolio ----------
// GET /api/app/portfolio → ImessagePortfolioPayload. See
// packages/core/src/portfolio/types.ts. We surface totalUsd as the big number
// and coins[] (symbol, name, valueUsd) as the list — those are the stocks the
// signed-in user already holds.

export type Holding = {
  symbol: string;
  name: string;
  value: number;
};

export type Portfolio = {
  total: number;
  holdings: Holding[];
};

type PortfolioResponse = {
  totals?: { totalUsd?: number; coinsUsd?: number };
  coins?: Array<{ symbol?: string; name?: string | null; valueUsd?: number }>;
};

export async function getPortfolio(): Promise<Portfolio> {
  const raw = await request<PortfolioResponse>('/api/app/portfolio');
  const holdings: Holding[] = (raw.coins ?? [])
    .map((c) => ({
      symbol: String(c.symbol ?? ''),
      name: String(c.name ?? c.symbol ?? ''),
      value: Number(c.valueUsd ?? 0),
    }))
    .filter((h) => h.symbol && Number.isFinite(h.value))
    .sort((a, b) => b.value - a.value);
  const total = Number(raw.totals?.totalUsd ?? raw.totals?.coinsUsd ?? 0);
  return { total: Number.isFinite(total) ? total : 0, holdings };
}

// ---------- Stocks catalog ----------
// GET /api/app/stocks → { items: [{ symbol, name }] }

export type Stock = {
  symbol: string;
  name: string;
};

type StocksResponse = { items?: Array<{ symbol?: string; name?: string }> };

export async function getStocks(): Promise<Stock[]> {
  const raw = await request<StocksResponse>('/api/app/stocks');
  return (raw.items ?? [])
    .map((s) => ({ symbol: String(s.symbol ?? ''), name: String(s.name ?? '') }))
    .filter((s) => s.symbol && s.name);
}

// ---------- Contacts import ----------
// POST /api/app/contacts/import → { ok, saved }. We chunk to stay under 80kb
// per request. Only + / 7–15 digit phones are sent.

export type ContactUpload = {
  name: string;
  phone: string; // E.164 with leading +
};

export async function importContacts(contacts: ContactUpload[]): Promise<void> {
  const CHUNK_BYTES = 70_000;
  let batch: ContactUpload[] = [];
  let bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    await request('/api/app/contacts/import', {
      method: 'POST',
      json: { contacts: batch },
    });
    batch = [];
    bytes = 0;
  };
  for (const c of contacts) {
    const line = JSON.stringify(c);
    const size = line.length + 1;
    if (bytes + size > CHUNK_BYTES && batch.length) await flush();
    batch.push(c);
    bytes += size;
  }
  await flush();
}

// ---------- Create a stock gift ----------
// POST /api/app/stock-gifts with `channel: "imessage"`. `usd` is a *string* on
// the wire. Returns { status: "pay", payUrl, giftId, chargeUsd, amountLabel }.
// The payUrl is an https Coinbase CDP fund-page URL — we hand it to Safari via
// Linking.openURL and do not try to fix it.

export type GiftRequest = {
  symbol: string;
  usd: number;
  recipient: { name: string; phone: string };
};

export type GiftResponse = {
  giftId: string;
  chargeUsd: number;
  payUrl: string;
};

type RawGiftResponse = {
  status?: string;
  giftId?: string;
  payUrl?: string;
  chargeUsd?: number;
};

export async function createGift(req: GiftRequest): Promise<GiftResponse> {
  const raw = await request<RawGiftResponse>('/api/app/stock-gifts', {
    method: 'POST',
    json: {
      channel: 'imessage',
      symbol: req.symbol, // posted exactly as returned by /api/app/stocks
      usd: String(req.usd), // server expects a string
      recipient: { name: req.recipient.name, phone: req.recipient.phone },
    },
  });
  const giftId = raw.giftId;
  const payUrl = raw.payUrl;
  const chargeUsd = typeof raw.chargeUsd === 'number' ? raw.chargeUsd : undefined;
  if (!giftId || !payUrl || chargeUsd === undefined) {
    throw new ApiError('Bad response from server.', 500, raw);
  }
  if (!/^https:\/\//i.test(payUrl)) {
    throw new ApiError('Bad pay URL.', 500, raw);
  }
  return { giftId, chargeUsd, payUrl };
}

// ---------- Gift status ----------
// GET /api/muse/sends/:giftId (unauthenticated — this endpoint is also used
// by the recipient's share link). publicMuseSend shape; see muse.status.ts.
// Status becomes "sent" after the onchain gift tx confirms; before that we
// see "awaiting_payment" or "buying".

export type GiftStatus = {
  status: 'awaiting_payment' | 'buying' | 'sent' | 'failed' | string;
  alreadyOnBasemate: boolean;
  amountLabel?: string;
  stockLabel?: string | null;
};

type RawStatusResponse = {
  status?: string;
  alreadyOnBasemate?: boolean;
  amountLabel?: string;
  stockLabel?: string | null;
};

export async function getGiftStatus(giftId: string): Promise<GiftStatus> {
  const raw = await request<RawStatusResponse>(
    `/api/muse/sends/${encodeURIComponent(giftId)}`,
    { auth: false },
  );
  return {
    status: raw.status ?? 'awaiting_payment',
    alreadyOnBasemate: !!raw.alreadyOnBasemate,
    amountLabel: raw.amountLabel,
    stockLabel: raw.stockLabel ?? null,
  };
}
