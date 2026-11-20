import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/messaging/contacts.adapter.js", () => ({
  ContactsAdapter: {
    findByPhone: vi.fn(),
  },
}));

vi.mock("@/discovery/adapters/wallet.adapter.js", () => ({
  WalletAdapter: {
    getDisplayName: vi.fn(),
  },
}));

import { ContactsAdapter } from "@/messaging/contacts.adapter.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import {
  enrichGroupParticipantNames,
  resolveLiveGroupParticipants,
} from "./groupParticipants.js";

describe("enrichGroupParticipantNames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ContactsAdapter.findByPhone).mockResolvedValue(null);
    vi.mocked(WalletAdapter.getDisplayName).mockResolvedValue(null);
  });

  it("fills names from the sender contact book", async () => {
    vi.mocked(ContactsAdapter.findByPhone).mockResolvedValue({
      id: 1,
      name: "Shivam Sarkar",
      contact_owner: "+15550001111",
      contact: null,
      contact_phone: "+15550009999",
      created_at: new Date(),
      updated_at: new Date(),
    });

    const enriched = await enrichGroupParticipantNames("+15550001111", [
      { id: "+15550009999" },
    ]);

    expect(enriched).toEqual([{ id: "+15550009999", name: "Shivam Sarkar" }]);
  });

  it("falls back to Basemate display names", async () => {
    vi.mocked(WalletAdapter.getDisplayName).mockResolvedValue("Aritra");

    const enriched = await enrichGroupParticipantNames("+15550001111", [
      { id: "+916289874218" },
    ]);

    expect(enriched).toEqual([{ id: "+916289874218", name: "Aritra" }]);
  });
});

describe("resolveLiveGroupParticipants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ContactsAdapter.findByPhone).mockResolvedValue(null);
    vi.mocked(WalletAdapter.getDisplayName).mockResolvedValue(null);
  });

  it("loads the live roster from chats.get and applies mention names", async () => {
    const client = {
      chats: {
        get: vi.fn(async () => ({
          participants: [
            { address: "+15550001111", service: "iMessage" as const },
            { address: "+15550009999", service: "iMessage" as const },
          ],
        })),
      },
      messages: {
        get: vi.fn(async () => ({
          content: {
            text: "Basemate send 0.1 USDC to @Shivam",
            mentions: [{ address: "+15550009999", start: 26, length: 7 }],
          },
        })),
      },
    };

    const participants = await resolveLiveGroupParticipants({
      client,
      spaceId: "any;+;group-id",
      senderId: "+15550001111",
      messageId: "msg-1",
    });

    expect(client.chats.get).toHaveBeenCalledWith("any;+;group-id");
    expect(participants).toEqual(
      expect.arrayContaining([
        { id: "+15550001111" },
        { id: "+15550009999", name: "Shivam" },
      ]),
    );
  });

  it("still enriches names when the webhook seed is empty", async () => {
    vi.mocked(ContactsAdapter.findByPhone).mockImplementation(async (_owner, phone) =>
      phone === "+15550009999"
        ? {
            id: 1,
            name: "Shivam Sarkar",
            contact_owner: "+15550001111",
            contact: null,
            contact_phone: "+15550009999",
            created_at: new Date(),
            updated_at: new Date(),
          }
        : null,
    );

    const client = {
      chats: {
        get: vi.fn(async () => ({
          participants: [{ address: "+15550009999", service: "iMessage" as const }],
        })),
      },
      messages: {
        get: vi.fn(async () => ({ content: { text: "hi", mentions: [] } })),
      },
    };

    const participants = await resolveLiveGroupParticipants({
      client,
      spaceId: "any;+;group-id",
      senderId: "+15550001111",
    });

    expect(participants).toEqual([{ id: "+15550009999", name: "Shivam Sarkar" }]);
  });
});
