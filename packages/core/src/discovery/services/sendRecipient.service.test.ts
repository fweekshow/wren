import { describe, expect, it, vi } from "vitest";

import {
  isAllowedSendRecipient,
  resolveSendRecipient,
} from "./sendRecipient.service.js";

vi.mock("@/discovery/services/basename.util.js", () => ({
  basenameBareLabel: (name: string) =>
    name.trim().replace(/^@+/, "").replace(/\.(base\.)?eth$/i, "").toLowerCase(),
  resolveBasename: vi.fn(),
  resolveEnsNameForward: vi.fn(async (name: string) => {
    if (name === "bob.base.eth") return "0x2222222222222222222222222222222222222222";
    return null;
  }),
}));

describe("isAllowedSendRecipient", () => {
  it("allows 0x and basenames", () => {
    expect(isAllowedSendRecipient("0xABC1230000000000000000000000000000000001")).toBe(true);
    expect(isAllowedSendRecipient("bob.base.eth")).toBe(true);
    expect(isAllowedSendRecipient("@jesse.base.eth")).toBe(true);
  });

  it("rejects bare handles and non-ENS names", () => {
    expect(isAllowedSendRecipient("alice")).toBe(false);
    expect(isAllowedSendRecipient("@yeeeee")).toBe(false);
    expect(isAllowedSendRecipient("mom")).toBe(false);
    expect(isAllowedSendRecipient("john.doe")).toBe(false);
  });

  it("allows .eth and .base.eth", () => {
    expect(isAllowedSendRecipient("vitalik.eth")).toBe(true);
    expect(isAllowedSendRecipient("alice.base.eth")).toBe(true);
  });
});

describe("resolveSendRecipient", () => {
  it("resolves 0x addresses directly", async () => {
    const result = await resolveSendRecipient("0xABC1230000000000000000000000000000000001");
    expect(result).toEqual({
      address: "0xabc1230000000000000000000000000000000001",
      display: "0xABC1230000000000000000000000000000000001",
    });
  });

  it("resolves full basename", async () => {
    const result = await resolveSendRecipient("bob.base.eth");
    expect(result).toEqual({
      address: "0x2222222222222222222222222222222222222222",
      display: "bob.base.eth",
    });
  });

  it("rejects bare @handle", async () => {
    const result = await resolveSendRecipient("@alice");
    expect(result).toMatchObject({
      error: expect.stringMatching(/basename.*0x address/i),
    });
  });

  it("rejects bare name without .base.eth", async () => {
    const result = await resolveSendRecipient("degeneer");
    expect(result).toMatchObject({
      error: expect.stringMatching(/@handles are not supported/i),
    });
  });
});
