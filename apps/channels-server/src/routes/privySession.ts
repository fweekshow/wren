import type { Request, Response } from "express";
import { createPublicKey, verify as verifySig } from "node:crypto";

import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { canonicalizeSenderId } from "@/messaging/utils/senderId.utils.js";
import { ensureWrenColumns, phoneForPrivyUser, setPrivyUserId } from "@/messaging/wrenAccount.js";
import { connectPrefill, createConnectCode } from "@/messaging/wrenConnect.js";
import { createPortfolioAccessToken } from "@/portfolio/access.js";
import { logger } from "@/utils/logger.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type PrivyUser = {
  id?: string;
  linked_accounts?: Array<{
    type?: string;
    address?: string;
    phoneNumber?: string;
    number?: string;
    wallet_id?: string;
    id?: string;
  }>;
};

function appId(): string {
  return process.env.PRIVY_APP_ID?.trim() || "";
}

function appSecret(): string {
  return process.env.PRIVY_APP_SECRET?.trim() || "";
}

type JwtHeader = { alg?: string; kid?: string };
type JwtPayload = { sub?: string; iss?: string; aud?: string | string[]; exp?: number };

let jwksCache: { keys: Array<{ kid?: string; kty?: string; crv?: string; x?: string; y?: string }> } | null = null;

async function verifyPrivyJwt(token: string, audience: string): Promise<JwtPayload> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("Bad token.");
  const header = JSON.parse(Buffer.from(h, "base64url").toString()) as JwtHeader;
  const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as JwtPayload;
  if (header.alg !== "ES256") throw new Error("Unexpected token algorithm.");
  if (payload.iss !== "privy.io") throw new Error("Unexpected token issuer.");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(audience)) throw new Error("Unexpected token audience.");
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) throw new Error("Token expired.");
  if (!jwksCache) {
    const res = await fetch(`https://auth.privy.io/api/v1/apps/${audience}/jwks.json`);
    if (!res.ok) throw new Error("Could not load sign-in keys.");
    jwksCache = (await res.json()) as typeof jwksCache;
  }
  const jwk = jwksCache?.keys.find((key) => key.kid === header.kid) ?? jwksCache?.keys[0];
  if (!jwk) throw new Error("Missing sign-in key.");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  // JWS ES256 signatures are raw r||s (64 bytes), not DER — Node needs to be told.
  const ok = verifySig(
    "sha256",
    Buffer.from(`${h}.${p}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(s, "base64url"),
  );
  if (!ok) throw new Error("Bad token signature.");
  return payload;
}

async function privyUser(userId: string): Promise<PrivyUser> {
  const id = appId();
  const secret = appSecret();
  const res = await fetch(`https://auth.privy.io/api/v1/users/${encodeURIComponent(userId)}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "privy-app-id": id,
    },
  });
  if (!res.ok) throw new Error(`Privy user lookup failed (${res.status}).`);
  return (await res.json()) as PrivyUser;
}

export async function privySession(req: Request, res: Response): Promise<void> {
  const accessToken = typeof req.body?.accessToken === "string" ? req.body.accessToken.trim() : "";
  const hintedAddress = typeof req.body?.address === "string" ? req.body.address.trim() : "";
  if (!accessToken) {
    res.status(400).json({ error: "Missing access token." });
    return;
  }
  if (!appId() || !appSecret()) {
    res.status(500).json({ error: "Sign-in is not configured." });
    return;
  }
  try {
    const verified = await verifyPrivyJwt(accessToken, appId());
    const privyId = String(verified.sub ?? "");
    if (!privyId) {
      res.status(401).json({ error: "Could not verify sign-in." });
      return;
    }
    const user = await privyUser(privyId);
    const accounts = user.linked_accounts ?? [];
    const walletAccount = accounts.find(
      (account) =>
        (account.type === "wallet" || account.type === "smart_wallet") &&
        account.address?.startsWith("0x"),
    );
    const address = (hintedAddress || walletAccount?.address || "").toLowerCase();
    const walletId = walletAccount?.wallet_id || walletAccount?.id || privyId;
    const phoneAccount = accounts.find((account) => account.type === "phone");
    let phone = canonicalizeSenderId(phoneAccount?.phoneNumber || phoneAccount?.number || "");
    if (!phone.startsWith("+")) {
      // Email sign-in (outside the US). Use the number they confirmed before,
      // or hand back a connect code: the number that texts it becomes theirs.
      const hasEmail = accounts.some((account) => account.type === "email");
      const known = hasEmail ? await phoneForPrivyUser(privyId) : null;
      if (known) {
        phone = known;
      } else if (hasEmail) {
        const connect = await createConnectCode({ pending: { privyUserId: privyId, walletId, address } });
        res.setHeader("Cache-Control", "no-store");
        res.json({ needsPhone: true, connect: { ...connect, targets: connectTargets(connect.code) } });
        return;
      } else {
        res.status(400).json({ error: "Add a phone number to continue." });
        return;
      }
    }
    if (address.startsWith("0x")) {
      // The wallet row's schema includes privy_user_id; add the column before
      // the first insert, not after (setPrivyUserId would be too late).
      await ensureWrenColumns();
      await WalletAdapter.setEmbeddedWallet(phone, {
        cdpUserId: walletId,
        address,
        delegationId: "privy",
        delegationExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      });
      await setPrivyUserId(phone, privyId);
    }
    const token = createPortfolioAccessToken(phone, { ttlMs: SESSION_TTL_MS });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      user: phone,
      token,
      address,
      expiresInMs: SESSION_TTL_MS,
    });
  } catch (err) {
    logger.error({ err }, "POST /api/app/privy-session");
    res.status(401).json({ error: "Could not verify sign-in." });
  }
}

export function connectTargets(code: string | null = null) {
  const prefill = connectPrefill(code);
  return {
    imessage: {
      number: process.env.WREN_IMESSAGE_NUMBER?.trim() || "",
      prefill,
    },
    whatsapp: {
      number: process.env.WREN_WHATSAPP_NUMBER?.trim() || "",
      prefill,
    },
  };
}
