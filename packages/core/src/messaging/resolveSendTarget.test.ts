import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/messaging/contacts.adapter.js", () => ({
  ContactsAdapter: {
    findByNameFuzzy: vi.fn(),
    findByPhone: vi.fn(),
    findByWalletAddress: vi.fn(),
    resolveWallet: vi.fn(),
    normalizeHandle: vi.fn((raw: string) =>
      /^\+\d{7,15}$/.test(raw.replace(/[^\d+]/g, ""))
        ? raw.replace(/[^\d+]/g, "")
        : null,
    ),
  },
}));

vi.mock("@/discovery/adapters/wallet.adapter.js", () => ({
  WalletAdapter: {
    resolveSenderKey: vi.fn(async (id: string) => id),
    getReceiveAddress: vi.fn(),
    getIdentity: vi.fn(),
  },
}));

vi.mock("@/discovery/services/sendRecipient.service.js", () => ({
  resolveSendRecipient: vi.fn(),
}));

vi.mock("@/messaging/utils/groupTag.utils.js", () => ({
  matchParticipantByName: vi.fn(),
  participantIncludesPhone: vi.fn(),
}));

import { ContactsAdapter } from "@/messaging/contacts.adapter.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { resolveSendRecipient } from "@/discovery/services/sendRecipient.service.js";
import { resolveSendTarget } from "./resolveSendTarget.js";

describe("resolveSendTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(WalletAdapter.resolveSenderKey).mockImplementation(async (id) => id);
    vi.mocked(ContactsAdapter.findByNameFuzzy).mockResolvedValue({
      matches: [],
      ambiguous: false,
    });
    vi.mocked(ContactsAdapter.findByPhone).mockResolvedValue(null);
    vi.mocked(ContactsAdapter.findByWalletAddress).mockResolvedValue(null);
    vi.mocked(ContactsAdapter.resolveWallet).mockResolvedValue(null);
    vi.mocked(WalletAdapter.getReceiveAddress).mockResolvedValue(null);
    vi.mocked(WalletAdapter.getIdentity).mockResolvedValue(null);
    vi.mocked(resolveSendRecipient).mockResolvedValue({ error: "nope" });
  });

  it("resolves an exact contact name to a wallet receive address", async () => {
    vi.mocked(ContactsAdapter.findByNameFuzzy).mockResolvedValue({
      matches: [
        {
          id: 1,
          name: "Degeneer",
          contact_owner: "+15550001111",
          contact: "+919330266945",
          contact_phone: "+919330266945",
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      ambiguous: false,
    });
    vi.mocked(WalletAdapter.getReceiveAddress).mockResolvedValue(
      "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
    );

    const target = await resolveSendTarget("+15550001111", { name: "degeneer" });
    expect(target.kind).toBe("wallet");
    if (target.kind === "wallet") {
      expect(target.address).toBe("0xabcabcabcabcabcabcabcabcabcabcabcabcabca");
      expect(target.phone).toBe("+919330266945");
      expect(target.display).toContain("Degeneer");
      expect(target.display).toContain("+919330266945");
    }
  });

  it("returns claim_phone for phone-only contacts", async () => {
    vi.mocked(ContactsAdapter.findByNameFuzzy).mockResolvedValue({
      matches: [
        {
          id: 1,
          name: "Degeneer",
          contact_owner: "+15550001111",
          contact: null,
          contact_phone: "+919330266945",
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      ambiguous: false,
    });
    vi.mocked(WalletAdapter.getReceiveAddress).mockResolvedValue(null);
    vi.mocked(WalletAdapter.getIdentity).mockResolvedValue(null);

    const target = await resolveSendTarget("+15550001111", { name: "Degeneer" });
    expect(target.kind).toBe("claim_phone");
    if (target.kind === "claim_phone") {
      expect(target.phone).toBe("+919330266945");
      expect(target.isOnBasemate).toBe(false);
    }
  });

  it("returns every candidate when contacts share the queried first name", async () => {
    vi.mocked(ContactsAdapter.findByNameFuzzy).mockResolvedValue({
      matches: [
        {
          id: 1,
          name: "Alex Smith",
          contact_owner: "+15550001111",
          contact: null,
          contact_phone: "+15550002222",
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: 2,
          name: "Alex Jones",
          contact_owner: "+15550001111",
          contact: null,
          contact_phone: "+15550003333",
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      ambiguous: true,
    });

    const target = await resolveSendTarget("+15550001111", { name: "Alex" });
    expect(target.kind).toBe("ambiguous");
    if (target.kind === "ambiguous") {
      expect(target.candidates).toEqual([
        { name: "Alex Smith", phone: "+15550002222" },
        { name: "Alex Jones", phone: "+15550003333" },
      ]);
    }
  });

  it("resolves 0x via reverse contact lookup for display", async () => {
    const addr = "0x1234567890123456789012345678901234567890";
    vi.mocked(resolveSendRecipient).mockResolvedValue({
      address: addr.toLowerCase(),
      display: "0x1234…7890",
    });
    vi.mocked(ContactsAdapter.findByWalletAddress).mockResolvedValue({
      id: 1,
      name: "Aritra",
      contact_owner: "+15550001111",
      contact: "+916289874218",
      contact_phone: "+916289874218",
      created_at: new Date(),
      updated_at: new Date(),
    });

    const target = await resolveSendTarget("+15550001111", { address: addr });
    expect(target.kind).toBe("wallet");
    if (target.kind === "wallet") {
      expect(target.display).toBe("Aritra (+916289874218)");
      expect(target.phone).toBe("+916289874218");
    }
  });

  it("resolves embedded-only users via getReceiveAddress on phone input", async () => {
    vi.mocked(WalletAdapter.getReceiveAddress).mockResolvedValue(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    const target = await resolveSendTarget("+15550001111", { phone: "+919330266945" });
    expect(target.kind).toBe("wallet");
    if (target.kind === "wallet") {
      expect(target.address).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    }
  });

  it("returns unknown for names not in the owner contact book", async () => {
    const target = await resolveSendTarget("+15550001111", { name: "stranger" });
    expect(target).toEqual({ kind: "unknown", display: "stranger" });
  });
});
