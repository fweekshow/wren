import { Router, type Request, type Response } from "express";
import express from "express";

import { giftRecipientLine } from "@/api/muse.status.js";
import { logger } from "@/utils/logger.js";
import { FundSessionAdapter } from "@/wallet/fundSession.js";
import { recordOnrampFunding } from "@/wallet/recordOnrampFunding.js";
import { startStockGiftAfterFunding } from "@/wallet/stockGift.js";
import {
  phoneForOnrampLimits,
  requestEmbeddedLimitUpgrade,
} from "@/wallet/onrampLimits.js";

const router = Router();
const json = express.json({ limit: "32kb" });
const FUND_SESSION_TOKEN_RE = /^[a-f0-9]{21}$/i;

/** Jul 15-style: return stored checkout from Postgres (minted in iMessage). */
router.get("/api/agent/fund-session", async (req: Request, res: Response) => {
  const token =
    typeof req.query.token === "string"
      ? req.query.token
      : typeof req.query.s === "string"
        ? req.query.s
        : "";

  if (!token || !FUND_SESSION_TOKEN_RE.test(token)) {
    res.status(400).json({ error: "Missing or invalid fund session token" });
    return;
  }

  try {
    const session = await FundSessionAdapter.get(token);
    if (!session) {
      res.status(404).json({ error: "Fund session not found or expired" });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    const isGift = session.intent?.kind === "gift_stock";
    res.json({
      paymentLinkUrl: session.paymentLinkUrl,
      paymentLinkOptions: session.paymentLinkOptions,
      hostedFallbackUrl: session.hostedFallbackUrl ?? undefined,
      amountUsd: session.amountUsd ?? undefined,
      expiresAt: session.expiresAt.toISOString(),
      intent: session.intent ?? undefined,
      isGift,
      giftLabel: isGift ? session.intent?.symbol : undefined,
      recipientDisplay: isGift ? (giftRecipientLine(session.intent?.recipient) ?? undefined) : undefined,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Server error";
    logger.error({ err }, "GET /api/agent/fund-session");
    res.status(500).json({ error: message });
  }
});

router.post("/api/agent/limit-upgrade-url", json, async (req: Request, res: Response) => {
  const token =
    typeof req.body?.sessionToken === "string"
      ? req.body.sessionToken.trim()
      : typeof req.query.token === "string"
        ? req.query.token.trim()
        : "";

  if (!token || !FUND_SESSION_TOKEN_RE.test(token)) {
    res.status(400).json({ error: "Missing or invalid fund session token" });
    return;
  }

  try {
    const session = await FundSessionAdapter.get(token);
    if (!session) {
      res.status(404).json({ error: "Fund session not found or expired" });
      return;
    }

    const phone = phoneForOnrampLimits(session.userPhone);
    const { upgradeUrl, expiresAt } = await requestEmbeddedLimitUpgrade(phone);
    res.setHeader("Cache-Control", "no-store");
    res.json({ upgradeUrl, expiresAt });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Server error";
    if (message === "LIMIT_UPGRADE_ALREADY_COMPLETE") {
      res.status(409).json({
        error: "Your Coinbase guest limits are already upgraded for this phone.",
        alreadyComplete: true,
      });
      return;
    }
    logger.error({ err }, "POST /api/agent/limit-upgrade-url");
    res.status(502).json({ error: message });
  }
});

router.post("/api/agent/record-funding-session", json, async (req: Request, res: Response) => {
  const token =
    typeof req.body?.sessionToken === "string"
      ? req.body.sessionToken.trim()
      : typeof req.body?.s === "string"
        ? req.body.s.trim()
        : "";

  if (!token || !FUND_SESSION_TOKEN_RE.test(token)) {
    res.status(400).json({ error: "Missing or invalid fund session token" });
    return;
  }

  const amountRaw = Number(req.body?.amount);
  const amountOverride =
    Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : undefined;

  try {
    const session = await FundSessionAdapter.claimFundingRecord(token);
    if (!session) {
      res.status(404).json({ error: "Fund session not found" });
      return;
    }

    const isGift = session.intent?.kind === "gift_stock";
    const giftId = session.intent?.giftId ?? null;

    if (!session.alreadyRecorded) {
      await recordOnrampFunding({
        senderId: session.userPhone,
        amountUsd: amountOverride ?? session.amountUsd ?? undefined,
        skipDm: isGift,
      });
    }

    if (isGift) {
      await startStockGiftAfterFunding({
        giftId,
        fundSessionToken: token,
        walletAddress: session.walletAddress,
      });
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      alreadyRecorded: session.alreadyRecorded,
      isGift,
      giftId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Server error";
    logger.error({ err }, "POST /api/agent/record-funding-session");
    res.status(500).json({ error: message });
  }
});

/** Gift status for /pay/success — claim URL once escrowed. */
router.get("/api/agent/gift-status", async (req: Request, res: Response) => {
  const token =
    typeof req.query.token === "string"
      ? req.query.token
      : typeof req.query.s === "string"
        ? req.query.s
        : "";

  if (!token || !FUND_SESSION_TOKEN_RE.test(token)) {
    res.status(400).json({ error: "Missing or invalid fund session token" });
    return;
  }

  try {
    const { StockGiftAdapter } = await import("@/wallet/stockGift.js");
    const { db } = await import("@/discovery/db.js");

    const gift = await StockGiftAdapter.findByFundSessionToken(token);
    if (gift) {
      res.setHeader("Cache-Control", "no-store");
      res.json({
        isGift: true,
        giftId: gift.id,
        claimUrl: gift.claimUrl,
        recipientDisplay: gift.intent.recipient?.display ?? null,
        stockLabel: gift.intent.symbol ?? null,
        txHash: gift.giftTxHash,
      });
      return;
    }

    // Fall back to fund_sessions.intent even after expiry (gift row may lag).
    const result = await db.query(
      `SELECT intent FROM fund_sessions WHERE token = $1 LIMIT 1`,
      [token],
    );
    const intent = result.rows[0]?.intent;
    const parsed = typeof intent === "string" ? JSON.parse(intent) : intent;
    if (parsed?.kind === "gift_stock") {
      res.setHeader("Cache-Control", "no-store");
      res.json({
        isGift: true,
        giftId: parsed.giftId ?? null,
        claimUrl: null,
        recipientDisplay: parsed.recipient?.display ?? null,
        stockLabel: parsed.symbol ?? null,
        txHash: null,
      });
      return;
    }

    res.json({ isGift: false });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Server error";
    logger.error({ err }, "GET /api/agent/gift-status");
    res.status(500).json({ error: message });
  }
});

export function mountFundSessionApi(app: import("express").Express): void {
  app.use(router);
}
