import express, { Router, type Request, type Response } from "express";

import { fulfillStockGift, StockGiftAdapter } from "@/wallet/stockGift.js";
import { buyStockFromCash, WrenBuyError } from "@/wallet/wrenBuy.js";
import { listSpotBuyableOffers } from "@/discovery/doppler/stockCatalog.js";
import {
  followersToNotify,
  getVisibility,
  listPeople,
  movesFor,
  profile,
  recordMove,
  setNotify,
  setVisibility,
  VISIBILITIES,
  type Visibility,
} from "@/people/wrenPeople.js";
import { listActivity, recordBuy } from "@/people/wrenActivity.js";
import { cardFor, giftForCode, wrenPublicOrigin } from "@/people/wrenClaim.js";
import { cardPng, claimPageHtml } from "@/people/wrenClaimPage.js";
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
import { APPLE_PAY_MIN_USD, ApplePayError, applePayQuote, startAppApplePay } from "@/wallet/appApplePay.js";
import { issueEmailOtp, verifyEmailOtp } from "@/wallet/emailOtp.js";
import { clientIpFromRequest } from "@/wallet/fundSessionCheckout.js";
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

// ── Apple Pay (Coinbase headless onramp) ─────────────────────────────────
// POST /api/app/apple-pay { amount } → { url } for the app's WebView. Coinbase
// needs a verified email first: 409 need_email / need_email_code, then
// /apple-pay/email { email } sends a code and /apple-pay/verify { code } checks it.
router.post("/api/app/apple-pay", json, async (req, res) => {
  const user = authedSender(req, res);
  if (!user) return;
  try {
    const result = await startAppApplePay({
      phone: user,
      // `receive`: cash to land (fee on top). Build 4 sends `amount`.
      receiveUsd: Number(req.body?.receive ?? req.body?.amount),
      clientIp: clientIpFromRequest(req),
    });
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    if (err instanceof ApplePayError) {
      res.status(err.status).json({ error: err.code });
      return;
    }
    logger.error({ err }, "POST /api/app/apple-pay");
    res.status(502).json({ error: "unavailable" });
  }
});

// What an Apple Pay top-up costs, before the person taps: cash + Coinbase's fee.
router.get("/api/app/apple-pay/quote", (req: Request, res: Response) => {
  const user = authedSender(req, res);
  if (!user) return;
  const receive = Number(req.query.receive);
  if (!Number.isFinite(receive) || receive <= 0) {
    res.status(400).json({ error: "bad_amount" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({ ...applePayQuote(Math.max(receive, APPLE_PAY_MIN_USD)), minUsd: APPLE_PAY_MIN_USD });
});

router.post("/api/app/apple-pay/email", json, async (req, res) => {
  const user = authedSender(req, res);
  if (!user) return;
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    res.status(400).json({ error: "bad_email" });
    return;
  }
  try {
    await issueEmailOtp(user, email, "Wren");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "POST /api/app/apple-pay/email");
    res.status(502).json({ error: "email_failed" });
  }
});

router.post("/api/app/apple-pay/verify", json, async (req, res) => {
  const user = authedSender(req, res);
  if (!user) return;
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  try {
    const result = await verifyEmailOtp(user, code);
    if (!result.ok) {
      res.status(400).json({ error: result.reason });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "POST /api/app/apple-pay/verify");
    res.status(500).json({ error: "verify_failed" });
  }
});

// What a send would cost, before Pay: 1.5% to send, at least $0.99 (free the first time),
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
    const charge = wrenSendCharge(usd, { firstSend });
    // From cash there's no card, so no card cost: just stock + fee.
    const fromCash = req.query.payFrom === "cash";
    res.json({
      ...charge,
      cardUsd: fromCash ? 0 : charge.cardUsd,
      totalUsd: fromCash ? charge.usdcNeeded : charge.totalUsd,
      firstSend,
      payFrom: fromCash ? "cash" : "card",
    });
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
      // The app tops up cash first (Apple Pay or card), then sends from cash.
      payFrom: "cash",
    });
    await StockGiftAdapter.claimGiftStart(created.giftId);
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
      if (err.message === "not_enough_cash") {
        res.status(402).json({ error: "not_enough_cash", ...err.details });
        return;
      }
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

// ── Claim links ─────────────────────────────────────────────────────────────
// Public: /c/<code> unfurls into a card in iMessage/WhatsApp and opens Wren.
// Nothing here completes a claim; signing into Wren with the number does.
const notFoundHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Wren</title></head><body style="font-family:-apple-system,sans-serif;padding:40px 24px"><h1>This link isn't valid.</h1><p>Ask whoever sent it for a new one.</p></body></html>`;

router.get("/c/:code", async (req: Request, res: Response) => {
  try {
    const row = await giftForCode(String(req.params.code));
    if (!row) {
      res.status(404).type("html").send(notFoundHtml);
      return;
    }
    const card = await cardFor(row);
    const pageUrl = `${wrenPublicOrigin()}/c/${req.params.code}`;
    res.setHeader("Cache-Control", "public, max-age=60");
    res.type("html").send(
      claimPageHtml({
        card,
        pageUrl,
        // The state is in the image URL so a claimed card gets a fresh image.
        imageUrl: `${pageUrl}/card.png?v=${card.state}`,
        appUrl: `wren://g/${row.id}`,
        downloadUrl: process.env.WREN_DOWNLOAD_URL?.trim() || null,
      }),
    );
  } catch (err) {
    logger.error({ err }, "GET /c/:code");
    res.status(500).type("html").send(notFoundHtml);
  }
});

router.get("/c/:code/card.png", async (req: Request, res: Response) => {
  try {
    const row = await giftForCode(String(req.params.code));
    if (!row) {
      res.status(404).end();
      return;
    }
    const png = await cardPng(await cardFor(row));
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("png").send(png);
  } catch (err) {
    logger.error({ err }, "GET /c/:code/card.png");
    res.status(500).end();
  }
});

// ── Buy for yourself ────────────────────────────────────────────────────────
// From cash, no Wren fee. 402 not_enough_cash with cashUsd / neededUsd.
router.post("/api/app/buy", json, async (req: Request, res: Response) => {
  const user = authedSender(req, res);
  if (!user) return;
  try {
    const result = await buyStockFromCash({
      senderId: user,
      symbol: String(req.body?.symbol ?? ""),
      usd: Number(req.body?.usd),
    });
    // A move ("Sam bought Apple") — no amount. Followers who can see it get a push.
    void recordBuy(user, result.symbol, result.usd, result.txHash).catch((err) =>
      logger.warn({ err }, "[wren] recording the buy for Activity failed"),
    );
    void (async () => {
      await recordMove(user, "bought", result.symbol, result.txHash);
      const followers = await followersToNotify(user);
      for (const f of followers) {
        const p = await profile(f, user).catch(() => null);
        const name = p?.name ?? "Someone";
        void sendPush(f, `${name} bought ${stockDisplayName(result.symbol)}`, "Tap to see what they hold.");
      }
    })().catch((err) => logger.warn({ err }, "[wren] move/notify failed"));
    res.json(result);
  } catch (err) {
    if (err instanceof WrenBuyError) {
      res.status(err.status).json({ error: err.message, ...(err.details ?? {}) });
      return;
    }
    logger.error({ err }, "POST /api/app/buy");
    res.status(500).json({ error: "That didn't go through." });
  }
});

// ── People, moves and privacy ───────────────────────────────────────────────
function stockDisplayName(symbol: string): string {
  return listSpotBuyableOffers().find((o) => o.symbol === symbol)?.name ?? symbol.replace(/c$/, "");
}

router.get("/api/app/people", async (req: Request, res: Response) => {
  const user = authedSender(req, res);
  if (!user) return;
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await listPeople(user));
  } catch (err) {
    logger.error({ err }, "GET /api/app/people");
    res.status(500).json({ error: "Couldn't load your people." });
  }
});

router.get("/api/app/moves", async (req: Request, res: Response) => {
  const user = authedSender(req, res);
  if (!user) return;
  try {
    const mine = await getVisibility(user);
    res.setHeader("Cache-Control", "no-store");
    // sharing:false → the app shows "Share yours to see theirs."
    res.json({ sharing: mine.visibility !== "only_me", items: await movesFor(user) });
  } catch (err) {
    logger.error({ err }, "GET /api/app/moves");
    res.status(500).json({ error: "Couldn't load moves." });
  }
});

router.get("/api/app/people/:phone", async (req: Request, res: Response) => {
  const user = authedSender(req, res);
  if (!user) return;
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await profile(user, String(req.params.phone)));
  } catch (err) {
    logger.error({ err }, "GET /api/app/people/:phone");
    res.status(500).json({ error: "Couldn't load that profile." });
  }
});

router.post("/api/app/people/:phone/notify", json, async (req: Request, res: Response) => {
  const user = authedSender(req, res);
  if (!user) return;
  try {
    await setNotify(user, String(req.params.phone), Boolean(req.body?.notify));
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "POST /api/app/people/:phone/notify");
    res.status(500).json({ error: "That didn't save." });
  }
});

// Activity: the stocks you sent and where each one is. Only you see this.
router.get("/api/app/activity/sends", async (req: Request, res: Response) => {
  const user = authedSender(req, res);
  if (!user) return;
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ items: await listActivity(user) });
  } catch (err) {
    logger.error({ err }, "GET /api/app/activity/sends");
    res.status(500).json({ error: "Couldn't load." });
  }
});

router.get("/api/app/privacy", async (req: Request, res: Response) => {
  const user = authedSender(req, res);
  if (!user) return;
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getVisibility(user));
  } catch (err) {
    logger.error({ err }, "GET /api/app/privacy");
    res.status(500).json({ error: "Couldn't load that." });
  }
});

router.post("/api/app/privacy", json, async (req: Request, res: Response) => {
  const user = authedSender(req, res);
  if (!user) return;
  const visibility = String(req.body?.visibility ?? "") as Visibility;
  if (!VISIBILITIES.includes(visibility)) {
    res.status(400).json({ error: "Pick only_me or your_people." });
    return;
  }
  try {
    await setVisibility(user, visibility);
    res.json({ visibility, chosen: true });
  } catch (err) {
    logger.error({ err }, "POST /api/app/privacy");
    res.status(500).json({ error: "That didn't save." });
  }
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
