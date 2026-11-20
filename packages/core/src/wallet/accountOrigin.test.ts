import { describe, expect, it } from "vitest";

import { basemateAccountOrigin } from "./accountOrigin.js";

describe("basemateAccountOrigin", () => {
  it("keeps the apex host", () => {
    expect(basemateAccountOrigin("https://basemate.app")).toBe("https://basemate.app");
    expect(basemateAccountOrigin("https://basemate.app/")).toBe("https://basemate.app");
  });

  it("rewrites app.basemate.app to the account host", () => {
    expect(basemateAccountOrigin("https://app.basemate.app")).toBe("https://basemate.app");
    expect(basemateAccountOrigin("https://app.basemate.app/wallet/connect")).toBe(
      "https://basemate.app",
    );
  });
});
