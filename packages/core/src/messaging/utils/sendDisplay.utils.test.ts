import { describe, expect, it } from "vitest";

import { formatContactSendDisplay } from "./sendDisplay.utils.js";

describe("formatContactSendDisplay", () => {
  it("prefers name + phone", () => {
    expect(
      formatContactSendDisplay({
        name: "Aritra",
        phone: "+916289874218",
        fallback: "0x1234…7890",
      }),
    ).toBe("Aritra (+916289874218)");
  });

  it("falls back to phone alone", () => {
    expect(
      formatContactSendDisplay({
        name: null,
        phone: "+916289874218",
        fallback: "0x1234…7890",
      }),
    ).toBe("+916289874218");
  });

  it("never prefers a raw 0x name over phone", () => {
    expect(
      formatContactSendDisplay({
        name: "0x1234567890123456789012345678901234567890",
        phone: "+916289874218",
        fallback: "0x1234…7890",
      }),
    ).toBe("+916289874218");
  });

  it("uses fallback only when no human identifier exists", () => {
    expect(
      formatContactSendDisplay({
        name: null,
        phone: null,
        fallback: "0x1234…7890",
      }),
    ).toBe("0x1234…7890");
  });
});
