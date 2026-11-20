import { describe, expect, it } from "vitest";

import { isMultiStrategyAllowed } from "./allowlist.js";

describe("isMultiStrategyAllowed", () => {
  it("allows the default whitelisted wallet", async () => {
    const allowed = await isMultiStrategyAllowed({
      wallet: "0x22209cfc1397832f32160239c902b10a624cab1a",
    });
    expect(allowed).toBe(true);
  });

  it("allows the default whitelisted basename handle", async () => {
    const allowed = await isMultiStrategyAllowed({
      basename: "0xteo.base.eth",
    });
    expect(allowed).toBe(true);
  });

  it("blocks unrelated wallets", async () => {
    const allowed = await isMultiStrategyAllowed({
      wallet: "0x0000000000000000000000000000000000000001",
    });
    expect(allowed).toBe(false);
  });
});
