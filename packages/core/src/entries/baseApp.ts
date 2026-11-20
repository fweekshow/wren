import "@/load-env.js";

import process from "node:process";

import { checkAvantisHealth, logAvantisBackendConfig } from "@basemate/avantis-client";
import express from "express";

import { config } from "@/config/config.js";
import { httpLogger, logger } from "@/utils/logger.js";

import { AccountLinkAdapter } from "@/account-linking/index.js";
import { CopyStrategyAdapter } from "@/copy-trading/adapters/copyStrategy.adapter.js";
import { mountAnalyticsApi } from "@/api/analytics.router.js";
import { mountBoostApi } from "@/api/boost.router.js";
import { browserApiCors } from "@/api/cors.js";
import { mountKeywordsApi } from "@/api/keywords.router.js";
import { mountAppApi } from "@/api/app.router.js";
import { ensurePortfolioSnapshotColumns } from "@/portfolio/snapshot.js";
import { mountFundSessionApi } from "@/api/fundSession.router.js";
import { mountPayConfirmApi } from "@/api/payConfirm.router.js";
import { mountPortfolioApi } from "@/api/portfolio.router.js";
import { mountAccountApi } from "@/api/account.router.js";
import {
  ActivityAdapter,
  GroupAdapter,
  GroupMemberSnapshotAdapter,
  KeywordAdapter,
  NSGroupAdapter,
  PerpProfileAdapter,
  ConversationMemoryAdapter,
  PortfolioReviewAdapter,
  PriceAlertAdapter,
  ProtocolVolumeAdapter,
  RecommendationAdapter,
  StrategyAdapter,
  TokenLaunchAdapter,
  UserAdapter,
  UserMemoryAdapter,
} from "@/discovery/adapters/index.js";
//import { dropLegacyWalletLeaderTables } from "@/discovery/adapters/legacyWalletLeaderCleanup.js";
import { StrategySubscriptionAdapter } from "@/discovery/adapters/strategySubscription.adapter.js";
import { connectDb } from "@/discovery/db.js";
import { BrainDistillationWorker } from "@/discovery/strategy/brainDistillation.js";
import { PortfolioReviewPoller, PortfolioReviewWorker } from "@/portfolio-reviews/index.js";
import { isLaunchpadMode } from "@/discovery/launchpadMode.js";
import { XMTPBase } from "@/xmtp/core/index.js";
import { AccountLinkPlugin } from "@/xmtp/plugins/accountLink.plugin.js";
import { BaseContentTokenPlugin } from "@/xmtp/plugins/baseContentToken.plugin.js";
import { DiscoveryPlugin } from "@/xmtp/plugins/discovery.plugin.js";
import { InvestorFunnelPlugin } from "@/xmtp/plugins/investorFunnel.plugin.js";
import { PortfolioReviewPlugin } from "@/xmtp/plugins/portfolioReview.plugin.js";
import { PriceAlertPlugin } from "@/xmtp/plugins/priceAlert.plugin.js";
import { WorldCupPlugin } from "@/xmtp/plugins/worldCup.plugin.js";
import { WORLD_CUP_ENABLED } from "@/worldcup/constants.js";

export async function runBaseApp() {
  logger.info("🚀 Starting Basemate Discovery Agent");
  logAvantisBackendConfig();
  void checkAvantisHealth();

  type BootPhase = "starting" | "ready" | "failed";
  let boot: BootPhase = "starting";
  let bootError: string | undefined;

  const app = express();
  app.use(httpLogger);

  app.get("/health", (_req, res) => {
    if (boot === "starting") {
      return res.status(200).json({ ok: false, booting: true, service: "basemate-tba" });
    }
    if (boot === "failed") {
      return res.status(503).json({ ok: false, error: bootError, service: "basemate-tba" });
    }
    res.json({ ok: true, service: "basemate-tba" });
  });
  app.get("/ready", (_req, res) => {
    if (boot !== "ready") {
      return res.status(503).json({ ok: false, booting: boot === "starting", service: "basemate-tba" });
    }
    res.json({ ok: true, service: "basemate-tba" });
  });

  const PORT = Number(process.env.PORT ?? 3000);
  await new Promise<void>((resolve) => {
    app.listen(PORT, () => {
      logger.info(`🌐 API listening on :${PORT} (database boot…)`);
      resolve();
    });
  });

  try {
    await connectDb();
    await ensurePortfolioSnapshotColumns();
    boot = "ready";
    logger.info("✅ Basemate-tba database boot complete");
  } catch (err) {
    boot = "failed";
    bootError = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Basemate-tba database boot failed");
    throw err;
  }

  app.use("/api/keywords", browserApiCors);
  app.use("/api/boost", browserApiCors);
  app.use("/api/groups", browserApiCors);
  app.use(express.json());
  mountKeywordsApi(app);
  mountBoostApi(app);
  mountAnalyticsApi(app);
  mountPortfolioApi(app);
  mountAccountApi(app);
  mountFundSessionApi(app);
  mountPayConfirmApi(app);
  mountAppApi(app);

  const xmtpBase = new XMTPBase();
  const launchpad = isLaunchpadMode();
  if (launchpad) {
    logger.info("🚀 XMTP_LAUNCHPAD_MODE — Base App is launch + pairs only");
  } else {
    xmtpBase.use(new InvestorFunnelPlugin());
    xmtpBase.use(new PortfolioReviewPlugin());
    xmtpBase.use(new PriceAlertPlugin());
  }
  xmtpBase.use(new AccountLinkPlugin());
  xmtpBase.use(new BaseContentTokenPlugin());
  if (!launchpad && WORLD_CUP_ENABLED) {
    xmtpBase.use(new WorldCupPlugin());
  } else if (!WORLD_CUP_ENABLED) {
    logger.info("⚽ World Cup disabled (WORLD_CUP_ENABLED=false)");
  }
  xmtpBase.use(new DiscoveryPlugin());

  await xmtpBase.init();

  process.on("SIGINT", xmtpBase.stop.bind(xmtpBase));
  process.on("SIGTERM", xmtpBase.stop.bind(xmtpBase));

  await xmtpBase.start();

  if (!launchpad) {
    new PortfolioReviewWorker("xmtp").start();
    new BrainDistillationWorker().start();

    if (config.redisUrl) {
      await new PortfolioReviewPoller("xmtp").startBullMq();
    } else {
      logger.warn("⚠️ REDIS_URL not set — PortfolioReviewPoller using setInterval");
      new PortfolioReviewPoller("xmtp").start();
    }
  }
}
