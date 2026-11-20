import { config } from "@/config/config.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { startPollerJob, type PollerJobHandle } from "@/infra/queues/base.js";
import { acquireLock, releaseLock } from "@/state/conversationState.store.js";
import { logger } from "@/utils/logger.js";

import {
  PhoneEscrowAdapter,
  type PhoneEscrowDepositRow,
  type PhoneEscrowRefundResult,
} from "./phoneEscrow.js";

export interface EscrowRefundPollerDeps {
  listExpired: () => Promise<PhoneEscrowDepositRow[]>;
  /** Recipient's connected embedded wallet, or null if they haven't connected. */
  getConnectedAddress: (phone: string) => Promise<string | null>;
  claim: (rowId: string) => Promise<boolean>;
  unclaim: (rowId: string) => Promise<void>;
  refund: (row: PhoneEscrowDepositRow) => Promise<PhoneEscrowRefundResult | null>;
  deliver: (senderId: string, message: string) => Promise<boolean>;
  buildMessage: (result: PhoneEscrowRefundResult) => string;
}

export interface EscrowRefundTickResult {
  checked: number;
  refunded: number;
  delivered: number;
  skippedConnected: number;
}

export function buildEscrowRefundMessage(result: PhoneEscrowRefundResult): string {
  const hours = config.phoneEscrow.claimTtlHours;
  return (
    `Your ${result.amount} ${result.tokenSymbol} send to ${result.phone} ` +
    `wasn't claimed in ${hours} hours — it's back in your wallet.`
  );
}

function defaultDeps(): Omit<EscrowRefundPollerDeps, "deliver"> {
  return {
    listExpired: () => PhoneEscrowAdapter.listExpiredDeposits(),
    getConnectedAddress: (phone) => WalletAdapter.getReceiveAddress(phone),
    claim: (rowId) => PhoneEscrowAdapter.claimForRefund(rowId),
    unclaim: (rowId) => PhoneEscrowAdapter.unclaimForRefund(rowId),
    refund: (row) => PhoneEscrowAdapter.refundToSender(row),
    buildMessage: buildEscrowRefundMessage,
  };
}

/**
 * Returns unclaimed phone-escrow deposits to the sender after the claim TTL
 * (default 72h). Skips any deposit whose recipient has since connected a wallet
 * — those are owned by EscrowReleasePoller.
 */
export class EscrowRefundPoller {
  private readonly deps: EscrowRefundPollerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: Partial<EscrowRefundPollerDeps> = {}) {
    const fallbackDeliver: EscrowRefundPollerDeps["deliver"] = async () => {
      logger.warn("⚠️ EscrowRefundPoller has no deliver fn — refund DM dropped");
      return false;
    };
    this.deps = { ...defaultDeps(), deliver: fallbackDeliver, ...deps };
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    if (!config.phoneEscrow.refundEnabled) {
      logger.warn(
        "⚠️ EscrowRefundPoller not started — phone escrow refund is disabled " +
          "(set PHONE_ESCROW_OPERATOR_PRIVATE_KEY to enable refunds).",
      );
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    logger.info(
      `🔔 EscrowRefundPoller started (every ${Math.round(intervalMs / 1000)}s, ` +
        `ttl=${config.phoneEscrow.claimTtlHours}h)`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async startBullMq(intervalMs = 60_000): Promise<PollerJobHandle | null> {
    if (!config.phoneEscrow.refundEnabled) {
      logger.warn(
        "⚠️ EscrowRefundPoller (BullMQ) not started — phone escrow refund is disabled.",
      );
      return null;
    }
    return startPollerJob("escrow-refund-poller", () => this.tickOnce(), intervalMs, {
      keepFailed: 500,
    });
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    const lockKey = "lock:escrow-refund-poller";
    const acquired = await acquireLock(lockKey, 90_000);
    if (!acquired) return;
    this.running = true;
    try {
      await this.tickOnce();
    } catch (err) {
      logger.error(`❌ EscrowRefundPoller tick failed: ${(err as Error)?.message || err}`);
    } finally {
      this.running = false;
      await releaseLock(lockKey);
    }
  }

  /** Run one refund pass. Exposed for tests. */
  async tickOnce(): Promise<EscrowRefundTickResult> {
    const rows = await this.deps.listExpired();
    const result: EscrowRefundTickResult = {
      checked: rows.length,
      refunded: 0,
      delivered: 0,
      skippedConnected: 0,
    };

    for (const row of rows) {
      // Recipient connected — leave funds for EscrowReleasePoller.
      const address = await this.deps.getConnectedAddress(row.recipientPhone);
      if (address) {
        result.skippedConnected += 1;
        continue;
      }

      if (!(await this.deps.claim(row.id))) continue;

      try {
        const refunded = await this.deps.refund(row);
        if (!refunded) {
          await this.deps.unclaim(row.id);
          continue;
        }
        result.refunded += 1;

        const ok = await this.deps.deliver(
          row.senderId,
          this.deps.buildMessage(refunded),
        );
        if (ok) result.delivered += 1;
        else {
          logger.warn(
            `⚠️ Escrow refunded for ${row.id} but sender DM returned false`,
          );
        }
      } catch (err) {
        await this.deps.unclaim(row.id).catch(() => {});
        logger.error(
          `❌ Escrow refund for ${row.id} failed: ${(err as Error)?.message || err}`,
        );
      }
    }

    return result;
  }
}
