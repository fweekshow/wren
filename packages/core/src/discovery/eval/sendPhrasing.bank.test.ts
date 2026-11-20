import { describe, expect, it } from "vitest";

import { SEND_PHRASING_BANK } from "./sendPhrasing.bank.js";

describe("SEND_PHRASING_BANK", () => {
  it("has unique ids", () => {
    const ids = SEND_PHRASING_BANK.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("positives include expect slots; negatives do not require tool args", () => {
    for (const c of SEND_PHRASING_BANK) {
      if (c.kind === "positive") {
        expect(c.expect?.to || c.expect?.asset).toBeTruthy();
      } else {
        expect(c.kind).toBe("negative");
      }
    }
  });

  it("covers core teammate patterns", () => {
    const inputs = SEND_PHRASING_BANK.map((c) => c.input.toLowerCase());
    expect(inputs.some((i) => i.includes("tip"))).toBe(true);
    expect(inputs.some((i) => i.includes("penny"))).toBe(true);
    expect(inputs.some((i) => i.includes("stables"))).toBe(true);
    expect(inputs.some((i) => i.includes("for lunch"))).toBe(true);
    expect(inputs.some((i) => i.includes("what is usdc"))).toBe(true);
  });
});
