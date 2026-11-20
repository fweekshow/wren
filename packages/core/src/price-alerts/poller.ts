import {
  PriceAlertAdapter,
  type AlertPlatform,
  type PriceAlertRow,
} from "@/discovery/adapters/priceAlert.adapter.js";
import { startPollerJob, type PollerJobHandle } from "@/infra/queues/base.js";
import { logger } from "@/utils/logger.js";

import { isTriggered, valueForMetric } from "./comparison.js";
import { priceAlertDelivery } from "./delivery.js";
import { formatTrigger } from "./format.js";
import { fetchQuoteForToken } from "./tokenResolver.js";
import type { TokenQuote } from "./types.js";

export interface PollerDeps {
  listPending: () => Promise<PriceAlertRow[]>;
  markTriggered: (id: number) => Promise<void>;
  markFailed: (id: number) => Promise<void>;
  fetchQuote: (alert: PriceAlertRow) => Promise<TokenQuote | null>;
  deliver: (alert: PriceAlertRow, message: string) => Promise<boolean>;
  buildMessage: (alert: PriceAlertRow, currentValue: number) => string;
}

export interface TickResult {
  checked: number;
  triggered: number;
  delivered: number;
}

function defaultDeps(platform?: AlertPlatform): PollerDeps {
  return {
    listPending: () => PriceAlertAdapter.listPending({ platform }),
    markTriggered: (id) => PriceAlertAdapter.markTriggered(id),
    markFailed: (id) => PriceAlertAdapter.markFailed(id),
    fetchQuote: (alert) =>
      fetchQuoteForToken({
        source: alert.token_source,
        tokenId: alert.token_id,
        tokenAddress: alert.token_address,
      }),
    deliver: (alert, message) => priceAlertDelivery.deliver(alert, message),
    buildMessage: (alert, currentValue) =>
      formatTrigger({
        symbol: alert.symbol,
        metric: alert.metric,
        direction: alert.direction,
        targetValue: Number(alert.target_value),
        currentValue,
      }),
  };
}

/** Cache key so multiple alerts on the same token share one price fetch. */
function tokenKey(alert: PriceAlertRow): string {
  return `${alert.token_source}:${alert.token_id ?? ""}:${alert.token_address ?? ""}`;
}

/**
 * Polls pending price alerts and delivers any that have crossed their target.
 * Alerts are one-time: each is marked `triggered` before delivery so it can
 * never fire twice, even if delivery later fails.
 */
export class PriceAlertPoller {
  private readonly deps: PollerDeps;
  private readonly platform?: AlertPlatform;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /**
   * @param deps     Overridable dependencies (used by tests).
   * @param platform When set, this poller only checks/marks/delivers alerts for
   *   that platform. Each app process should pass its own platform so a process
   *   never marks another platform's alert `triggered` and then fail to deliver.
   */
  constructor(deps: Partial<PollerDeps> = {}, platform?: AlertPlatform) {
    this.platform = platform;
    this.deps = { ...defaultDeps(platform), ...deps };
  }

  start(intervalMs = 45_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    const scope = this.platform ? ` [${this.platform}]` : "";
    logger.info(
      `🔔 PriceAlertPoller${scope} started (every ${Math.round(intervalMs / 1000)}s)`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Start the poller as a BullMQ repeatable job instead of a bare `setInterval`.
   * Provides distributed locking (only one replica processes each tick) and DLQ.
   */
  async startBullMq(intervalMs = 45_000): Promise<PollerJobHandle> {
    const scope = this.platform ? `-${this.platform}` : "";
    return startPollerJob(
      `price-alert-poller${scope}`,
      () => this.tickOnce(),
      intervalMs,
    );
  }

  /** Guarded wrapper so overlapping intervals don't double-process. */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tickOnce();
    } catch (err: any) {
      logger.error(`❌ PriceAlertPoller tick failed: ${err?.message || err}`);
    } finally {
      this.running = false;
    }
  }

  /** Run one polling pass. Exposed for tests. */
  async tickOnce(): Promise<TickResult> {
    const alerts = await this.deps.listPending();
    const result: TickResult = { checked: alerts.length, triggered: 0, delivered: 0 };
    if (alerts.length === 0) return result;

    const quoteCache = new Map<string, TokenQuote | null>();

    for (const alert of alerts) {
      const key = tokenKey(alert);
      let quote = quoteCache.get(key);
      if (quote === undefined) {
        quote = await this.deps.fetchQuote(alert);
        quoteCache.set(key, quote);
      }
      if (!quote) continue;

      const current = valueForMetric(quote, alert.metric);
      if (current === null) continue;

      const target = Number(alert.target_value);
      if (!isTriggered(current, alert.direction, target)) continue;

      // Mark first so a one-time alert can never fire twice.
      await this.deps.markTriggered(alert.id);
      result.triggered += 1;

      try {
        const message = this.deps.buildMessage(alert, current);
        const ok = await this.deps.deliver(alert, message);
        if (ok) {
          result.delivered += 1;
        } else {
          logger.warn(
            `⚠️ PriceAlert ${alert.id} triggered but delivery returned false (${alert.platform})`,
          );
        }
      } catch (err: any) {
        logger.error(`❌ PriceAlert ${alert.id} delivery threw: ${err?.message || err}`);
      }
    }

    return result;
  }
}
