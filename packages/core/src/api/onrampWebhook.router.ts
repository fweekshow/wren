import { Router, type Request, type Response } from "express";
import express from "express";

import { config } from "@/config/config.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { logger } from "@/utils/logger.js";
import { recordOnrampFunding } from "@/wallet/recordOnrampFunding.js";
import { startStockGiftAfterFunding, StockGiftAdapter } from "@/wallet/stockGift.js";

const router = Router();
const json = express.json({ limit: "256kb" });

interface OnrampWebhookPayload {
  eventType?: string;
  status?: string;
  destinationAddress?: string;
  walletAddress?: string;
  partnerUserRef?: string;
  paymentTotal?: string;
  paymentSubtotal?: string;
  orderId?: string;
  id?: string;
}

/**
 * Coinbase Onramp transaction webhooks — source of truth when the user closes
 * /pay before postMessage polling_success fires. Register in CDP portal.
 *
 * Returns 200 quickly; stock-gift fulfillment is fire-and-forget (never await
 * the swap inside the webhook). Never buys from recordOnrampFunding alone.
 */
router.post("/api/webhooks/coinbase-onramp", json, async (req: Request, res: Response) => {
  const secret = config.cdp.onrampWebhookSecret;
  if (secret) {
    const header = req.headers["x-coinbase-signature"] ?? req.headers["x-hook-signature"];
    if (header !== secret) {
      res.status(401).json({ error: "Invalid webhook signature" });
      return;
    }
  }

  const payload = req.body as OnrampWebhookPayload;
  const eventType = payload.eventType ?? "";
  const isSuccess =
    eventType === "onramp.transaction.success" ||
    (eventType === "onramp.transaction.updated" &&
      String(payload.status ?? "").includes("COMPLETED"));

  if (!isSuccess) {
    res.json({ ok: true, ignored: true });
    return;
  }

  try {
    const destination = (payload.destinationAddress ?? payload.walletAddress ?? "").toLowerCase();
    let senderId: string | null = null;

    if (destination) {
      senderId = await WalletAdapter.findByEmbeddedAddress(destination);
    }

    if (!senderId && payload.partnerUserRef) {
      const ref = payload.partnerUserRef;
      if (ref.startsWith("im-") || ref.startsWith("sandbox-")) {
        logger.warn({ partnerUserRef: ref }, "[onramp-webhook] no wallet match for partnerUserRef");
      } else {
        senderId = await WalletAdapter.findByEmbeddedAddress(ref);
      }
    }

    if (!senderId) {
      logger.warn({ payload }, "[onramp-webhook] could not resolve sender for onramp success");
      res.json({ ok: true, unmatched: true });
      return;
    }

    const amountRaw = Number(payload.paymentSubtotal ?? payload.paymentTotal);
    const amountUsd = Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : undefined;
    const orderId =
      typeof payload.orderId === "string"
        ? payload.orderId
        : typeof payload.id === "string"
          ? payload.id
          : null;

    const openGift = destination
      ? await StockGiftAdapter.findOpenByWallet(destination)
      : null;
    await recordOnrampFunding({ senderId, amountUsd, skipDm: Boolean(openGift) });

    if (destination) {
      await startStockGiftAfterFunding({
        walletAddress: destination,
        coinbaseOrderId: orderId,
      });
    }

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, payload }, "[onramp-webhook] handler failed");
    res.status(500).json({ error: "Webhook handler failed" });
  }
});

export function mountOnrampWebhookApi(app: import("express").Express): void {
  app.use(router);
}
