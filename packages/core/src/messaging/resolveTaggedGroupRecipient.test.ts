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

import { ContactsAdapter } from "@/messaging/contacts.adapter.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { resolveTaggedGroupRecipient } from "./resolveSendTarget.js";

describe("resolveTaggedGroupRecipient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(WalletAdapter.resolveSenderKey).mockImplementation(async (id) => id);
    vi.mocked(ContactsAdapter.findByNameFuzzy).mockResolvedValue({
      matches: [],
      ambiguous: false,
    });
    vi.mocked(ContactsAdapter.findByPhone).mockResolvedValue(null);
    vi.mocked(WalletAdapter.getReceiveAddress).mockResolvedValue(null);
    vi.mocked(WalletAdapter.getIdentity).mockResolvedValue(null);
  });

  it("resolves via participant display name to a wallet", async () => {
    vi.mocked(WalletAdapter.getReceiveAddress).mockResolvedValue(
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );

    const target = await resolveTaggedGroupRecipient("+15550001111", "Aritra", [
      { id: "+916289874218", name: "Aritra" },
      { id: "+15552222222", name: "Bob" },
    ]);

    expect(target.kind).toBe("wallet");
    expect(target.fromGroupParticipant).toBe(true);
    if (target.kind === "wallet") {
      expect(target.phone).toBe("+916289874218");
      expect(target.name).toBe("Aritra");
      expect(target.address).toBe("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    }
  });

  it("resolves via participant display name to claim_phone when no wallet", async () => {
    const target = await resolveTaggedGroupRecipient("+15550001111", "Aritra", [
      { id: "+916289874218", name: "Aritra" },
    ]);

    expect(target.kind).toBe("claim_phone");
    expect(target.fromGroupParticipant).toBe(true);
    if (target.kind === "claim_phone") {
      expect(target.phone).toBe("+916289874218");
    }
  });

  it("disambiguates contacts by group membership", async () => {
    vi.mocked(ContactsAdapter.findByNameFuzzy).mockResolvedValue({
      matches: [
        {
          id: 1,
          name: "Alex",
          contact_owner: "+15550001111",
          contact: null,
          contact_phone: "+15550002222",
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: 2,
          name: "Alex",
          contact_owner: "+15550001111",
          contact: null,
          contact_phone: "+15550003333",
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      ambiguous: false,
    });
    vi.mocked(WalletAdapter.getReceiveAddress).mockImplementation(async (phone) =>
      phone === "+15550003333" ? "0xcccccccccccccccccccccccccccccccccccccccc" : null,
    );

    const target = await resolveTaggedGroupRecipient("+15550001111", "Alex", [
      { id: "+15550003333" },
      { id: "+15550009999" },
    ]);

    expect(target.kind).toBe("wallet");
    expect(target.fromGroupParticipant).toBe(true);
    if (target.kind === "wallet") {
      expect(target.phone).toBe("+15550003333");
    }
  });

  it("falls back to contact book when participants have no names", async () => {
    vi.mocked(ContactsAdapter.findByNameFuzzy).mockResolvedValue({
      matches: [
        {
          id: 1,
          name: "Aritra",
          contact_owner: "+15550001111",
          contact: null,
          contact_phone: "+916289874218",
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      ambiguous: false,
    });
    vi.mocked(WalletAdapter.getReceiveAddress).mockResolvedValue(
      "0xdddddddddddddddddddddddddddddddddddddddd",
    );

    const target = await resolveTaggedGroupRecipient("+15550001111", "Aritra", [
      { id: "+15550009999" },
    ]);

    expect(target.kind).toBe("wallet");
    expect(target.fromGroupParticipant).toBe(false);
  });

  it("returns unknown when nothing matches", async () => {
    const target = await resolveTaggedGroupRecipient("+15550001111", "Nobody", [
      { id: "+15550009999" },
    ]);
    expect(target).toEqual({
      kind: "unknown",
      display: "Nobody",
      fromGroupParticipant: false,
    });
  });
});
