import { describe, expect, it } from "vitest";

import { hasSwearCue } from "./judge.js";

describe("hasSwearCue", () => {
  it("flags mild heat that regex ignores", () => {
    expect(hasSwearCue("piss")).toBe(true);
    expect(hasSwearCue("butt")).toBe(true);
    expect(hasSwearCue("pee in the butt")).toBe(true);
    expect(hasSwearCue("piss in the butt")).toBe(true);
  });

  it("skips ordinary chatter so we do not call the model", () => {
    expect(hasSwearCue("Cool")).toBe(false);
    expect(hasSwearCue("how's dinner")).toBe(false);
    expect(hasSwearCue("tell alexander dinner is ready")).toBe(false);
  });
});
