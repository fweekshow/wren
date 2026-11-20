import { describe, expect, it } from "vitest";

import { isPortfolioReviewIntent } from "./commands.js";
import { parseReviewTime } from "./time.js";

describe("portfolio review command intent", () => {
  it("handles the common 'portolfio review' typo from chat", async () => {
    const text = "Send me a portolfio review at 8:30PM Asia/Calcutta timezone";

    expect(isPortfolioReviewIntent(text)).toBe(true);
    expect(parseReviewTime(text)).toEqual({
      localTime: "20:30",
      timezone: "Asia/Calcutta",
    });
  });
});
