import { describe, expect, it } from "vitest";

import {
  isCasualConversationText,
  isFundIntent,
  parseDisplayName,
} from "./onboarding.utils.js";

describe("isFundIntent", () => {
  it("recognizes onramp requests with dollar amounts", () => {
    expect(isFundIntent("I want to onramp $10")).toBe("10");
    expect(isFundIntent("on ramp 25")).toBe("25");
  });

  it("recognizes bare onramp requests as a fund preset flow", () => {
    expect(isFundIntent("onramp")).toBe("0");
    expect(isFundIntent("on ramp")).toBe("0");
  });
});

describe("display-name onboarding", () => {
  it("accepts short human names and rejects commands or addresses", () => {
    expect(parseDisplayName("  Alex Morgan  ")).toBe("Alex Morgan");
    expect(parseDisplayName("O'Connor")).toBe("O'Connor");
    expect(parseDisplayName("send 10 USDC to Alex")).toBeNull();
    expect(parseDisplayName("0x1234567890abcdef")).toBeNull();
  });

  it("limits initial prompts to casual messages", () => {
    expect(isCasualConversationText("gm!")).toBe(true);
    expect(isCasualConversationText("thanks")).toBe(true);
    expect(isCasualConversationText("send 10 USDC to Alex")).toBe(false);
  });
});
