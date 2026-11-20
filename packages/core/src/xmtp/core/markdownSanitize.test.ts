import { describe, expect, it } from "vitest";

import { sanitizeXmptMarkdown } from "./markdownSanitize.js";

describe("sanitizeXmptMarkdown", () => {
  it("rewrites approximate tildes", () => {
    expect(sanitizeXmptMarkdown("margin: ~$2 per trade")).toBe("margin: about $2 per trade");
    expect(sanitizeXmptMarkdown("total: ~$12.82")).toBe("total: about $12.82");
    expect(sanitizeXmptMarkdown("warming up (~12 min before first entry)")).toBe(
      "warming up (about 12 min before first entry)",
    );
  });

  it("unwraps strikethrough markdown", () => {
    expect(sanitizeXmptMarkdown("was ~~$25~~ now $2")).toBe("was $25 now $2");
  });

  it("leaves normal markdown alone", () => {
    expect(sanitizeXmptMarkdown("**ETH 75x Impulse Scalper**")).toBe(
      "**ETH 75x Impulse Scalper**",
    );
  });
});
