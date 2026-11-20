import { describe, expect, it } from "vitest";
import { changePct, downsample, dropRepeats, onlyPriceable } from "./priceHistory.js";

describe("only priceable stocks", () => {
  const items = [{ symbol: "AAPLc" }, { symbol: "ARMc" }, { symbol: "NVDAc" }];

  it("keeps stocks with a recent price", () => {
    expect(onlyPriceable(items, new Set(["AAPLc", "NVDAc"])).map((i) => i.symbol)).toEqual(["AAPLc", "NVDAc"]);
  });

  it("shows everything when prices aren't known yet", () => {
    expect(onlyPriceable(items, null)).toEqual(items);
  });
});

describe("price history helpers", () => {
  it("keeps short series as they are", () => {
    const pts: [number, number][] = [[1, 10], [2, 11], [3, 12]];
    expect(downsample(pts, 10)).toEqual(pts);
  });

  it("caps a long series and keeps the latest point", () => {
    const pts: [number, number][] = Array.from({ length: 1000 }, (_, i) => [i * 1000, 100 + i]);
    const out = downsample(pts, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
    // Time stays in order.
    for (let i = 1; i < out.length; i++) expect(out[i][0]).toBeGreaterThan(out[i - 1][0]);
  });

  it("measures change in percent, to two places", () => {
    expect(changePct(100, 102.5)).toBe(2.5);
    expect(changePct(350.6, 348.48)).toBe(-0.6);
    expect(changePct(null, 10)).toBeNull();
    expect(changePct(10, null)).toBeNull();
  });
});

describe("dropRepeats", () => {
  it("removes a frozen run but keeps where it started and the newest point", () => {
    const pts: [number, number][] = [
      [1, 350.6],
      [2, 350.6],
      [3, 350.6],
      [4, 351.3],
      [5, 351.3],
    ];
    expect(dropRepeats(pts)).toEqual([
      [1, 350.6],
      [4, 351.3],
      [5, 351.3],
    ]);
  });
  it("keeps every point when the price keeps moving", () => {
    const pts: [number, number][] = [
      [1, 1],
      [2, 2],
      [3, 1],
    ];
    expect(dropRepeats(pts)).toEqual(pts);
  });
});
