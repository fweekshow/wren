import { describe, expect, it, vi } from "vitest";

import type { PortfolioReviewJobRow } from "@/discovery/adapters/portfolioReview.adapter.js";

import { PortfolioReviewPoller, type PortfolioReviewPollerDeps } from "./poller.js";

function job(id = 1): PortfolioReviewJobRow {
  return {
    id,
    subscription_id: id,
    platform: "xmtp",
    run_at: new Date("2026-06-08T08:00:00.000Z"),
    status: "queued",
    attempts: 0,
    locked_at: null,
    last_error: null,
    created_at: new Date("2026-06-01T00:00:00.000Z"),
    updated_at: new Date("2026-06-01T00:00:00.000Z"),
  };
}

function deps(overrides: Partial<PortfolioReviewPollerDeps> = {}): PortfolioReviewPollerDeps {
  return {
    enqueueDueReviews: vi.fn(async () => [job()]),
    ...overrides,
  };
}

describe("PortfolioReviewPoller", () => {
  it("enqueues due subscriptions as jobs", async () => {
    const d = deps();
    const poller = new PortfolioReviewPoller("xmtp", d);

    const result = await poller.tickOnce(new Date("2026-06-08T08:01:00.000Z"));

    expect(result).toEqual({ enqueued: 1 });
    expect(d.enqueueDueReviews).toHaveBeenCalledWith(
      "xmtp",
      50,
      new Date("2026-06-08T08:01:00.000Z"),
    );
  });

  it("handles an empty due set", async () => {
    const d = deps({ enqueueDueReviews: vi.fn(async () => []) });
    const poller = new PortfolioReviewPoller("xmtp", d);

    await expect(poller.tickOnce()).resolves.toEqual({ enqueued: 0 });
  });
});
