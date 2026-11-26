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

import { getSession, type Session } from './auth';

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
  method?: 'GET' | 'POST' | 'DELETE';
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
  if (session && method !== 'POST') {
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
  /** Cash + stocks. Other assets in the account (ETH, other tokens) don't count. */
  total: number;
  /** USDC in the account. */
  cash: number;
  /** Stocks only. */
  holdings: Holding[];
};

const CASH_SYMBOLS = new Set(['USDC', 'USDBC']);

function stockKey(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/C$/, '');
}

type PortfolioResponse = {
  totals?: { totalUsd?: number; coinsUsd?: number };
  coins?: Array<{ symbol?: string; name?: string | null; valueUsd?: number }>;
};

/**
 * The account as Wren shows it: cash (USDC) and stocks. Pass the stock list
 * (getStocks) so only real stocks count; ETH or other tokens in the same
 * account never show up as "stocks".
 */
export async function getPortfolio(stocks: Stock[]): Promise<Portfolio> {
  const raw = await request<PortfolioResponse>('/api/app/portfolio');
  const byKey = new Map(stocks.map((s) => [stockKey(s.symbol), s] as const));
  let cash = 0;
  const holdings: Holding[] = [];
  for (const c of raw.coins ?? []) {
    const symbol = String(c.symbol ?? '');
    const value = Number(c.valueUsd ?? 0);
    if (!symbol || !Number.isFinite(value)) continue;
    if (CASH_SYMBOLS.has(symbol.toUpperCase())) {
      cash += value;
      continue;
    }
    const stock = byKey.get(stockKey(symbol));
    if (stock && value > 0.005) holdings.push({ symbol: stock.symbol, name: stock.name, value });
  }
  holdings.sort((a, b) => b.value - a.value);
  const stocksValue = holdings.reduce((sum, h) => sum + h.value, 0);
  return { total: cash + stocksValue, cash, holdings };
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
  payFrom?: PayFrom;
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

export type PendingConnect = {
  code: string;
  secret: string;
  expiresAt: string;
  targets: ConnectTargets;
};

export type PrivySessionResult =
  | { kind: 'session'; session: Session }
  | { kind: 'needsPhone'; connect: PendingConnect };

export async function exchangePrivySession(
  accessToken: string,
  address?: string,
): Promise<PrivySessionResult> {
  const raw = await request<{
    user?: string;
    token?: string;
    needsPhone?: boolean;
    connect?: PendingConnect;
  }>('/api/app/privy-session', {
    method: 'POST',
    auth: false,
    json: { accessToken, address },
  });
  if (raw.needsPhone && raw.connect?.code && raw.connect.secret) {
    return { kind: 'needsPhone', connect: raw.connect };
  }
  if (!raw.user || !raw.token) throw new ApiError('Could not sign in.', 500, raw);
  return { kind: 'session', session: { user: raw.user, token: raw.token } };
}

/** Email sign-in waits on its connect text. Done returns the session. */
export async function pollConnectCode(
  code: string,
  secret: string,
): Promise<{ status: 'waiting' | 'expired' } | { status: 'done'; session: Session }> {
  const raw = await request<{ status?: string; user?: string; token?: string }>(
    '/api/app/connect-code/poll',
    { method: 'POST', auth: false, json: { code, secret } },
  );
  if (raw.status === 'done' && raw.user && raw.token) {
    return { status: 'done', session: { user: raw.user, token: raw.token } };
  }
  return { status: raw.status === 'expired' ? 'expired' : 'waiting' };
}

// What a send costs before Pay: 1.5% to send, at least $0.99 (free the first time), plus the
// card cost at what Coinbase charges. GET /api/app/send-quote.
export type SendQuote = {
  stockUsd: number;
  feeUsd: number;
  cardUsd: number;
  totalUsd: number;
  firstSend: boolean;
};

export type PayFrom = 'card' | 'cash';

export function getSendQuote(usd: number, payFrom: PayFrom = 'card'): Promise<SendQuote> {
  return request<SendQuote>('/api/app/send-quote', { query: { usd, payFrom } });
}

// ---------- Apple Pay (Coinbase) ----------
// POST /api/app/apple-pay { amount } → { url } for Coinbase's Apple Pay page,
// loaded in a WebView. 409 need_email / need_email_code until the email is
// verified once (POST /api/app/apple-pay/email, then /verify).

export type ApplePayStart = { url: string; orderId: string | null; totalUsd: number | null };

/** Start Apple Pay for `receive` dollars of cash; Coinbase's fee is added on top. */
export async function startApplePay(receive: number): Promise<ApplePayStart> {
  const raw = await request<{ url?: string; orderId?: string | null; totalUsd?: number }>('/api/app/apple-pay', {
    method: 'POST',
    json: { receive },
  });
  if (!raw.url) throw new ApiError('Bad response from server.', 500, raw);
  return { url: raw.url, orderId: raw.orderId ?? null, totalUsd: typeof raw.totalUsd === 'number' ? raw.totalUsd : null };
}

export type ApplePayQuote = { receiveUsd: number; feeUsd: number; totalUsd: number; minUsd: number };

/** What `receive` dollars of cash costs by Apple Pay: Coinbase's fee on top. */
export function getApplePayQuote(receive: number): Promise<ApplePayQuote> {
  return request<ApplePayQuote>('/api/app/apple-pay/quote', { query: { receive } });
}

export async function sendApplePayEmail(email: string): Promise<void> {
  await request('/api/app/apple-pay/email', { method: 'POST', json: { email } });
}

export async function verifyApplePayEmail(code: string): Promise<void> {
  await request('/api/app/apple-pay/verify', { method: 'POST', json: { code } });
}

/** The server's error code (`{ error: "need_email" }`), if any. */
export function apiErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const body = err.body as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : null;
}

/** Cash (USDC) in the account, in dollars. */
export async function getCash(): Promise<number> {
  return (await getPortfolio([])).cash;
}

export async function sendGift(req: GiftRequest): Promise<{ giftId: string; chargeUsd: number }> {
  const raw = await request<{ giftId?: string; chargeUsd?: number }>('/api/app/stock-gifts/send', {
    method: 'POST',
    json: {
      channel: 'imessage',
      symbol: req.symbol,
      usd: String(req.usd),
      recipient: { name: req.recipient.name, phone: req.recipient.phone },
      payFrom: 'cash',
    },
  });
  if (!raw.giftId || typeof raw.chargeUsd !== 'number') {
    throw new ApiError('Bad response from server.', 500, raw);
  }
  return { giftId: raw.giftId, chargeUsd: raw.chargeUsd };
}

export type ConnectTargets = {
  imessage: { number: string; prefill: string };
  whatsapp: { number: string; prefill: string };
  code?: string;
};

export type ConnectState = {
  phone: string;
  imessageOptedInAt: string | null;
  imessageService: string | null;
  whatsappOptedInAt: string | null;
  whatsappDisplayName: string | null;
};

export function getConnectTargets(): Promise<ConnectTargets> {
  return request('/api/app/connect-targets');
}

export function getConnectState(): Promise<ConnectState> {
  return request('/api/app/connect');
}

export function turnOffChannel(channel: 'imessage' | 'whatsapp'): Promise<void> {
  return request(`/api/app/opt-in/${channel}`, { method: 'DELETE' });
}

export function registerPushToken(token: string): Promise<void> {
  return request('/api/app/push-tokens', {
    method: 'POST',
    json: { token, platform: 'ios' },
  });
}

// ---------- Gift status ----------
// GET /api/muse/sends/:giftId (unauthenticated — this endpoint is also used
// by the recipient's share link). publicMuseSend shape; see muse.status.ts.
// Status becomes "sent" after the onchain gift tx confirms; before that we
// see "awaiting_payment" or "buying".

export type GiftStatus = {
  status: string;
  alreadyOnBasemate: boolean;
  delivery?: string | null;
  tellSender?: string | null;
  txHash?: string | null;
  claimUrl?: string | null;
  /** Wren's /c/ link: unfurls into a card and opens the app. */
  shareUrl?: string | null;
  /** waiting | claimed | returned | sending (claim recipients only). */
  claimState?: string | null;
  amountLabel?: string;
  stockLabel?: string | null;
  holdHours?: number | null;
};

type RawStatusResponse = {
  status?: string;
  alreadyOnBasemate?: boolean;
  delivery?: string | null;
  tellSender?: string | null;
  txHash?: string | null;
  claimUrl?: string | null;
  shareUrl?: string | null;
  claimState?: string | null;
  amountLabel?: string;
  stockLabel?: string | null;
  holdHours?: number;
};

export async function getGiftStatus(giftId: string): Promise<GiftStatus> {
  const raw = await request<RawStatusResponse>(
    `/api/muse/sends/${encodeURIComponent(giftId)}`,
    { auth: false },
  );
  return {
    status: raw.status ?? 'awaiting_payment',
    alreadyOnBasemate: !!raw.alreadyOnBasemate,
    delivery: raw.delivery ?? null,
    tellSender: raw.tellSender ?? null,
    txHash: raw.txHash ?? null,
    claimUrl: raw.claimUrl ?? null,
    shareUrl: raw.shareUrl ?? null,
    claimState: raw.claimState ?? null,
    amountLabel: raw.amountLabel,
    stockLabel: raw.stockLabel ?? null,
    holdHours: typeof raw.holdHours === 'number' ? raw.holdHours : null,
  };
}

// ---------- Not enough cash ----------
// Buy and send-from-cash answer 402 { error: "not_enough_cash", cashUsd, neededUsd }.

export function notEnoughCash(err: unknown): { cashUsd: number; neededUsd: number } | null {
  if (!(err instanceof ApiError) || err.status !== 402) return null;
  const b = (err.body ?? {}) as { cashUsd?: number; neededUsd?: number };
  return { cashUsd: Number(b.cashUsd ?? 0), neededUsd: Number(b.neededUsd ?? 0) };
}

// ---------- Market ----------
// GET /api/app/market: price, today's change and a sparkline per stock.

export type MarketItem = {
  symbol: string;
  name: string;
  priceUsd: number | null;
  changePct: number | null;
  spark: number[];
};

export async function getMarket(): Promise<MarketItem[]> {
  const raw = await request<{ items?: MarketItem[] }>('/api/app/market', { auth: false });
  return raw.items ?? [];
}

export type Range = '1D' | '1W' | '1M' | '1Y';

export type History = {
  priceUsd: number | null;
  changePct: number | null;
  points: [number, number][];
};

export function getHistory(symbol: string, range: Range): Promise<History> {
  return request<History>(`/api/app/stocks/${encodeURIComponent(symbol)}/history`, {
    auth: false,
    query: { range },
  });
}

// ---------- Buy ----------

export type BuyResult = {
  txHash: string;
  symbol: string;
  usd: number;
  amountLabel: string;
  shares: string;
};

export function buyStock(symbol: string, usd: number): Promise<BuyResult> {
  return request<BuyResult>('/api/app/buy', { method: 'POST', json: { symbol, usd } });
}

// ---------- People, moves, privacy ----------

export type WrenPerson = { name: string; phone: string };

export function getPeople(): Promise<{ onWren: WrenPerson[]; notOnWren: WrenPerson[] }> {
  return request('/api/app/people');
}

export type Move = {
  name: string;
  phone: string;
  kind: 'bought';
  symbol: string;
  stockName: string;
  at: string;
};

export function getMoves(): Promise<{ sharing: boolean; items: Move[] }> {
  return request('/api/app/moves');
}

export type Profile = {
  name: string | null;
  phone: string;
  hasWren: boolean;
  canSeeMoves: boolean;
  holdings: { symbol: string; name: string; pct: number }[];
  between: { from: 'you' | 'them'; symbol: string; usd: number | null; at: string }[];
  notify: boolean;
};

export function getProfile(phone: string): Promise<Profile> {
  return request(`/api/app/people/${encodeURIComponent(phone)}`);
}

export function setNotify(phone: string, notify: boolean): Promise<void> {
  return request(`/api/app/people/${encodeURIComponent(phone)}/notify`, {
    method: 'POST',
    json: { notify },
  });
}

export type Visibility = 'only_me' | 'your_people';

export function getPrivacy(): Promise<{ visibility: Visibility; chosen: boolean }> {
  return request('/api/app/privacy');
}

export function setPrivacy(visibility: Visibility): Promise<void> {
  return request('/api/app/privacy', { method: 'POST', json: { visibility } });
}

// ---------- Activity ----------

export type SendState = 'sending' | 'in_account' | 'waiting' | 'returned' | 'failed' | 'bought';

export type ActivityItem = {
  id: string;
  kind: 'send' | 'buy';
  name: string | null;
  phone: string | null;
  symbol: string;
  stockName: string;
  usd: number;
  state: SendState;
  at: string;
};

export async function getActivity(): Promise<ActivityItem[]> {
  const raw = await request<{ items?: ActivityItem[] }>('/api/app/activity/sends');
  return raw.items ?? [];
}
