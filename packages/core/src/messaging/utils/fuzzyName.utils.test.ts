import { describe, expect, it } from "vitest";

import {
  contactNameTokens,
  fuzzyEditDistanceBudget,
  isExactContactNameToken,
  levenshtein,
  normalizeContactNameKey,
  scoreFuzzyContactName,
} from "./fuzzyName.utils.js";

describe("normalizeContactNameKey", () => {
  it("strips spaces and punctuation", () => {
    expect(normalizeContactNameKey("De Geneer")).toBe("degeneer");
    expect(normalizeContactNameKey("Uncle-Bob")).toBe("unclebob");
  });

  it("splits full names and detects exact first or last-name tokens", () => {
    expect(contactNameTokens("Smith, Alex J.")).toEqual(["smith", "alex", "j"]);
    expect(isExactContactNameToken("Alex", "Alex J. Smith")).toBe(true);
    expect(isExactContactNameToken("smith", "Alex J. Smith")).toBe(true);
    expect(isExactContactNameToken("J", "Alex J. Smith")).toBe(false);
    expect(isExactContactNameToken("Alex Smith", "Alex J. Smith")).toBe(false);
    expect(isExactContactNameToken("Al", "Alex J. Smith")).toBe(false);
  });
});

describe("levenshtein / fuzzy scoring", () => {
  it("scores exact matches best", () => {
    expect(scoreFuzzyContactName("Degeneer", "degeneer")).toEqual({ distance: 0, rank: 0 });
  });

  it("allows a single typo on longer names", () => {
    expect(fuzzyEditDistanceBudget(8)).toBe(2);
    const score = scoreFuzzyContactName("Degener", "Degeneer");
    expect(score).not.toBeNull();
    expect(score!.distance).toBe(1);
  });

  it("rejects unrelated short names", () => {
    expect(scoreFuzzyContactName("mom", "dad")).toBeNull();
    expect(levenshtein("ab", "xy")).toBe(2);
  });

  it("matches a first name against a full name", () => {
    const score = scoreFuzzyContactName("Shivam", "Shivam Sarkar");
    expect(score).not.toBeNull();
    expect(score!.rank).toBeLessThanOrEqual(2);
  });
});
