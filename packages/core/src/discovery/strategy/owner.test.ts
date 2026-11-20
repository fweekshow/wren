import { describe, expect, it } from "vitest";

import {
  encodeStrategyOwner,
  isXmtpInboxId,
  ownerWalletIdentity,
  parseStrategyOwner,
  resolveCanonicalStrategyOwner,
} from "./owner.js";

const XMTP_A = "a".repeat(64);

describe("isXmtpInboxId", () => {
  it("accepts 64-hex inbox ids, rejects telegram ids and junk", () => {
    expect(isXmtpInboxId(XMTP_A)).toBe(true);
    expect(isXmtpInboxId("123456789")).toBe(false);
    expect(isXmtpInboxId("tg:123")).toBe(false);
    expect(isXmtpInboxId("")).toBe(false);
  });
});

describe("encode/parse owner key (dual)", () => {
  it("round-trips an xmtp owner as the raw inbox id (back-compat)", () => {
    const key = encodeStrategyOwner({ platform: "xmtp", inboxId: XMTP_A });
    expect(key).toBe(XMTP_A);
    expect(parseStrategyOwner(key)).toEqual({ platform: "xmtp", inboxId: XMTP_A });
  });

  it("round-trips a telegram owner as tg:<id>", () => {
    const key = encodeStrategyOwner({ platform: "telegram", userId: "555" });
    expect(key).toBe("tg:555");
    expect(parseStrategyOwner(key)).toEqual({ platform: "telegram", userId: "555" });
  });

  it("throws on an unrecognized owner key", () => {
    expect(() => parseStrategyOwner("not-an-owner")).toThrow(/unrecognized/);
    expect(() => parseStrategyOwner("tg:")).toThrow();
  });

  it("maps each owner to its isolated wallet identity", () => {
    expect(ownerWalletIdentity({ platform: "xmtp", inboxId: XMTP_A })).toEqual({
      platform: "xmtp",
      userKey: XMTP_A,
    });
    expect(ownerWalletIdentity({ platform: "telegram", userId: "555" })).toEqual({
      platform: "telegram",
      userKey: "555",
    });
  });
});

describe("resolveCanonicalStrategyOwner (dual, telegram-native)", () => {
  it("resolves an xmtp caller to itself", () => {
    const r = resolveCanonicalStrategyOwner({ platform: "xmtp", userKey: XMTP_A });
    expect(r).toMatchObject({ ok: true, ownerKey: XMTP_A });
  });

  it("rejects a malformed xmtp inbox", () => {
    expect(resolveCanonicalStrategyOwner({ platform: "xmtp", userKey: "nope" }).ok).toBe(false);
  });

  it("makes a telegram user its own owner — no Base App / linking required", () => {
    const r = resolveCanonicalStrategyOwner({ platform: "telegram", userKey: "555" });
    expect(r).toMatchObject({ ok: true, ownerKey: "tg:555" });
    if (r.ok) expect(r.owner).toEqual({ platform: "telegram", userId: "555" });
  });
});
