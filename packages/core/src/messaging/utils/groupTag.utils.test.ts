import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config/config.js", () => ({
  config: { mentionHandle: "basemate", cdp: { onrampSandbox: true } },
}));

import {
  extractPersonTags,
  extractPrimaryPersonTag,
  matchParticipantByName,
  normalizeGroupParticipants,
  participantIncludesPhone,
} from "./groupTag.utils.js";

describe("extractPersonTags", () => {
  it("extracts person tags and excludes basemate", () => {
    expect(extractPersonTags("@Basemate @Aritra 5 USDC")).toEqual(["Aritra"]);
    expect(extractPersonTags("@basemate send 5 USDC to @Aritra")).toEqual(["Aritra"]);
    expect(extractPrimaryPersonTag("@Aritra 5 USDC")).toBe("Aritra");
  });

  it("returns multiple person tags in order", () => {
    expect(extractPersonTags("hey @Alice and @Bob")).toEqual(["Alice", "Bob"]);
  });

  it("dedupes case-insensitively", () => {
    expect(extractPersonTags("@Aritra @aritra")).toEqual(["Aritra"]);
  });
});

describe("normalizeGroupParticipants", () => {
  it("normalizes string handles", () => {
    expect(normalizeGroupParticipants(["+15551234567", "15559876543"])).toEqual([
      { id: "+15551234567" },
      { id: "+15559876543" },
    ]);
  });

  it("normalizes object shapes with name", () => {
    expect(
      normalizeGroupParticipants([
        { id: "+15551234567", name: "Aritra" },
        { handle: "+15559876543", displayName: "Bob" },
      ]),
    ).toEqual([
      { id: "+15551234567", name: "Aritra" },
      { id: "+15559876543", name: "Bob" },
    ]);
  });

  it("ignores invalid entries", () => {
    expect(normalizeGroupParticipants([null, 42, {}, ""])).toEqual([]);
  });
});

describe("matchParticipantByName", () => {
  it("matches a unique display name", () => {
    const hit = matchParticipantByName("Aritra", [
      { id: "+15551111111", name: "Aritra" },
      { id: "+15552222222", name: "Bob" },
    ]);
    expect(hit?.id).toBe("+15551111111");
  });

  it("returns null when no names are present", () => {
    expect(matchParticipantByName("Aritra", [{ id: "+15551111111" }])).toBeNull();
  });
});

describe("participantIncludesPhone", () => {
  it("matches canonical and digit forms", () => {
    const participants = [{ id: "+15551234567" }];
    expect(participantIncludesPhone(participants, "+15551234567")).toBe(true);
    expect(participantIncludesPhone(participants, "15551234567")).toBe(true);
    expect(participantIncludesPhone(participants, "+15550000000")).toBe(false);
  });
});
