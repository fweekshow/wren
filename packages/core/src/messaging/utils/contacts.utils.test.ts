import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/config/config.js", () => ({
  config: { cdp: { onrampSandbox: true }, mentionHandle: "basemate" },
}));
vi.mock("../contacts.adapter.js", () => ({
  ContactsAdapter: {
    normalizeHandle: (raw: string) => raw,
    saveContact: vi.fn(),
  },
}));

describe("extractRecipientName", () => {
  let extractRecipientName: (text: string) => string | null;

  beforeAll(async () => {
    ({ extractRecipientName } = await import("./contacts.utils.js"));
  });

  it("extracts recipient-first names for classic verbs", () => {
    expect(extractRecipientName("send Degeneer .01 usdc")).toBe("Degeneer");
    expect(extractRecipientName("pay bob 5 usdc")).toBe("bob");
    expect(extractRecipientName("transfer alice 1 usdc")).toBe("alice");
  });

  it("extracts recipient-first names for slang verbs", () => {
    expect(extractRecipientName("tip Degeneer .01 usdc")).toBe("Degeneer");
    expect(extractRecipientName("give Degeneer .01 usdc")).toBe("Degeneer");
    expect(extractRecipientName("shoot alice 10 usdc")).toBe("alice");
    expect(extractRecipientName("toss bob 2 usdc")).toBe("bob");
  });

  it("extracts recipient-first with leading-decimal amounts (.1 / .01)", () => {
    expect(extractRecipientName("Send degeneer .1 usdc")).toBe("degeneer");
    expect(extractRecipientName("Send Degeneer .1 usdc")).toBe("Degeneer");
    expect(extractRecipientName("send degeneer .01 usdc")).toBe("degeneer");
  });

  it("extracts names after to/for", () => {
    expect(extractRecipientName("send .01 usdc to Degeneer")).toBe("Degeneer");
    expect(extractRecipientName("fire over .01 usdc to Degeneer")).toBe("Degeneer");
    expect(extractRecipientName("send $2 for Alice")).toBe("Alice");
  });

  it("prefers @person tags over to/for phrasing", () => {
    expect(extractRecipientName("@Aritra 5 USDC")).toBe("Aritra");
    expect(extractRecipientName("send 5 USDC to @Aritra")).toBe("Aritra");
  });

  it("does not treat memo words after for as recipients", () => {
    expect(extractRecipientName("send Degeneer .01 usdc for lunch")).toBe("Degeneer");
  });
});
