import { describe, expect, it } from "vitest";
import { decideCanSee, holdingShares } from "./wrenPeople.js";

describe("who can see moves", () => {
  it("is mutual: if you share nothing, you see nothing", () => {
    expect(decideCanSee({ viewerVisibility: "only_me", targetVisibility: "everyone", viewerInTargetsPeople: true })).toBe(false);
  });

  it("everyone means anyone on Wren who shares", () => {
    expect(decideCanSee({ viewerVisibility: "your_people", targetVisibility: "everyone", viewerInTargetsPeople: false })).toBe(true);
  });

  it("your people means only people in their contacts", () => {
    expect(decideCanSee({ viewerVisibility: "everyone", targetVisibility: "your_people", viewerInTargetsPeople: true })).toBe(true);
    expect(decideCanSee({ viewerVisibility: "everyone", targetVisibility: "your_people", viewerInTargetsPeople: false })).toBe(false);
  });

  it("only me hides everything", () => {
    expect(decideCanSee({ viewerVisibility: "everyone", targetVisibility: "only_me", viewerInTargetsPeople: true })).toBe(false);
  });
});

describe("holdings as shares, never dollars", () => {
  it("turns dollar values into percents of the whole", () => {
    const out = holdingShares([
      { symbol: "AAPLc", name: "Apple", valueUsd: 300 },
      { symbol: "NVDAc", name: "NVIDIA", valueUsd: 100 },
    ]);
    expect(out).toEqual([
      { symbol: "AAPLc", name: "Apple", pct: 75 },
      { symbol: "NVDAc", name: "NVIDIA", pct: 25 },
    ]);
    expect(JSON.stringify(out)).not.toContain("300");
  });

  it("returns nothing for an empty account", () => {
    expect(holdingShares([])).toEqual([]);
  });
});
