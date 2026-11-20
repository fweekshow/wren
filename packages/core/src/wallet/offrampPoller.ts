import { createDeliveryRegistry } from "@/infra/deliveryRegistry.js";
import { startPollerJob, type PollerJobHandle } from "@/infra/queues/base.js";
import { logger } from "@/utils/logger.js";
import { refreshOfframp, OfframpValidationError } from "@/wallet/offramp.js";
import {
  OfframpSessionAdapter,
  type OfframpPlatform,
  type OfframpSessionRow,
} from "@/wallet/offrampSession.js";

export const offrampDelivery =
  createDeliveryRegistry<string, OfframpSessionRow>();

export interface OfframpPollerResult {
  checked: number;
  resolved: number;
  delivered: number;
}

export class OfframpStatusPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly platform: OfframpPlatform) {}

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    logger.info(`💸 OfframpStatusPoller [${this.platform}] started`);
  }

  async startBullMq(intervalMs = 15_000): Promise<PollerJobHandle> {
    return startPollerJob(
      `offramp-status-poller-${this.platform}`,
      () => this.tickOnce(),
      intervalMs,
    );
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tickOnce();
    } catch (error) {
      logger.error({ err: error, platform: this.platform }, "OfframpStatusPoller tick failed");
    } finally {
      this.running = false;
    }
  }

  async tickOnce(): Promise<OfframpPollerResult> {
    await OfframpSessionAdapter.expireStale();
    const active = await OfframpSessionAdapter.listActive(this.platform);
    let resolved = 0;
    for (const session of active) {
      try {
        const refreshed = await refreshOfframp(session);
        if (["success", "failed", "expired", "manual_review"].includes(refreshed.status)) {
          resolved += 1;
        }
      } catch (error) {
        if (!(error instanceof OfframpValidationError)) {
          logger.warn(
            { err: error, sessionId: session.id },
            "Offramp status refresh failed",
          );
        }
      }
    }

    const terminal = await OfframpSessionAdapter.listTerminalUnnotified(this.platform);
    let delivered = 0;
    for (const session of terminal) {
      const claimed = await OfframpSessionAdapter.markNotified(session.id);
      if (!claimed) continue;
      const ok = await offrampDelivery.deliver(session, buildOfframpMessage(session));
      if (ok) delivered += 1;
    }
    return { checked: active.length, resolved, delivered };
  }
}

export function buildOfframpMessage(session: OfframpSessionRow): string {
  const amount = session.sellAmount ?? session.requestedAmount;
  const txUrl = session.txHash ? `\n${`https://basescan.org/tx/${session.txHash}`}` : "";
  if (session.status === "success") {
    const received =
      session.fiatTotal && session.fiatCurrency
        ? ` for ${session.fiatTotal} ${session.fiatCurrency}`
        : "";
    return `cash out complete ✅\n${amount} USDC was processed by Coinbase${received}.${txUrl}`;
  }
  if (session.status === "expired") {
    return "your Coinbase cash-out session expired before it completed. no new transfer was submitted.";
  }
  if (session.status === "manual_review") {
    return `your cash-out needs a manual status check. Basemate will not retry the transfer automatically.${txUrl}`;
  }
  return `your Coinbase cash-out did not complete. no automatic retry will be submitted.${txUrl}`;
}
