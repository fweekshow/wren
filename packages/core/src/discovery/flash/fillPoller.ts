import { startPollerJob, type PollerJobHandle } from "@/infra/queues/base.js";
import { logger } from "@/utils/logger.js";

import { isFlashOrderTerminalFail } from "./activity.js";
import { flashGetOrder } from "./client.js";
import { PendingFlashAdapter, resolveFlashFillOnce, type PendingFlashRow } from "./pendingFlash.js";
import type { FlashPreparedOrder } from "./types.js";

export interface FlashFillPollerTickResult {
  checked: number;
  recorded: number;
  closed: number;
}

/**
 * Polls open Flash orders and writes fills into the Activity feed
 * (`tx_confirmations`) once Flash reports ORDER_STATUS_FILLED.
 */
export class FlashFillPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    logger.info(`⚡ FlashFillPoller started (every ${Math.round(intervalMs / 1000)}s)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async startBullMq(intervalMs = 15_000): Promise<PollerJobHandle> {
    return startPollerJob("flash-fill-poller", () => this.tickOnce(), intervalMs);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tickOnce();
    } catch (err) {
      logger.error(`❌ FlashFillPoller tick failed: ${(err as Error)?.message || err}`);
    } finally {
      this.running = false;
    }
  }

  async tickOnce(): Promise<FlashFillPollerTickResult> {
    await PendingFlashAdapter.expireStale();
    const rows = await PendingFlashAdapter.listOpen();
    const result: FlashFillPollerTickResult = {
      checked: rows.length,
      recorded: 0,
      closed: 0,
    };

    for (const row of rows) {
      try {
        const outcome = await this.resolveRow(row);
        if (outcome === "recorded") result.recorded += 1;
        else if (outcome === "closed") result.closed += 1;
      } catch (err) {
        logger.warn({ err, orderId: row.orderId }, "[flash] fill poller row failed");
      }
    }

    return result;
  }

  private async resolveRow(
    row: PendingFlashRow,
  ): Promise<"recorded" | "closed" | "open"> {
    const prepared = row.prepared as FlashPreparedOrder;
    let detail;
    try {
      detail = await flashGetOrder({
        orderId: row.orderId,
        funderAddress: row.funderAddress,
      });
    } catch {
      return "open";
    }

    const { recorded } = await resolveFlashFillOnce({
      orderId: row.orderId,
      senderId: row.senderId,
      prepared,
      detail,
    });
    if (recorded) return "recorded";
    if (isFlashOrderTerminalFail(detail.status)) return "closed";
    return "open";
  }
}
