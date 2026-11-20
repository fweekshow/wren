import { describe, expect, it } from "vitest";

import {
  canonicalizeSenderId,
  isEmailHandle,
  isPhoneClaimHandle,
  senderIdLookupKeys,
} from "./senderId.utils.js";

describe("canonicalizeSenderId", () => {
  it("keeps E.164 phones with leading +", () => {
    expect(canonicalizeSenderId("+15551234567")).toBe("+15551234567");
    expect(canonicalizeSenderId("+91 9330 266 945")).toBe("+919330266945");
  });

  it("prepends + to Spectrum digit-only handles that already include country code", () => {
    expect(canonicalizeSenderId("15551234567")).toBe("+15551234567");
    expect(canonicalizeSenderId("919330266945")).toBe("+919330266945");
  });

  it("leaves emails unchanged", () => {
    expect(canonicalizeSenderId("user@example.com")).toBe("user@example.com");
    expect(isEmailHandle("user@example.com")).toBe(true);
  });
});

describe("senderIdLookupKeys", () => {
  it("returns both digit-only and +E.164 variants", () => {
    const keys = senderIdLookupKeys("919330266945");
    expect(keys).toEqual(expect.arrayContaining(["919330266945", "+919330266945"]));
  });

  it("returns email as a single key", () => {
    expect(senderIdLookupKeys("a@b.co")).toEqual(["a@b.co"]);
  });
});

describe("isPhoneClaimHandle", () => {
  it("accepts phone handles and rejects emails", () => {
    expect(isPhoneClaimHandle("+15551234567")).toBe(true);
    expect(isPhoneClaimHandle("15551234567")).toBe(true);
    expect(isPhoneClaimHandle("user@example.com")).toBe(false);
  });
});
