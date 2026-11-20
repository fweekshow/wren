import express, { Router, type Request, type Response } from "express";

import { fulfillStockGift, StockGiftAdapter } from "@/wallet/stockGift.js";
import { wrenSendCharge } from "@/discovery/stocks/giftStock.service.js";
import {
  startPriceHistoryJob,
  stockMarket,
  stockPriceHistory,
  type PriceRange,
} from "@/discovery/stocks/priceHistory.js";
import {
  createWebStockGiftCheckout,
  WebGiftError,
} from "@/api/webGift.service.js";
import { authedSender } from "@/api/wrenAuth.js";
import {
  addPushToken,
  clearOptIn,
  readConnectState,
} from "@/messaging/wrenAccount.js";
import { sendPush } from "@/messaging/wrenOutbound.js";
import { createConnectCode, pollConnectCode } from "@/messaging/wrenConnect.js";
import { createPortfolioAccessToken } from "@/portfolio/access.js";
import { logger } from "@/utils/logger.js";
import { connectTargets, privySession } from "../../../../apps/channels-server/src/routes/privySession.js";

const router = Router();
const json = express.json({ limit: "64kb" });

router.post("/api/app/privy-session", json, (req, res) => {
  void privySession(req, res);
});

router.get("/api/app/connect-targets", async (req, res) => {
  const user = authedSender(req, res);
  if (!user) return;
  try {
    const connect = await createConnectCode({ phone: user });
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...connectTargets(connect.code), code: connect.code });
  } catch (err) {
    logger.error({ err }, "GET /api/app/connect-targets");
    res.json(connectTargets());
  }
});

// Email sign-in waits here for its connect text. Unauthenticated: the code and
// its secret came back from /api/app/privy-session, and only that app has the secret.
router.post("/api/app/connect-code/poll", json, async (req, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  const secret = typeof req.body?.secret === "string" ? req.body.secret : "";
  if (!code || !secret) {
    res.status(400).json({ error: "Missing code." });
    return;
  }
  try {
    const result = await pollConnectCode(code, secret);
    res.setHeader("Cache-Control", "no-store");
    if (result.status !== "done") {
      res.json({ status: result.status });
      return;
    }
    res.json({
      status: "done",
      user: result.phone,
      token: createPortfolioAccessToken(result.phone, { ttlMs: 30 * 24 * 60 * 60 * 1000 }),
    });
  } catch (err) {
    logger.error({ err }, "POST /api/app/connect-code/poll");
    res.status(500).json({ error: "Try again." });
  }
});

router.get("/api/app/connect", async (req, res) => {
  const user = authedSender(req, res);
  if (!user) return;
  const state = await readConnectState(user);
  res.json(
    state ?? {
      phone: user,
      imessageOptedInAt: null,
      imessageService: null,
      whatsappOptedInAt: null,
      whatsappDisplayName: null,
    },
  );
});

router.delete("/api/app/opt-in/:channel", async (req, res) => {
  const user = authedSender(req, res);
  if (!user) return;
  const channel = req.params.channel;
  if (channel !== "imessage" && channel !== "whatsapp") {
    res.status(400).json({ error: "Unknown channel." });
    return;
  }
  await clearOptIn(user, channel);
  res.json({ ok: true });
});

router.post("/api/app/push-tokens", json, async (req, res) => {
  const user = authedSender(req, res);
  if (!user) return;
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  if (!token) {
    res.status(400).json({ error: "Missing token." });
    return;
  }
  await addPushToken(user, token);
  res.json({ ok: true });
});

router.post("/api/app/pay", json, async (req, res) => {
  const user = authedSender(req, res);
  if (!user) return;
  const method = req.body?.method;
  const amount = Number(req.body?.amount);
  if (method !== "apple" && method !== "card" && method !== "bank") {
    res.status(400).json({ error: "Pick a way to pay." });
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: "Enter an amount." });
    return;
  }
  const provider = method === "bank" ? "bridge" : "stripe";
  const paymentMethod = method === "apple" ? "apple_pay" : method === "card" ? "card" : "ach";
  try {
    const appId = process.env.PRIVY_APP_ID?.trim() || "";
    const secret = process.env.PRIVY_APP_SECRET?.trim() || "";
    if (!appId || !secret) {
      res.status(503).json({ error: "Payments are not ready yet." });
      return;
    }
    const response = await fetch("https://api.privy.io/v1/fiat/onramp", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString("base64")}`,
        "privy-app-id": appId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: user,
        amount: amount.toFixed(2),
        currency: "usd",
        provider,
        payment_method: paymentMethod,
        destination_chain: "base",
        destination_asset: "usdc",
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { client_secret?: string; error?: string };
    if (!response.ok) {
      res.status(502).json({ error: "That payment didn't start." });
      return;
    }
    res.json({
      ok: true,
      method,
      clientSecret: body.client_secret ?? null,
    });
  } catch (err) {
    logger.error({ err }, "POST /api/app/pay");
    res.status(502).json({ error: "That payment didn't start." });
  }
});

// What a send would cost, before Pay: $2.99 to send (free the first time),
// plus the card cost at what Coinbase charges.
router.get("/api/app/send-quote", async (req: Request, res: Response) => {
  const user = authedSender(req, res);
  if (!user) return;
  const usd = Number(req.query.usd);
  if (!Number.isFinite(usd) || usd <= 0) {
    res.status(400).json({ error: "Enter an amount." });
    return;
  }
  try {
    const firstSend = (await StockGiftAdapter.countCompletedBySender(user)) === 0;
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...wrenSendCharge(usd, { firstSend }), firstSend });
  } catch (err) {
    logger.error({ err }, "GET /api/app/send-quote");
    res.status(500).json({ error: "Couldn't price that." });
  }
});

router.post("/api/app/stock-gifts/send", json, async (req: Request, res: Response) => {
  const user = authedSender(req, res);
  if (!user) return;
  try {
    const created = await createWebStockGiftCheckout({
      senderId: user,
      channel: req.body?.channel === "whatsapp" ? "whatsapp" : "imessage",
      symbol: String(req.body?.symbol ?? ""),
      usd: String(req.body?.usd ?? ""),
      recipient: {
        name: req.body?.recipient?.name,
        phone: req.body?.recipient?.phone,
      },
      pricing: "wren",
    });
    void fulfillStockGift(created.giftId).catch((err) => {
      logger.error({ err }, "fulfill stock gift");
    });
    void sendPush(user, "Sent", `On the way to ${req.body?.recipient?.name || "them"}.`);
    res.json({
      giftId: created.giftId,
      chargeUsd: created.chargeUsd,
      feeUsd: created.feeUsd ?? null,
      firstSend: created.firstSend ?? false,
      status: "buying",
    });
  } catch (err) {
    if (err instanceof WebGiftError) {
      res.status(err.status).json({ error: "That didn't go through." });
      return;
    }
    logger.error({ err }, "POST /api/app/stock-gifts/send");
    res.status(500).json({ error: "That didn't go through." });
  }
});

const termsHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Terms</title></head><body><h1>Terms</h1><p>Wren lets you send stocks to people you know. By continuing you agree to pay the amount you confirm and to receive texts about those sends.</p></body></html>`;
const privacyHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Privacy</title></head><body><h1>Privacy</h1><p>Wren stores your phone number, the people you send to, and the stocks you hold so the app can work. We don't sell that information.</p></body></html>`;

router.get("/terms", (_req, res) => {
  res.type("html").send(termsHtml);
});
router.get("/privacy", (_req, res) => {
  res.type("html").send(privacyHtml);
});

// ── Market data (public) ────────────────────────────────────────────────────
// Prices, "today" change and sparklines for every sendable stock.
let marketCache: { at: number; body: unknown } | null = null;
router.get("/api/app/market", async (_req: Request, res: Response) => {
  try {
    if (!marketCache || Date.now() - marketCache.at > 60_000) {
      marketCache = { at: Date.now(), body: { items: await stockMarket() } };
    }
    res.json(marketCache.body);
  } catch (err) {
    logger.error({ err }, "GET /api/app/market");
    res.status(500).json({ error: "Couldn't load prices." });
  }
});

const RANGES = new Set(["1D", "1W", "1M", "1Y"]);
router.get("/api/app/stocks/:symbol/history", async (req: Request, res: Response) => {
  const range = String(req.query.range ?? "1D").toUpperCase();
  if (!RANGES.has(range)) {
    res.status(400).json({ error: "Pick 1D, 1W, 1M or 1Y." });
    return;
  }
  try {
    res.json(await stockPriceHistory(String(req.params.symbol), range as PriceRange));
  } catch (err) {
    logger.error({ err }, "GET /api/app/stocks/:symbol/history");
    res.status(500).json({ error: "Couldn't load the chart." });
  }
});

export function mountWrenApi(app: import("express").Express): void {
  app.use(router);
  startPriceHistoryJob();
}
