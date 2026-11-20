import { describe, expect, it } from "vitest";

import {
  guestLifetimeExhausted,
  headlessBlockedReasonFromError,
} from "@/wallet/onrampLimits.js";

describe("headlessBlockedReasonFromError", () => {
  it("parses guest_transaction_count from JSON errorType", () => {
    const err = new Error(
      'headless onramp order request failed (429): {"errorType":"guest_transaction_count","message":"limit reached"}',
    );
    expect(headlessBlockedReasonFromError(err)).toBe("guest_transaction_count");
  });

  it("parses snake_case error_code in JSON", () => {
    const err = new Error('failed (400): {"error_code":"guest_transaction_count"}');
    expect(headlessBlockedReasonFromError(err)).toBe("guest_transaction_count");
  });
});

describe("guestLifetimeExhausted", () => {
  it("returns true when lifetime_transactions remaining is 0", () => {
    expect(
      guestLifetimeExhausted({
        limits: [{ limitType: "lifetime_transactions", remaining: "0", limit: "15" }],
      }),
    ).toBe(true);
  });
});
