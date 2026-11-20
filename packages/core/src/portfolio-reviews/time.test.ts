import { describe, expect, it } from "vitest";

import { formatReviewSchedule, nextDailyRunAt, parseReviewTime } from "./time.js";

describe("portfolio review time helpers", () => {
  it("parses local wall-clock time and IANA timezone", () => {
    expect(parseReviewTime("portfolio review every day at 9:30pm Asia/Kolkata")).toEqual({
      localTime: "21:30",
      timezone: "Asia/Kolkata",
    });
    expect(parseReviewTime("send it daily at 8am")).toEqual({
      localTime: "08:00",
      timezone: null,
    });
  });

  it("formats review schedule copy", () => {
    expect(formatReviewSchedule("08:00", "America/New_York")).toBe(
      "8:00am America/New_York",
    );
    expect(formatReviewSchedule("21:30", "Asia/Kolkata")).toBe(
      "9:30pm Asia/Kolkata",
    );
  });

  it("computes next UTC run from a timezone local time", () => {
    const from = new Date("2026-06-08T13:00:00.000Z");
    expect(nextDailyRunAt("21:30", "Asia/Kolkata", from).toISOString()).toBe(
      "2026-06-08T16:00:00.000Z",
    );
  });

  it("rolls to tomorrow when today's local time has passed", () => {
    const from = new Date("2026-06-08T17:00:00.000Z");
    expect(nextDailyRunAt("21:30", "Asia/Kolkata", from).toISOString()).toBe(
      "2026-06-09T16:00:00.000Z",
    );
  });
});
