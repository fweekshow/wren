import { afterEach, describe, expect, it } from "vitest";

import {
  createPortfolioAccessToken,
  verifyPortfolioAccessToken,
} from "./access.js";

const ORIGINAL_SECRET = process.env.PORTFOLIO_LINK_SECRET;

afterEach(() => {
  if (ORIGINAL_SECRET == null) {
    delete process.env.PORTFOLIO_LINK_SECRET;
  } else {
    process.env.PORTFOLIO_LINK_SECRET = ORIGINAL_SECRET;
  }
});

describe("portfolio access tokens", () => {
  it("accepts a valid token for the same sender", () => {
    process.env.PORTFOLIO_LINK_SECRET = "test-secret";
    const token = createPortfolioAccessToken("sender-1", { now: 1000, ttlMs: 5000 });

    expect(verifyPortfolioAccessToken("sender-1", token, { now: 2000 })).toEqual({ ok: true });
  });

  it("rejects subject mismatches and expired tokens", () => {
    process.env.PORTFOLIO_LINK_SECRET = "test-secret";
    const token = createPortfolioAccessToken("sender-1", { now: 1000, ttlMs: 5000 });

    expect(verifyPortfolioAccessToken("sender-2", token, { now: 2000 })).toEqual({
      ok: false,
      reason: "subject",
    });
    expect(verifyPortfolioAccessToken("sender-1", token, { now: 7000 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });
});
