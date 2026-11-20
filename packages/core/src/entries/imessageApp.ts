import "@/load-env.js";

import express from "express";
import { httpLogger, logger } from "@/utils/logger.js";

import { mountFundSessionApi } from "@/api/fundSession.router.js";
import { mountPortfolioApi } from "@/api/portfolio.router.js";
import { mountPayConfirmApi } from "@/api/payConfirm.router.js";
import { mountAppApi } from "@/api/app.router.js";
import { mountMuseApi } from "@/api/muse.router.js";
import { mountWalletConnectApi } from "@/api/walletConnect.router.js";
import { config } from "@/config/config.js";
import {
  ConversationMemoryAdapter,
  PerpProfileAdapter,
  PortfolioReviewAdapter,
  PriceAlertAdapter,
  TxConfirmationAdapter,
  UserMemoryAdapter,
} from "@/discovery/adapters/index.js";
//import { dropLegacyWalletLeaderTables } from "@/discovery/adapters/legacyWalletLeaderCleanup.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { AccountLinkAdapter } from "@/account-linking/index.js";
import { connectDb } from "@/discovery/db.js";
import { ContactsAdapter } from "@/messaging/contacts.adapter.js";
import { SenderIdMigration } from "@/messaging/senderId.migration.js";
import { startImessageBot } from "@/imessage/bot.js";
import { FundSessionAdapter } from "@/wallet/fundSession.js";
import { OnrampUserDataAdapter } from "@/wallet/onrampUserData.js";
import { PhoneEscrowAdapter, logPhoneEscrowOperatorSmartAccount } from "@/wallet/phoneEscrow.js";
import { ensurePortfolioSnapshotColumns } from "@/portfolio/snapshot.js";
import { ensurePendingPayDeliveryColumns } from "@/wallet/pendingPay.schema.js";
import { ensurePhoneEscrowClaimExpiryColumns } from "@/wallet/phoneEscrow.schema.js";
import { imessageLiveness } from "@/imessage/liveness.js";
import { WebhookDeliveryAdapter } from "@/imessage/webhook.adapter.js";
import {
  isFusorWebhookDelivery,
  verifyPhotonWebhook,
  type SpectrumWebhookPayload,
} from "@/imessage/webhook.js";

// ── Spectrum webhook handler ──────────────────────────────────────────────────

/**
 * Express middleware + route handler for Spectrum webhook deliveries.
 *
 * Must be mounted BEFORE any `express.json()` middleware so the raw body
 * bytes are intact for HMAC verification — any JSON re-parsing changes the
 * byte sequence and breaks the signature check.
 *
 * Design:
 *  1. Verify the Spectrum HMAC signature and timestamp.
 *  2. Deduplicate using X-Spectrum-Webhook-Id + message.id.
 *  3. Insert into imessage_webhook_deliveries and return 200 immediately.
 *  4. The background processor in bot.ts drains the table asynchronously.
 */
export function buildSpectrumWebhookRoute(): express.Router {
  const router = express.Router();

  // Scope express.raw() to the webhook POST only. This router is also mounted at
  // `/` on channels (Photon URL mismatches), and a router-level raw parser would
  // consume every request body — including /api/agent/app/session and /api/pay/*
  // — so express.json() later never sees JSON and email verify returns
  // "Missing access token."
  // type: '*/*' accepts both 'application/json' and anything else Spectrum sends.
  router.post(
    "/",
    express.raw({ type: "*/*", limit: "1mb" }),
    async (req: express.Request, res: express.Response): Promise<void> => {
      const rawBody  = req.body instanceof Buffer ? req.body.toString("utf8") : "";
      const event    = req.header("X-Spectrum-Event");
      const webhookId = req.header("X-Spectrum-Webhook-Id") ?? "";
      const timestamp = req.header("X-Spectrum-Timestamp");
      const signature = req.header("X-Spectrum-Signature");

      if (!event || !timestamp || !signature) {
        // Fusor fanout hits this same URL with CloudEvents/protobuf and no
        // X-Spectrum-* headers. Native JSON deliveries already carry the
        // message — ACK Fusor so Photon doesn't treat the endpoint as broken.
        if (isFusorWebhookDelivery(req.headers)) {
          res.status(200).send("ok");
          return;
        }
        logger.warn(
          `[iMessage] webhook rejected — missing Spectrum headers (path=${req.baseUrl || req.path})`,
        );
        res.status(400).send("missing headers");
        return;
      }

      if (!config.spectrum.signingSecret) {
        // Signing secret not yet configured — accept the delivery but log a
        // prominent warning so operators know to set it up.
        console.warn(
          "⚠️ [iMessage] SPECTRUM_SIGNING_SECRET is not set — webhook signature NOT verified. " +
          "Set it to the secret returned when you registered the webhook URL.",
        );
      } else if (!verifyPhotonWebhook(rawBody, config.spectrum.signingSecret, signature, timestamp)) {
        const ageS = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
        console.warn(
          `⚠️ [iMessage] webhook 401 — event: ${event}, webhook-id: ${webhookId}, ` +
          `timestamp-age: ${ageS}s, sig-prefix: ${(signature ?? "").slice(0, 12)}`,
        );
        res.status(401).send("bad signature");
        return;
      }

      if (event !== "messages") {
        // Unknown event type — acknowledge so Spectrum doesn't retry endlessly.
        res.status(200).send("ok");
        return;
      }

      let payload: SpectrumWebhookPayload;
      try {
        payload = JSON.parse(rawBody) as SpectrumWebhookPayload;
      } catch {
        res.status(400).send("invalid json");
        return;
      }

      const message  = payload.message;

      // T0 / debugging: log every inbound including non-text (reactions, polls, etc.)
      logger.info(
        {
          event,
          contentType: message.content?.type,
          messageId: message.id,
          spaceId: payload.space?.id ?? message.space?.id,
          spaceType: payload.space?.type ?? message.space?.type,
          senderId: message.sender?.id,
          direction: message.direction,
        },
        "[iMessage] webhook ingest",
      );

      // Photon delivers webhook events for both inbound (user → bot) and
      // outbound (bot → user echo).  Drop echoes here — before touching the
      // queue — so the processor can never accidentally reply to its own messages.
      if (message.direction !== "inbound") {
        res.status(200).send("ok");
        return;
      }

      const senderId = message.sender?.id ?? "";
      const spaceId  = payload.space.id;
      const messageId = message.id;

      // Dedupe key: one record per message across both webhook and stream
      // ingestion. This prevents double replies when both paths see the same
      // inbound iMessage.
      const dedupeKey = `message:${messageId}`;

      try {
        const inserted = await WebhookDeliveryAdapter.insertIfNew({
          dedupeKey,
          webhookId,
          messageId,
          spaceId,
          senderId,
          payload,
        });

        if (!inserted) {
          // Duplicate delivery — Spectrum's at-least-once retry hit us again.
          res.status(200).send("ok");
          return;
        }

        logger.info(
          `[iMessage] webhook queued inbound messageId=${messageId} sender=${senderId || "?"} space=${spaceId}`,
        );
        imessageLiveness.markActivity();
      } catch (err) {
        console.error("⚠️ [iMessage] failed to enqueue webhook delivery:", err);
        // Return 500 so Spectrum retries; the next attempt will re-try the insert.
        res.status(500).send("internal error");
        return;
      }

      res.status(200).send("ok");
    },
  );

  return router;
}

// ── App entry point ───────────────────────────────────────────────────────────

export async function runImessageApp() {
  await connectDb();
  // Tables are now managed by Drizzle migrations — run `bun db:migrate` to apply.
  await ensurePendingPayDeliveryColumns();
  await ensurePhoneEscrowClaimExpiryColumns();
  await ensurePortfolioSnapshotColumns();
  // One-time data migration for legacy contact schema (safe no-op after first run):
  await ContactsAdapter.migrateToRelations();
  await SenderIdMigration.migrate();
  void logPhoneEscrowOperatorSmartAccount();

  const app = express();
  app.use(httpLogger);

  // ── Webhook route — MUST be mounted before express.json() ────────────────
  // express.raw() inside the router captures the raw body for HMAC verification.
  // Any JSON middleware mounted first would consume the body stream, making
  // verification impossible.
  app.use(config.spectrum.webhookPath, buildSpectrumWebhookRoute());

  mountFundSessionApi(app);
  mountPortfolioApi(app);
  mountPayConfirmApi(app);
  mountWalletConnectApi(app);
  mountAppApi(app);
  mountMuseApi(app);

  // Health: reflects both the outbound SDK connection (required for replies)
  // and basic server availability.  A green check here means the bot can both
  // receive webhooks and send replies.
  app.get("/health", (_req, res) => {
    const healthy = imessageLiveness.isHealthy();
    res.status(healthy ? 200 : 503).json({
      ok:       healthy,
      imessage: imessageLiveness.snapshot(),
      webhook:  { path: config.spectrum.webhookPath },
    });
  });
  app.get("/ready", (_req, res) => res.json({ ok: true, service: "basemate-imessage" }));

  await startImessageBot();

  const PORT = Number(process.env.PORT ?? 3000);
  app.listen(PORT, () =>
    logger.info(
      `🌐 iMessage app listening on :${PORT} — webhook at ${config.spectrum.webhookPath}`,
    ),
  );
}
