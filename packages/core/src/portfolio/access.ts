import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_PURPOSE = "portfolio_view";
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export type AccessTokenPurpose = typeof TOKEN_PURPOSE;

interface PortfolioTokenPayload {
  sub: string;
  exp: number;
  purpose: AccessTokenPurpose;
}

export type AccessTokenFailure = "missing" | "malformed" | "signature" | "subject" | "expired";

function secret(): string {
  const value = process.env.PORTFOLIO_LINK_SECRET?.trim() || process.env.SERVICE_API_KEY?.trim();
  if (!value) {
    throw new Error("PORTFOLIO_LINK_SECRET or SERVICE_API_KEY is required for portfolio links");
  }
  return value;
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sign(payload: string): string {
  return base64Url(createHmac("sha256", secret()).update(payload).digest());
}

function createAccessToken(
  senderId: string,
  purpose: AccessTokenPurpose,
  opts: { now?: number; ttlMs?: number } = {},
): string {
  const now = opts.now ?? Date.now();
  const payload: PortfolioTokenPayload = {
    sub: senderId,
    exp: now + (opts.ttlMs ?? DEFAULT_TTL_MS),
    purpose,
  };
  const encoded = base64Url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

function verifyAccessToken(
  senderId: string,
  token: string,
  purposes: readonly AccessTokenPurpose[],
  opts: { now?: number } = {},
): { ok: true; purpose: AccessTokenPurpose } | { ok: false; reason: AccessTokenFailure } {
  if (!token) return { ok: false, reason: "missing" };
  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) return { ok: false, reason: "malformed" };

  const expected = sign(payloadPart);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signaturePart);
  if (
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    return { ok: false, reason: "signature" };
  }

  let payload: PortfolioTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as PortfolioTokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (!purposes.includes(payload.purpose) || payload.sub !== senderId) {
    return { ok: false, reason: "subject" };
  }
  if (payload.exp <= (opts.now ?? Date.now())) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, purpose: payload.purpose };
}

export function createPortfolioAccessToken(
  senderId: string,
  opts: { now?: number; ttlMs?: number } = {},
): string {
  return createAccessToken(senderId, TOKEN_PURPOSE, opts);
}

export function verifyPortfolioAccessToken(
  senderId: string,
  token: string,
  opts: { now?: number } = {},
): { ok: true } | { ok: false; reason: AccessTokenFailure } {
  const result = verifyAccessToken(senderId, token, [TOKEN_PURPOSE], opts);
  return result.ok ? { ok: true } : result;
}

export function buildSignedPortfolioUrl(senderId: string): string {
  const baseUrl = process.env.PORTFOLIO_VIEW_BASE_URL?.trim() || "https://basemate-metrics.up.railway.app/portfolio";
  const url = new URL(baseUrl);
  url.searchParams.set("user", senderId);
  url.searchParams.set("token", createPortfolioAccessToken(senderId));
  return url.toString();
}

/** Returns null when PORTFOLIO_LINK_SECRET / SERVICE_API_KEY is not configured. */
export function tryBuildSignedPortfolioUrl(userId: string): string | null {
  try {
    return buildSignedPortfolioUrl(userId);
  } catch {
    return null;
  }
}
