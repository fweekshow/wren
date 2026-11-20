import { describe, expect, it, vi } from "vitest";

import type {
  PortfolioReviewJobRow,
  PortfolioReviewSubscriptionRow,
} from "@/discovery/adapters/portfolioReview.adapter.js";

import { PortfolioReviewWorker, type PortfolioReviewWorkerDeps } from "./worker.js";

function sub(id = 1): PortfolioReviewSubscriptionRow {
  return {
    id,
    platform: "xmtp",
    user_key: `user-${id}`,
    wallet_address: "0x0000000000000000000000000000000000000001",
    dm_target: JSON.stringify({ walletAddress: "0x0000000000000000000000000000000000000001" }),
    local_time: "08:00",
    timezone: "UTC",
    enabled: true,
    next_run_at: new Date("2026-06-08T08:00:00.000Z"),
    last_sent_at: null,
    processing_at: null,
    last_error: null,
    created_at: new Date("2026-06-01T00:00:00.000Z"),
    updated_at: new Date("2026-06-01T00:00:00.000Z"),
  };
}

function job(id = 1): PortfolioReviewJobRow {
  return {
    id,
    subscription_id: id,
    platform: "xmtp",
    run_at: new Date("2026-06-08T08:00:00.000Z"),
    status: "processing",
    attempts: 1,
    locked_at: new Date("2026-06-08T08:01:00.000Z"),
    last_error: null,
    created_at: new Date("2026-06-01T00:00:00.000Z"),
    updated_at: new Date("2026-06-01T00:00:00.000Z"),
  };
}

function deps(overrides: Partial<PortfolioReviewWorkerDeps> = {}): PortfolioReviewWorkerDeps {
  let claimed = false;
  return {
    claimQueuedJob: vi.fn(async () => {
      if (claimed) return null;
      claimed = true;
      return job();
    }),
    getSubscriptionById: vi.fn(async () => sub()),
    buildReview: vi.fn(async () => ({ message: "review" })),
    deliver: vi.fn(async () => true),
    markJobDelivered: vi.fn(async () => {}),
    markJobFailed: vi.fn(async () => {}),
    nextRunAt: vi.fn(() => new Date("2026-06-09T08:00:00.000Z")),
    ...overrides,
  };
}

describe("PortfolioReviewWorker", () => {
  it("claims, builds, delivers, and advances a queued job", async () => {
    const d = deps();
    const worker = new PortfolioReviewWorker("xmtp", d);

    const result = await worker.tickOnce(new Date("2026-06-08T08:01:00.000Z"));

    expect(result).toEqual({ processed: 1, delivered: 1, failed: 0 });
    expect(d.claimQueuedJob).toHaveBeenCalledWith("xmtp", expect.any(Date));
    expect(d.buildReview).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), expect.any(Date));
    expect(d.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), "review");
    expect(d.markJobDelivered).toHaveBeenCalledWith(
      1,
      1,
      new Date("2026-06-09T08:00:00.000Z"),
      "xmtp",
    );
  });

  it("requeues or fails the job when delivery returns false", async () => {
    const d = deps({ deliver: vi.fn(async () => false) });
    const worker = new PortfolioReviewWorker("xmtp", d);

    const result = await worker.tickOnce(new Date("2026-06-08T08:01:00.000Z"));

    expect(result).toEqual({ processed: 1, delivered: 0, failed: 1 });
    expect(d.markJobFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      "xmtp",
      "delivery returned false",
    );
    expect(d.markJobDelivered).not.toHaveBeenCalled();
  });

  it("handles an empty queue", async () => {
    const d = deps({ claimQueuedJob: vi.fn(async () => null) });
    const worker = new PortfolioReviewWorker("xmtp", d);

    await expect(worker.tickOnce()).resolves.toEqual({
      processed: 0,
      delivered: 0,
      failed: 0,
    });
    expect(d.buildReview).not.toHaveBeenCalled();
  });
});
