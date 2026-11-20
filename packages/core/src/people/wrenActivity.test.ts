import { describe, expect, it } from "vitest";
import { sendState } from "./wrenActivity.js";

const base = { txHash: null, failed: false, recipientKind: "wallet", escrowStatus: null };

describe("where a send is", () => {
  it("is sending until it lands on chain", () => {
    expect(sendState(base)).toBe("sending");
  });
  it("didn't send when it never reached the chain within an hour", () => {
    const now = new Date("2026-11-21T12:00:00Z");
    expect(sendState({ ...base, startedAt: new Date("2026-11-21T11:30:00Z"), now })).toBe("sending");
    expect(sendState({ ...base, startedAt: new Date("2026-11-21T10:30:00Z"), now })).toBe("failed");
  });
  it("failed when it didn't go through", () => {
    expect(sendState({ ...base, failed: true })).toBe("failed");
  });
  it("is in their account when they have Wren", () => {
    expect(sendState({ ...base, txHash: "0x1" })).toBe("in_account");
  });
  it("waits for someone without Wren, then lands or comes back", () => {
    const link = { ...base, txHash: "0x1", recipientKind: "claim_phone" };
    expect(sendState({ ...link, escrowStatus: "deposited" })).toBe("waiting");
    expect(sendState({ ...link, escrowStatus: null })).toBe("waiting");
    expect(sendState({ ...link, escrowStatus: "released" })).toBe("in_account");
    expect(sendState({ ...link, escrowStatus: "refunded" })).toBe("returned");
  });
});
