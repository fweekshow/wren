import { describe, expect, it } from "vitest";

import { normalizeWhatsappInbound } from "./inbound.js";

describe("normalizeWhatsappInbound", () => {
  it("normalizes text messages", () => {
    expect(normalizeWhatsappInbound({ type: "text", body: "  swap 10 usdc to eth  " })).toEqual({
      kind: "text",
      text: "swap 10 usdc to eth",
    });
  });

  it("maps interactive button replies to text", () => {
    expect(normalizeWhatsappInbound({
      type: "interactive",
      interactive: {
        type: "button_reply",
        reply: { id: "confirm", title: "Confirm" },
      },
    })).toEqual({ kind: "text", text: "Confirm" });
  });

  it("normalizes contact cards", () => {
    expect(normalizeWhatsappInbound({
      type: "contacts",
      contacts: [
        {
          name: { formattedName: "Alice Example" },
          phones: [{ phone: "+15551234567" }],
        },
      ],
    })).toEqual({
      kind: "contact",
      name: "Alice Example",
      phone: "+15551234567",
    });
  });

  it("returns an unsupported fallback for media", () => {
    const normalized = normalizeWhatsappInbound({ type: "image" });

    expect(normalized.kind).toBe("unsupported");
    if (normalized.kind === "unsupported") {
      expect(normalized.reply).toContain("text");
    }
  });
});
