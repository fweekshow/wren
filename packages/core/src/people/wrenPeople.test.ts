import { describe, expect, it } from "vitest";
import { decideCanSee, holdingShares } from "./wrenPeople.js";

describe("who can see moves", () => {
  const both = { viewerInTargetsContacts: true, targetInViewersContacts: true };
  it("is mutual: if you share nothing, you see nothing", () => {
    expect(decideCanSee({ viewerVisibility: "only_me", targetVisibility: "your_people", ...both })).toBe(false);
  });

  it("only me hides everything", () => {
    expect(decideCanSee({ viewerVisibility: "your_people", targetVisibility: "only_me", ...both })).toBe(false);
  });

  it("contacts only, both ways: each has the other's number", () => {
    const shared = { viewerVisibility: "your_people", targetVisibility: "your_people" } as const;
    expect(decideCanSee({ ...shared, ...both })).toBe(true);
    expect(decideCanSee({ ...shared, viewerInTargetsContacts: true, targetInViewersContacts: false })).toBe(false);
    expect(decideCanSee({ ...shared, viewerInTargetsContacts: false, targetInViewersContacts: true })).toBe(false);
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
