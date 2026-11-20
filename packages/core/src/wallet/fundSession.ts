import { randomBytes } from "node:crypto";

import { db } from "@/discovery/db.js";
import { isHostedCoinbaseOnrampUrl } from "@/wallet/onramp.js";

export interface FundPaymentLinkOption {
  method: "apple_pay" | "google_pay";
  label: "Apple Pay" | "Google Pay";
  url: string;
}

/** Purchase-scoped intent stored on the fund session (gift_stock today). */
export type FundSessionIntent = {
  kind: "gift_stock";
  giftId?: string;
  symbol: string;
  qty?: string;
  usd?: string;
  memo?: string;
  recipient: {
    kind: "wallet" | "claim_phone";
    display: string;
    address?: string;
    phone?: string;
    name?: string;
    isOnBasemate?: boolean;
  };
  quotedAt: string;
  maxUsd: number;
  sharePriceUsd?: number;
};

export interface FundSession {
  token: string;
  paymentLinkUrl: string;
  paymentLinkOptions: FundPaymentLinkOption[];
  userPhone: string;
  walletAddress: string | null;
  amountUsd: number | null;
  hostedFallbackUrl: string | null;
  intent: FundSessionIntent | null;
  expiresAt: Date;
  consumedAt: Date | null;
  fundingRecordedAt: Date | null;
}

/** Placeholder URL stored until /pay materializes headless orders with the user's IP. */
export const FUND_SESSION_PENDING_URL = "pending://checkout";

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes — regular add-funds
/** Gift checkout links live longer so a late Coinbase webhook can still claim. */
export const GIFT_FUND_SESSION_TTL_MS = 45 * 60 * 1000; // 45 minutes

/**
 * Manages short-lived Coinbase headless onramp payment link sessions.
 *
 * Sessions are stored in Postgres (shared with basemate-metrics) so the
 * Next.js /api/pay route can look them up without an inter-service call.
 * Sessions expire after 10 minutes (45m for gifts) and are marked consumed_at
 * on first read rather than deleted, so page refreshes don't break the flow.
 */
export class FundSessionAdapter {
  static async createTable(): Promise<void> {
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS fund_sessions (
          token        VARCHAR(32) PRIMARY KEY,
          payment_link_url TEXT NOT NULL,
          payment_link_options JSONB,
          user_phone   TEXT NOT NULL,
          expires_at   TIMESTAMPTZ NOT NULL,
          consumed_at  TIMESTAMPTZ,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE fund_sessions
          ADD COLUMN IF NOT EXISTS payment_link_options JSONB;
        ALTER TABLE fund_sessions
          ADD COLUMN IF NOT EXISTS amount_usd NUMERIC;
        ALTER TABLE fund_sessions
          ADD COLUMN IF NOT EXISTS funding_recorded_at TIMESTAMPTZ;
        ALTER TABLE fund_sessions
          ADD COLUMN IF NOT EXISTS wallet_address TEXT;
        ALTER TABLE fund_sessions
          ADD COLUMN IF NOT EXISTS hosted_fallback_url TEXT;
        ALTER TABLE fund_sessions
          ADD COLUMN IF NOT EXISTS intent JSONB;
        CREATE INDEX IF NOT EXISTS idx_fund_sessions_expires_at
          ON fund_sessions(expires_at);
      `);
    } catch (error) {
      console.error("Error creating fund_sessions table:", error);
    }
  }

  /**
   * Create a fund session with checkout intent only. Payment links are created
   * when the user opens /pay (so Coinbase gets the browser's real client IP).
   */
  static async createIntent(input: {
    userPhone: string;
    walletAddress: string;
    amountUsd: number;
    intent?: FundSessionIntent | null;
    ttlMs?: number;
  }): Promise<string> {
    const token = randomBytes(16).toString("hex").slice(0, 21);
    const ttl = input.ttlMs ?? SESSION_TTL_MS;
    const expiresAt = new Date(Date.now() + ttl);

    await db.query(
      `INSERT INTO fund_sessions (
         token, payment_link_url, payment_link_options, user_phone, amount_usd,
         wallet_address, hosted_fallback_url, intent, expires_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        token,
        FUND_SESSION_PENDING_URL,
        JSON.stringify([]),
        input.userPhone,
        input.amountUsd,
        input.walletAddress,
        null,
        input.intent ? JSON.stringify(input.intent) : null,
        expiresAt.toISOString(),
      ],
    );

    return token;
  }

  /**
   * Create a new fund session and return its token (URL-safe, 21 chars).
   * The token is safe to embed as a query parameter.
   */
  static async create(
    userPhone: string,
    paymentLinkUrl: string,
    paymentLinkOptions?: FundPaymentLinkOption[],
    amountUsd?: number,
    walletAddress?: string,
    hostedFallbackUrl?: string,
    opts?: { intent?: FundSessionIntent | null; ttlMs?: number },
  ): Promise<string> {
    const token = randomBytes(16).toString("hex").slice(0, 21);
    const ttl = opts?.ttlMs ?? SESSION_TTL_MS;
    const expiresAt = new Date(Date.now() + ttl);
    const amount =
      typeof amountUsd === "number" && Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : null;

    await db.query(
      `INSERT INTO fund_sessions (
         token, payment_link_url, payment_link_options, user_phone, amount_usd,
         wallet_address, hosted_fallback_url, intent, expires_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        token,
        paymentLinkUrl,
        JSON.stringify(paymentLinkOptions ?? []),
        userPhone,
        amount,
        walletAddress ?? null,
        hostedFallbackUrl ?? null,
        opts?.intent ? JSON.stringify(opts.intent) : null,
        expiresAt.toISOString(),
      ],
    );

    return token;
  }

  /**
   * Look up a fund session by token. Returns null if the token doesn't exist
   * or has expired. Marks the session as consumed on first read (idempotent —
   * subsequent reads for the same token return the same URL/options so page
   * refreshes don't break the payment iframe).
   */
  static async get(token: string): Promise<FundSession | null> {
    const result = await db.query(
      `SELECT token, payment_link_url, payment_link_options, user_phone, amount_usd,
              wallet_address, hosted_fallback_url, intent, expires_at, consumed_at, funding_recorded_at
       FROM fund_sessions
       WHERE token = $1`,
      [token],
    );

    const row = result.rows[0];
    if (!row) return null;

    if (new Date(row.expires_at) < new Date()) return null;

    if (!row.consumed_at) {
      await db.query(
        `UPDATE fund_sessions SET consumed_at = NOW() WHERE token = $1`,
        [token],
      );
    }

    return {
      token: row.token,
      paymentLinkUrl: row.payment_link_url,
      paymentLinkOptions: parsePaymentLinkOptions(row.payment_link_options, row.payment_link_url),
      userPhone: row.user_phone,
      walletAddress: typeof row.wallet_address === "string" ? row.wallet_address : null,
      amountUsd: parseAmountUsd(row.amount_usd),
      hostedFallbackUrl: typeof row.hosted_fallback_url === "string" ? row.hosted_fallback_url : null,
      intent: parseIntent(row.intent),
      expiresAt: new Date(row.expires_at),
      consumedAt: row.consumed_at ? new Date(row.consumed_at) : null,
      fundingRecordedAt: row.funding_recorded_at ? new Date(row.funding_recorded_at) : null,
    };
  }

  /** Persist materialized headless + hosted checkout URLs for a session. */
  static async updateCheckout(
    token: string,
    checkout: {
      paymentLinkUrl: string;
      paymentLinkOptions: FundPaymentLinkOption[];
      hostedFallbackUrl?: string;
    },
  ): Promise<void> {
    await db.query(
      `UPDATE fund_sessions
       SET payment_link_url = $2,
           payment_link_options = $3,
           hosted_fallback_url = $4
       WHERE token = $1`,
      [
        token,
        checkout.paymentLinkUrl,
        JSON.stringify(checkout.paymentLinkOptions),
        checkout.hostedFallbackUrl ?? null,
      ],
    );
  }

  /**
   * Atomically mark a fund session as recorded so duplicate Coinbase success
   * events only create one activity row. Returns null when the token is unknown.
   */
  static async claimFundingRecord(
    token: string,
  ): Promise<{
    userPhone: string;
    amountUsd: number | null;
    alreadyRecorded: boolean;
    intent: FundSessionIntent | null;
    walletAddress: string | null;
  } | null> {
    const claim = await db.query(
      `UPDATE fund_sessions
       SET funding_recorded_at = NOW()
       WHERE token = $1
         AND funding_recorded_at IS NULL
       RETURNING user_phone, amount_usd, intent, wallet_address`,
      [token],
    );

    const claimed = claim.rows[0];
    if (claimed) {
      return {
        userPhone: claimed.user_phone,
        amountUsd: parseAmountUsd(claimed.amount_usd),
        alreadyRecorded: false,
        intent: parseIntent(claimed.intent),
        walletAddress: typeof claimed.wallet_address === "string" ? claimed.wallet_address : null,
      };
    }

    const existing = await db.query(
      `SELECT user_phone, amount_usd, funding_recorded_at, intent, wallet_address
       FROM fund_sessions
       WHERE token = $1`,
      [token],
    );
    const row = existing.rows[0];
    if (!row) return null;

    return {
      userPhone: row.user_phone,
      amountUsd: parseAmountUsd(row.amount_usd),
      alreadyRecorded: Boolean(row.funding_recorded_at),
      intent: parseIntent(row.intent),
      walletAddress: typeof row.wallet_address === "string" ? row.wallet_address : null,
    };
  }

  /** Purge expired sessions older than 1 hour (call periodically if needed). */
  static async purgeExpired(): Promise<void> {
    await db.query(
      `DELETE FROM fund_sessions WHERE expires_at < NOW() - INTERVAL '1 hour'`,
    );
  }
}

function parseIntent(value: unknown): FundSessionIntent | null {
  const parsed = typeof value === "string" ? safeJsonParse(value) : value;
  if (!parsed || typeof parsed !== "object") return null;
  const intent = parsed as Partial<FundSessionIntent>;
  if (intent.kind !== "gift_stock") return null;
  if (typeof intent.symbol !== "string" || !intent.recipient) return null;
  return intent as FundSessionIntent;
}

function parsePaymentLinkOptions(
  value: unknown,
  fallbackUrl: string,
): FundPaymentLinkOption[] {
  if (fallbackUrl === FUND_SESSION_PENDING_URL) return [];

  const parsed = typeof value === "string" ? safeJsonParse(value) : value;
  if (Array.isArray(parsed)) {
    const options = parsed.filter(isFundPaymentLinkOption);
    const embeddable = options.filter((o) => !isHostedCoinbaseOnrampUrl(o.url));
    if (embeddable.length > 0) return embeddable;
  }

  if (isHostedCoinbaseOnrampUrl(fallbackUrl)) return [];

  return [
    {
      method: fallbackUrl.toLowerCase().includes("google") ? "google_pay" : "apple_pay",
      label: fallbackUrl.toLowerCase().includes("google") ? "Google Pay" : "Apple Pay",
      url: fallbackUrl,
    },
  ];
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseAmountUsd(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function isFundPaymentLinkOption(value: unknown): value is FundPaymentLinkOption {
  if (!value || typeof value !== "object") return false;
  const option = value as Partial<FundPaymentLinkOption>;
  return (
    (option.method === "apple_pay" || option.method === "google_pay") &&
    (option.label === "Apple Pay" || option.label === "Google Pay") &&
    typeof option.url === "string" &&
    option.url.startsWith("https://")
  );
}
