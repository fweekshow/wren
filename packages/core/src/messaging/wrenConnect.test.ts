import { describe, expect, it, vi } from "vitest";

vi.mock("@/discovery/adapters/wallet.adapter.js", () => ({ WalletAdapter: {} }));
vi.mock("@/discovery/db.js", () => ({ db: {} }));
vi.mock("@/utils/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("@/messaging/wrenAccount.js", () => ({ markOptIn: vi.fn(), setPrivyUserId: vi.fn() }));

import { connectPrefill, parseConnectText } from "./wrenConnect.js";

describe("parseConnectText", () => {
  it("reads the prefilled text", () => {
    expect(parseConnectText(connectPrefill("47RW8M"))).toEqual({ matched: true, code: "47RW8M" });
  });

  it("still reads the older formats", () => {
    expect(parseConnectText("Turn on Wren · 47RW8M")).toEqual({ matched: true, code: "47RW8M" });
    expect(parseConnectText("turn on wren")).toEqual({ matched: true, code: null });
    expect(parseConnectText(" Chirp ")).toEqual({ matched: true, code: null });
  });

  it("survives edits around the code", () => {
    expect(parseConnectText("hey wren!! 47RW8M")).toEqual({ matched: true, code: "47RW8M" });
    expect(parseConnectText("Hey Wren 👋 my code is 47RW8M.")).toEqual({ matched: true, code: "47RW8M" });
  });

  it("leaves ordinary chat alone", () => {
    expect(parseConnectText("what is wren?").matched).toBe(false);
    expect(parseConnectText("buy 10 AAPL").matched).toBe(false);
    expect(parseConnectText("send BITCOIN to wren").matched).toBe(false);
    expect(parseConnectText("47RW8M").matched).toBe(false);
  });
});
