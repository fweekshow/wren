import "@/load-env.js";

import express from "express";
import { httpLogger, logger } from "@/utils/logger.js";

import { mountPortfolioApi } from "@/api/portfolio.router.js";
import { connectDb } from "@/discovery/db.js";
import { ContactsAdapter } from "@/messaging/contacts.adapter.js";
import { SenderIdMigration } from "@/messaging/senderId.migration.js";
import { startWhatsappBot } from "@/whatsapp/bot.js";
import { whatsappLiveness } from "@/whatsapp/liveness.js";

export async function runWhatsappApp() {
  await connectDb();
  // Tables are now managed by Drizzle migrations — run `bun db:migrate` to apply.
  // One-time data migration for legacy contact schema (safe no-op after first run):
  await ContactsAdapter.migrateToRelations();
  await SenderIdMigration.migrate();

  const app = express();
  app.use(httpLogger);
  app.use(express.json());
  mountPortfolioApi(app);

  app.get("/health", (_req, res) => {
    const healthy = whatsappLiveness.isHealthy();
    res.status(healthy ? 200 : 503).json({
      ok: healthy,
      whatsapp: whatsappLiveness.snapshot(),
    });
  });
  app.get("/ready", (_req, res) => res.json({ ok: true, service: "basemate-whatsapp" }));

  await startWhatsappBot();

  const PORT = Number(process.env.PORT ?? 3000);
  app.listen(PORT, () =>
    logger.info(`🌐 WhatsApp app listening on :${PORT}`),
  );
}
