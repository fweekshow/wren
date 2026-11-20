/**
 * channelsApp — combined iMessage + WhatsApp service.
 *
 * Runs both messaging channels from a single Railway service, eliminating
 * the overhead of two separate deployments for what is effectively the same
 * bot with different transport layers. Both channels share:
 *   - A single DB connection pool
 *   - A single Express HTTP server (webhooks on /imessage/*, health on /)
 *   - Shared adapter table setup (ContactsAdapter.migrateToRelations once)
 *   - A single poller worker (EscrowReleasePoller, EscrowRefundPoller, PortfolioReviewPoller)
 *
 * Set DISABLE_WHATSAPP=true or DISABLE_IMESSAGE=true to run only one channel
 * (useful for staged rollouts or local debugging).
 */

import "@/load-env.js";

import express from "express";
import { config } from "@/config/config.js";
import { httpLogger, logger } from "@/utils/logger.js";

import { AccountLinkAdapter } from "@/account-linking/index.js";
import { mountFundSessionApi } from "@/api/fundSession.router.js";
import { mountOnrampWebhookApi } from "@/api/onrampWebhook.router.js";
import { mountOfframpApi } from "@/api/offramp.router.js";
import { mountPortfolioApi } from "@/api/portfolio.router.js";
import { mountPayConfirmApi } from "@/api/payConfirm.router.js";
import { mountAppApi } from "@/api/app.router.js";
import { mountWrenApi } from "@/api/wren.router.js";
import { mountMuseApi } from "@/api/muse.router.js";
import { mountWalletConnectApi } from "@/api/walletConnect.router.js";
import { validateCdpOnrampConfig } from "@/wallet/onrampConfigCheck.js";
import {
  ConversationMemoryAdapter,
  PortfolioReviewAdapter,
  PriceAlertAdapter,
  TxConfirmationAdapter,
  UserMemoryAdapter,
} from "@/discovery/adapters/index.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { connectDb } from "@/discovery/db.js";
import { ContactsAdapter } from "@/messaging/contacts.adapter.js";
import { SenderIdMigration } from "@/messaging/senderId.migration.js";
import { imessageLiveness } from "@/imessage/liveness.js";
import { WebhookDeliveryAdapter } from "@/imessage/webhook.adapter.js";
import { buildSpectrumWebhookRoute } from "@/entries/imessageApp.js";
import { startImessageBot, startImessagePollerWorker } from "@/imessage/bot.js";
import { FundSessionAdapter } from "@/wallet/fundSession.js";
import { OnrampUserDataAdapter } from "@/wallet/onrampUserData.js";
import { PhoneEscrowAdapter, logPhoneEscrowOperatorSmartAccount } from "@/wallet/phoneEscrow.js";
import { SWEAR_JAR_BRAIN, SWEAR_JAR_ENABLED } from "@/swear-jar/constants.js";
import { ensurePortfolioSnapshotColumns } from "@/portfolio/snapshot.js";
import { ensurePendingPayDeliveryColumns } from "@/wallet/pendingPay.schema.js";
import { ensurePhoneEscrowClaimExpiryColumns } from "@/wallet/phoneEscrow.schema.js";
import { startWhatsappBot } from "@/whatsapp/bot.js";
import { WhatsappCursorAdapter } from "@/whatsapp/cursor.adapter.js";
import { whatsappLiveness } from "@/whatsapp/liveness.js";
import { deleteWebhook } from "@/telegram/api.js";
const disableImessage = process.env.DISABLE_IMESSAGE === "true";
const disableWhatsapp =
  process.env.DISABLE_WHATSAPP === "true" ||
  !process.env.WHATSAPP_ACCESS_TOKEN?.trim();

export async function runChannelsApp(): Promise<void> {
  logger.info("🚀 Starting Basemate Channels (iMessage + WhatsApp)");

  type BootPhase = "starting" | "ready" | "failed";
  let boot: BootPhase = "starting";
  let bootError: string | undefined;

  const app = express();
  app.use(httpLogger);

  // Listen before DB/schema boot so Railway healthchecks see a live process (US-West blips).
  app.get("/health", (_req, res) => {
    if (boot === "starting") {
      return res.status(200).json({ ok: false, booting: true, service: "basemate-channels" });
    }
    if (boot === "failed") {
      return res.status(503).json({ ok: false, error: bootError, service: "basemate-channels" });
    }
    const imHealthy = disableImessage ? true : imessageLiveness.isHealthy();
    const waHealthy = disableWhatsapp ? true : whatsappLiveness.isHealthy();
    const ok = imHealthy && waHealthy;
    res.status(ok ? 200 : 503).json({
      ok,
      imessage: disableImessage ? "disabled" : imessageLiveness.snapshot(),
      whatsapp: disableWhatsapp ? "disabled" : whatsappLiveness.snapshot(),
    });
  });
  app.get("/ready", (_req, res) => {
    if (boot !== "ready") {
      return res.status(503).json({ ok: false, booting: boot === "starting", service: "basemate-channels" });
    }
    res.json({ ok: true, service: "basemate-channels" });
  });

  const PORT = Number(process.env.PORT ?? 3000);
  await new Promise<void>((resolve) => {
    app.listen(PORT, () => {
      logger.info(`🌐 Channels app listening on :${PORT} (database boot…)`);
      resolve();
    });
  });

  try {
    await connectDb();
    await ensurePendingPayDeliveryColumns();
    await ensurePhoneEscrowClaimExpiryColumns();
    await ensurePortfolioSnapshotColumns();
    await ContactsAdapter.migrateToRelations();
    await SenderIdMigration.migrate();

    const tableSetups = [
      () => ConversationMemoryAdapter.createTable(),
      () => PortfolioReviewAdapter.createTable(),
      () => PriceAlertAdapter.createTable(),
      () => TxConfirmationAdapter.createTable(),
      () => UserMemoryAdapter.createTable(),
      () => WalletAdapter.createTable(),
      () => AccountLinkAdapter.createTable(),
      () => FundSessionAdapter.createTable(),
      () => OnrampUserDataAdapter.createTable(),
      () => PhoneEscrowAdapter.createTable(),
      () => WebhookDeliveryAdapter.createTable(),
      () => WhatsappCursorAdapter.createTable(),
    ];
    for (const setup of tableSetups) {
      await setup();
    }
    void logPhoneEscrowOperatorSmartAccount();
    boot = "ready";
    logger.info("✅ Channels database boot complete");
    logger.info(
      {
        flashEnabled: config.flash.enabled,
        flashMarketSwaps: config.flash.enabled
          ? "definitive (no Uniswap fallback)"
          : "legacy Uniswap/Aerodrome",
      },
      config.flash.enabled
        ? "✅ Definitive Flash ENABLED for market swaps"
        : "⚠️ FLASH_API_KEY unset — market swaps use legacy DEX",
    );
    logger.info(
      { swearJarEnabled: SWEAR_JAR_ENABLED, swearJarBrain: SWEAR_JAR_BRAIN },
      SWEAR_JAR_ENABLED
        ? SWEAR_JAR_BRAIN
          ? "✅ Alexander swear jar ENABLED (hybrid brain)"
          : "✅ Alexander swear jar ENABLED (regex only)"
        : "Alexander swear jar off",
    );
  } catch (err) {
    boot = "failed";
    bootError = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Channels database boot failed");
    throw err;
  }

  // ── iMessage webhook — MUST be mounted before express.json() ────────────────
  // The Spectrum webhook route uses express.raw() internally to capture the exact
  // body bytes for HMAC signature verification. A global express.json() mounted
  // first would consume and re-parse the body stream, leaving rawBody empty and
  // making every signature check fail with a 401. Re-uses imessageApp.ts's route.
  //
  // Mount on both `/spectrum-webhook` and `/` so Photon dashboard URL mismatches
  // (common after Railway hostname changes) still deliver inbound messages.
  if (!disableImessage) {
    const spectrumWebhook = buildSpectrumWebhookRoute();
    const webhookPaths = new Set<string>([
      config.spectrum.webhookPath,
      "/spectrum-webhook",
      "/",
    ]);
    for (const path of webhookPaths) {
      app.use(path, spectrumWebhook);
    }
    logger.info(
      `[iMessage] Spectrum webhook mounted at ${[...webhookPaths].join(", ")} — ` +
        "Photon must POST inbound `messages` events to one of these paths on this service's public URL",
    );
  }

  app.use(express.json());
  mountFundSessionApi(app);
  mountOnrampWebhookApi(app);
  mountOfframpApi(app);
  mountPortfolioApi(app);
  mountPayConfirmApi(app);
  mountWalletConnectApi(app);
  mountAppApi(app);
  mountWrenApi(app);
  mountMuseApi(app);

  validateCdpOnrampConfig();

  // ── Start bots ──────────────────────────────────────────────────────────────
  const starts: Promise<unknown>[] = [];

  if (!disableImessage) {
    logger.info("📱 Starting iMessage bot");
    starts.push(startImessageBot());
  } else {
    logger.info("⏭️ iMessage disabled (DISABLE_IMESSAGE=true)");
  }

  if (!disableWhatsapp) {
    logger.info("💬 Starting WhatsApp bot");
    starts.push(startWhatsappBot());
  } else {
    logger.info("⏭️ WhatsApp disabled (DISABLE_WHATSAPP=true)");
  }

  await Promise.all(starts);

  logger.info("⏭️ Telegram VibeTrading off — removing webhook");
  await deleteWebhook().catch((err) =>
    logger.warn(`[Telegram] deleteWebhook failed: ${(err as Error).message}`),
  );

  // ── Poller worker (if no dedicated poller service) ──────────────────────────
  if (process.env.RUN_POLLERS === "true") {
    logger.info("🔔 Starting iMessage poller worker (RUN_POLLERS=true)");
    await startImessagePollerWorker();
  }

}
