import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

import type { FlashPreparedOrder } from "@/discovery/flash/types.js";
import { startPollerJob, type PollerJobHandle } from "@/infra/queues/base.js";
import { cleanTxLabel, formatConfirmedChatTitle, type ReceiptOutcome } from "@/tx-confirmations/poller.js";
import {
  formatFlashReceipt,
  formatFlashSwapLine,
} from "@/messaging/handlers/flashReceipt.js";
import { APP_ACTIVITY_HINT, formatReceipt } from "@/messaging/utils/wallet.utils.js";
import type { CopyTradeCtxPayload } from "@/discovery/ai/types.js";
import { convKey, stateSet } from "@/state/conversationState.store.js";
import { logger } from "@/utils/logger.js";
import { PendingPayAdapter, type PendingPayRow } from "@/wallet/pendingPay.js";

export interface PendingPayConfirmationDeps {
  listSigned: () => Promise<PendingPayRow[]>;
  getReceipt: (txHash: string) => Promise<ReceiptOutcome | null>;
  markConfirmed: (token: string) => Promise<boolean>;
  markFailed: (token: string) => Promise<boolean>;
  deliver: (row: PendingPayRow, message: string) => Promise<boolean>;
  /** @deprecated No longer used — chat confirmations no longer DM explorer links. */
  deliverDm?: (phone: string, message: string) => Promise<boolean>;
  buildMessage: (row: PendingPayRow, outcome: ReceiptOutcome) => string;
}

export interface PendingPayConfirmationTickResult {
  checked: number;
  confirmed: number;
  failed: number;
  delivered: number;
}

/** Sender confirmation copy for a transaction signed on the Basemate Pay page. */
export function buildPendingPayConfirmationMessage(
  row: PendingPayRow,
  outcome: ReceiptOutcome,
): string {
  // Flash stores a pre-confirm preview as `label` (Buy X of Y). Confirmations
  // should use the same swap receipt as automatic fills — never the fee line.
  if (row.executionKind === "flash" && row.flashPrepared) {
    const prepared = row.flashPrepared as FlashPreparedOrder;
    if (outcome !== "success") {
      return `${formatFlashSwapLine(prepared)} didn't go through. nothing moved, try again.`;
    }
    return formatFlashReceipt(prepared, { status: "ORDER_STATUS_FILLED" });
  }

  const what = row.label ? cleanTxLabel(row.label) : "your transaction";
  if (outcome !== "success") {
    return `${what} didn't go through. nothing moved, try again.`;
  }
  // Groups stay tidy: confirm + optional COPY prompt (activity lives in the app).
  if (row.isGroup) {
    return formatReceipt({
      title: formatConfirmedChatTitle(row.label ?? what),
      footer: row.copyTradeContext ? "Reply COPY to copy this trade." : null,
    });
  }
  return formatReceipt({
    title: formatConfirmedChatTitle(row.label ?? what),
    footer: APP_ACTIVITY_HINT,
  });
}

async function registerPendingCopyTrade(row: PendingPayRow): Promise<void> {
  if (!row.isGroup || !row.conversationId || !row.copyTradeContext) return;
  const copyTradeCtx = row.copyTradeContext as CopyTradeCtxPayload;
  await stateSet(
    convKey("imessage", row.conversationId, "pendingGroupCopyTrade"),
    {
      ...copyTradeCtx,
      label: row.label ? cleanTxLabel(row.label) : "Trade",
      originSenderId: row.senderId,
      deliveryPhone: row.deliveryPhone ?? undefined,
      expiresAt: Date.now() + 5 * 60_000,
    },
    5 * 60,
  );
}

function defaultDeps(): Omit<PendingPayConfirmationDeps, "deliver"> {
  const client = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
  });

  return {
    listSigned: () => PendingPayAdapter.listSignedUnconfirmed(),
    getReceipt: async (txHash) => {
      try {
        const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
        return receipt.status === "success" ? "success" : "reverted";
      } catch {
        return null; // not mined yet — retry next tick
      }
    },
    markConfirmed: (token) => PendingPayAdapter.markConfirmed(token),
    markFailed: (token) => PendingPayAdapter.markFailedOnchain(token),
    buildMessage: buildPendingPayConfirmationMessage,
  };
}

/**
 * Confirms transactions the user signed on the self-hosted Basemate Pay page.
 * The web page writes the tx hash to `pending_pay_transactions`; this poller
 * resolves the on-chain receipt and DMs the sender the outcome in iMessage.
 */
export class PendingPayConfirmationPoller {
  private readonly deps: PendingPayConfirmationDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: Partial<PendingPayConfirmationDeps> = {}) {
    const fallbackDeliver: PendingPayConfirmationDeps["deliver"] = async () => {
      logger.warn("⚠️ PendingPayConfirmationPoller has no deliver fn — confirmation dropped");
      return false;
    };
    this.deps = { ...defaultDeps(), deliver: fallbackDeliver, ...deps };
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    logger.info(`🔔 PendingPayConfirmationPoller started (every ${Math.round(intervalMs / 1000)}s)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async startBullMq(intervalMs = 15_000): Promise<PollerJobHandle> {
    return startPollerJob("pending-pay-confirmation-poller", () => this.tickOnce(), intervalMs);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tickOnce();
    } catch (err) {
      logger.error(`❌ PendingPayConfirmationPoller tick failed: ${(err as Error)?.message || err}`);
    } finally {
      this.running = false;
    }
  }

  async tickOnce(): Promise<PendingPayConfirmationTickResult> {
    const rows = await this.deps.listSigned();
    const result: PendingPayConfirmationTickResult = {
      checked: rows.length,
      confirmed: 0,
      failed: 0,
      delivered: 0,
    };

    for (const row of rows) {
      if (!row.txHash) continue;
      const outcome = await this.deps.getReceipt(row.txHash);
      if (!outcome) continue; // not mined yet

      // Win the terminal transition first so the DM can only fire once.
      const won =
        outcome === "success"
          ? await this.deps.markConfirmed(row.token)
          : await this.deps.markFailed(row.token);
      if (!won) continue;

      if (outcome === "success") result.confirmed += 1;
      else result.failed += 1;

      try {
        if (outcome === "success") {
          await registerPendingCopyTrade(row);
          const { consumePendingAutoSaveContact } = await import(
            "@/messaging/utils/autoSaveContact.utils.js"
          );
          await consumePendingAutoSaveContact(row.senderId, row.token);
        }
        const ok = await this.deps.deliver(row, this.deps.buildMessage(row, outcome));
        if (ok) result.delivered += 1;
        else logger.warn(`⚠️ PendingPay ${row.token} resolved but delivery returned false`);
      } catch (err) {
        logger.error(
          `❌ PendingPay ${row.token} delivery threw: ${(err as Error)?.message || err}`,
        );
      }
    }

    return result;
  }
}
