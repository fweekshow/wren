import express, { type Request, type Response, Router } from "express";

import { browserApiCors } from "@/api/cors.js";
import {
  createMuseStockGiftCheckout,
  listPublicMuseStocks,
  MuseCheckoutError,
} from "@/api/museCheckout.service.js";
import { publicMuseSend } from "@/api/muse.status.js";
import { config } from "@/config/config.js";
import { logger } from "@/utils/logger.js";
import { StockGiftAdapter } from "@/wallet/stockGift.js";

const router = Router();
const json = express.json({ limit: "32kb" });

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 20;
const hits = new Map<string, number[]>();

function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = (typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : "") || req.ip || "";
  return raw || "unknown";
}

function rateLimited(req: Request): boolean {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

router.get("/api/muse/stocks", async (_req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "public, max-age=15, stale-while-revalidate=60");
    res.json({ items: listPublicMuseStocks() });
  } catch (err) {
    logger.error({ err }, "GET /api/muse/stocks");
    res.status(500).json({ error: "Could not load sendable stocks." });
  }
});

async function createSend(req: Request, res: Response): Promise<void> {
  if (rateLimited(req)) {
    res.status(429).json({ error: "Too many send attempts. Try again in a few minutes." });
    return;
  }
  try {
    const symbol = typeof req.body?.symbol === "string" ? req.body.symbol : "";
    const usd = typeof req.body?.usd === "string" ? req.body.usd : String(req.body?.usd ?? "");
    const memo = typeof req.body?.memo === "string" ? req.body.memo : undefined;
    const payerPhone = typeof req.body?.payer?.phone === "string" ? req.body.payer.phone : undefined;
    const payerEmail = typeof req.body?.payer?.email === "string" ? req.body.payer.email : undefined;
    const payerName = typeof req.body?.payer?.name === "string" ? req.body.payer.name : undefined;
    const name = typeof req.body?.recipient?.name === "string" ? req.body.recipient.name : undefined;
    const phone = typeof req.body?.recipient?.phone === "string" ? req.body.recipient.phone : undefined;
    const recipientEmail =
      typeof req.body?.recipient?.email === "string" ? req.body.recipient.email : undefined;
    const amount = Number(usd);
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: "usd must be a positive number." });
      return;
    }
    if (amount > config.muse.maxUsd) {
      res.status(400).json({ error: `usd cannot exceed ${config.muse.maxUsd}.` });
      return;
    }
    const result = await createMuseStockGiftCheckout({
      symbol,
      usd: String(usd).trim(),
      memo,
      payer: { phone: payerPhone, email: payerEmail, name: payerName },
      recipient: { name, phone, email: recipientEmail },
    });
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    if (err instanceof MuseCheckoutError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error({ err }, "POST /api/muse/sends");
    res.status(500).json({ error: "Couldn't start that send." });
  }
}

router.post("/api/muse/sends", json, createSend);
router.post("/api/muse/gifts", json, createSend);

router.get("/api/muse/sends/:id", getSend);
router.get("/api/muse/gifts/:id", getSend);

async function getSend(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      res.status(400).json({ error: "Missing send id." });
      return;
    }
    const row = await StockGiftAdapter.get(id);
    if (!row) {
      res.status(404).json({ error: "Send not found." });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(publicMuseSend(row));
  } catch (err) {
    logger.error({ err }, "GET /api/muse/sends/:id");
    res.status(500).json({ error: "Could not load that send." });
  }
}

export function mountMuseApi(app: import("express").Express): void {
  app.use("/api/muse", browserApiCors);
  app.use(router);
}
