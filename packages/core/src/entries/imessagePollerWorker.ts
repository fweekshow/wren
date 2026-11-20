import "@/load-env.js";

import { connectDb } from "@/discovery/db.js";
import { ContactsAdapter } from "@/messaging/contacts.adapter.js";
import { SenderIdMigration } from "@/messaging/senderId.migration.js";
import { startImessagePollerWorker } from "@/imessage/bot.js";
import { acquireLock } from "@/state/conversationState.store.js";
import { ensurePendingPayDeliveryColumns } from "@/wallet/pendingPay.schema.js";
import { ensurePhoneEscrowClaimExpiryColumns } from "@/wallet/phoneEscrow.schema.js";

/**
 * iMessage Poller Worker
 *
 * A single-instance service that owns the proactive-delivery pollers:
 *   - PriceAlertPoller         — fires price-alert DMs
 *   - TxConfirmationPoller     — DMs tx success/failure outcomes
 *   - EscrowReleasePoller      — releases phone-escrow USDC on wallet link
 *   - EscrowRefundPoller       — returns unclaimed phone-escrow to sender after 72h
 *   - PortfolioReviewPoller/Worker — sends periodic portfolio digests
 *
 * Rationale: when the main iMessage bot is scaled horizontally each replica
 * would otherwise run its own copy of every poller, causing duplicate
 * deliveries. Running pollers here as a dedicated single instance eliminates
 * that risk. Set `DISABLE_POLLERS=true` on the main bot service.
 *
 * This worker does NOT process inbound messages — it only sends outbound DMs
 * using its own Spectrum connection.
 */
export async function runImessagePollerWorkerApp(): Promise<void> {
  // Distributed startup lock — ensures only one replica of this service runs
  // the poller suite at a time. TTL = 10 min; Railway restarts renew naturally.
  const acquired = await acquireLock("lock:imessage-poller-worker", 10 * 60 * 1000);
  if (!acquired) {
    console.warn(
      "⚠️ [iMessage poller worker] Another instance is already running — exiting.",
    );
    process.exit(0);
  }

  await connectDb();
  // Tables are now managed by Drizzle migrations — run `bun db:migrate` to apply.
  await ensurePendingPayDeliveryColumns();
  // Same repair for 0019 — poller queries claim-expiry columns every tick.
  await ensurePhoneEscrowClaimExpiryColumns();
  // One-time data migration for legacy contact schema (safe no-op after first run):
  await ContactsAdapter.migrateToRelations();
  await SenderIdMigration.migrate();

  await startImessagePollerWorker();
}

runImessagePollerWorkerApp().catch((err) => {
  console.error("❌ [iMessage poller worker] fatal error:", err);
  process.exit(1);
});
