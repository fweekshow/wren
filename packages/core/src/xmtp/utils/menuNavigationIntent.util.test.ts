import { describe, expect, it } from "vitest";

import { isMenuNavigationIntent } from "./menuNavigationIntent.util.js";

describe("isMenuNavigationIntent", () => {
  it("matches bare menu/help nav phrases and common typos", () => {
    expect(isMenuNavigationIntent("menu")).toBe(true);
    expect(isMenuNavigationIntent("Meni")).toBe(true);
    expect(isMenuNavigationIntent("help")).toBe(true);
    expect(isMenuNavigationIntent("options")).toBe(true);
    expect(isMenuNavigationIntent("show menu")).toBe(true);
  });

  it("does not match contextual or partial phrases", () => {
    expect(isMenuNavigationIntent("menu please")).toBe(false);
    expect(isMenuNavigationIntent("help me with earn")).toBe(false);
    expect(isMenuNavigationIntent("what can you do")).toBe(false);
  });
});
