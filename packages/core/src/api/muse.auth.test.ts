import { describe, expect, it } from "vitest";

import { bearerToken } from "./muse.auth.js";

describe("bearerToken", () => {
  it("strips Bearer prefix", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("abc")).toBe("abc");
    expect(bearerToken(undefined)).toBe("");
  });
});
