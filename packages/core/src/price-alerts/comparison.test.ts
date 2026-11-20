import { describe, expect, it } from "vitest";

import { inferDirection, isTriggered, valueForMetric } from "./comparison.js";

describe("valueForMetric", () => {
  it("reads price vs market cap", () => {
    const quote = { priceUsd: 10, marketCapUsd: 5000 };
    expect(valueForMetric(quote, "price_usd")).toBe(10);
    expect(valueForMetric(quote, "market_cap_usd")).toBe(5000);
  });

  it("returns null for a missing metric", () => {
    expect(valueForMetric({ priceUsd: null, marketCapUsd: null }, "price_usd")).toBeNull();
  });
});

describe("inferDirection", () => {
  it("waits for a rise when below target", () => {
    expect(inferDirection(1800, 4000)).toBe("above");
  });
  it("waits for a drop when above target", () => {
    expect(inferDirection(5000, 4000)).toBe("below");
  });
});

describe("isTriggered", () => {
  it("fires above at/over the target", () => {
    expect(isTriggered(4000, "above", 4000)).toBe(true);
    expect(isTriggered(4001, "above", 4000)).toBe(true);
    expect(isTriggered(3999, "above", 4000)).toBe(false);
  });
  it("fires below at/under the target", () => {
    expect(isTriggered(4000, "below", 4000)).toBe(true);
    expect(isTriggered(3999, "below", 4000)).toBe(true);
    expect(isTriggered(4001, "below", 4000)).toBe(false);
  });
});
