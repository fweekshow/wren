import {
  PortfolioReviewAdapter,
  type PortfolioReviewPlatform,
  type PortfolioReviewJobRow,
} from "@/discovery/adapters/portfolioReview.adapter.js";
import { startPollerJob, type PollerJobHandle } from "@/infra/queues/base.js";
import { acquireLock, releaseLock } from "@/state/conversationState.store.js";
import { logger } from "@/utils/logger.js";

export interface PortfolioReviewPollerDeps {
  enqueueDueReviews: (
    platform: PortfolioReviewPlatform,
    limit?: number,
    now?: Date,
  ) => Promise<PortfolioReviewJobRow[]>;
}

export interface PortfolioReviewTickResult {
  enqueued: number;
}

function defaultDeps(): PortfolioReviewPollerDeps {
  return {
    enqueueDueReviews: (platform, limit, now) =>
      PortfolioReviewAdapter.enqueueDueReviews(platform, limit, now),
  };
}

export class PortfolioReviewPoller {
  private readonly deps: PortfolioReviewPollerDeps;
  private readonly platform: PortfolioReviewPlatform;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    platform: PortfolioReviewPlatform,
    deps: Partial<PortfolioReviewPollerDeps> = {},
  ) {
    this.platform = platform;
    this.deps = { ...defaultDeps(), ...deps };
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    logger.info(
      `📊 PortfolioReviewScheduler [${this.platform}] started (every ${Math.round(intervalMs / 1000)}s)`,
    );
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async startBullMq(intervalMs = 60_000): Promise<PollerJobHandle> {
    return startPollerJob(
      `portfolio-review-poller-${this.platform}`,
      () => this.tickOnce(),
      intervalMs,
      { keepFailed: 500 },
    );
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    const lockKey = `lock:portfolio-review-poller:${this.platform}`;
    const acquired = await acquireLock(lockKey, 90_000);
    if (!acquired) return;
    this.running = true;
    try {
      await this.tickOnce();
    } catch (err: any) {
      logger.error(`❌ PortfolioReviewScheduler tick failed: ${err?.message || err}`);
    } finally {
      this.running = false;
      await releaseLock(lockKey);
    }
  }

  async tickOnce(now = new Date()): Promise<PortfolioReviewTickResult> {
    const jobs = await this.deps.enqueueDueReviews(this.platform, 50, now);
    return { enqueued: jobs.length };
  }
}
