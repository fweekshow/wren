import {
  PortfolioReviewAdapter,
  type PortfolioReviewJobRow,
  type PortfolioReviewPlatform,
  type PortfolioReviewSubscriptionRow,
} from "@/discovery/adapters/portfolioReview.adapter.js";
import { logger } from "@/utils/logger.js";

import { portfolioReviewDelivery } from "./delivery.js";
import { buildAndStorePortfolioReview } from "./service.js";
import { nextDailyRunAt } from "./time.js";

export interface PortfolioReviewWorkerDeps {
  claimQueuedJob: (
    platform: PortfolioReviewPlatform,
    now?: Date,
  ) => Promise<PortfolioReviewJobRow | null>;
  getSubscriptionById: (id: number) => Promise<PortfolioReviewSubscriptionRow | null>;
  buildReview: (
    subscription: PortfolioReviewSubscriptionRow,
    now?: Date,
  ) => Promise<{ message: string }>;
  deliver: (subscription: PortfolioReviewSubscriptionRow, message: string) => Promise<boolean>;
  markJobDelivered: (
    jobId: number,
    subscriptionId: number,
    nextRunAtValue: Date,
    platform: PortfolioReviewPlatform,
  ) => Promise<void>;
  markJobFailed: (
    job: PortfolioReviewJobRow,
    platform: PortfolioReviewPlatform,
    error: string,
  ) => Promise<void>;
  nextRunAt: (localTime: string, timezone: string, from?: Date) => Date;
}

export interface PortfolioReviewWorkerResult {
  processed: number;
  delivered: number;
  failed: number;
}

function defaultDeps(): PortfolioReviewWorkerDeps {
  return {
    claimQueuedJob: (platform, now) => PortfolioReviewAdapter.claimQueuedJob(platform, now),
    getSubscriptionById: (id) => PortfolioReviewAdapter.getSubscriptionById(id),
    buildReview: (subscription, now) => buildAndStorePortfolioReview(subscription, now),
    deliver: (subscription, message) =>
      portfolioReviewDelivery.deliver(subscription, message),
    markJobDelivered: (jobId, subscriptionId, nextRunAtValue, platform) =>
      PortfolioReviewAdapter.markJobDelivered(
        jobId,
        subscriptionId,
        nextRunAtValue,
        platform,
      ),
    markJobFailed: (job, platform, error) =>
      PortfolioReviewAdapter.markJobFailed(job, platform, error),
    nextRunAt: nextDailyRunAt,
  };
}

export class PortfolioReviewWorker {
  private readonly deps: PortfolioReviewWorkerDeps;
  private readonly platform: PortfolioReviewPlatform;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    platform: PortfolioReviewPlatform,
    deps: Partial<PortfolioReviewWorkerDeps> = {},
  ) {
    this.platform = platform;
    this.deps = { ...defaultDeps(), ...deps };
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    logger.info(
      `📬 PortfolioReviewWorker [${this.platform}] started (every ${Math.round(intervalMs / 1000)}s)`,
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
    } catch (err: any) {
      logger.error(`❌ PortfolioReviewWorker tick failed: ${err?.message || err}`);
    } finally {
      this.running = false;
    }
  }

  async tickOnce(now = new Date()): Promise<PortfolioReviewWorkerResult> {
    const result: PortfolioReviewWorkerResult = {
      processed: 0,
      delivered: 0,
      failed: 0,
    };

    for (;;) {
      const job = await this.deps.claimQueuedJob(this.platform, now);
      if (!job) return result;

      result.processed += 1;
      try {
        const subscription = await this.deps.getSubscriptionById(job.subscription_id);
        if (!subscription || !subscription.enabled) {
          await this.deps.markJobFailed(
            job,
            this.platform,
            "subscription disabled or missing",
          );
          result.failed += 1;
          continue;
        }

        const review = await this.deps.buildReview(subscription, now);
        const ok = await this.deps.deliver(subscription, review.message);
        if (!ok) {
          await this.deps.markJobFailed(job, this.platform, "delivery returned false");
          result.failed += 1;
          continue;
        }

        const nextRun = this.deps.nextRunAt(
          subscription.local_time,
          subscription.timezone,
          new Date(now.getTime() + 1000),
        );
        await this.deps.markJobDelivered(
          job.id,
          subscription.id,
          nextRun,
          this.platform,
        );
        result.delivered += 1;
      } catch (err: any) {
        const message = err?.message || String(err);
        logger.error(`❌ Portfolio review job ${job.id} failed: ${message}`);
        await this.deps.markJobFailed(job, this.platform, message);
        result.failed += 1;
      }
    }
  }
}
