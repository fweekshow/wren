import { describe, expect, it } from "vitest";

import { evaluateLaunchRateLimit } from "./tokenLaunch.adapter.js";

const now = new Date("2026-05-31T12:00:00Z").getTime();

describe("evaluateLaunchRateLimit", () => {
  it("allows first launch", () => {
    expect(evaluateLaunchRateLimit([], now).status).toBe("allowed");
  });

  it("allows up to two successes within the window", () => {
    const rows = [1, 2].map((i) => ({
      logStatus: "success" as const,
      tokenSymbol: `TOK${i}`,
      createdAt: new Date(now - i * 60_000),
    }));
    expect(evaluateLaunchRateLimit(rows, now, { maxSuccessful: 3 }).status).toBe("allowed");
  });

  it("blocks when max successful launches reached", () => {
    const rows = [1, 2, 3].map((i) => ({
      logStatus: "success" as const,
      tokenSymbol: `TOK${i}`,
      createdAt: new Date(now - i * 60_000),
    }));
    const verdict = evaluateLaunchRateLimit(rows, now, { maxSuccessful: 3 });
    expect(verdict.status).toBe("limit_reached");
    expect(verdict.message).toMatch(/3 tokens/i);
  });

  it("does not count failed launches toward the cap", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      logStatus: "failed" as const,
      tokenSymbol: "SPAM",
      createdAt: new Date(now - i * 60_000),
    }));
    expect(evaluateLaunchRateLimit(rows, now, { maxSuccessful: 3 }).status).toBe("allowed");
  });

  it("counts only successes when failures are mixed in", () => {
    const rows = [
      { logStatus: "failed" as const, tokenSymbol: "A", createdAt: new Date(now - 10_000) },
      { logStatus: "success" as const, tokenSymbol: "B", createdAt: new Date(now - 20_000) },
      { logStatus: "failed" as const, tokenSymbol: "C", createdAt: new Date(now - 30_000) },
      { logStatus: "success" as const, tokenSymbol: "D", createdAt: new Date(now - 40_000) },
      { logStatus: "success" as const, tokenSymbol: "E", createdAt: new Date(now - 50_000) },
    ];
    expect(evaluateLaunchRateLimit(rows, now, { maxSuccessful: 3 }).status).toBe("limit_reached");
  });
});
