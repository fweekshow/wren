import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/messaging/contacts.adapter.js", () => ({
  ContactsAdapter: {
    findByPhone: vi.fn(),
    saveContact: vi.fn(),
  },
}));

vi.mock("@/state/conversationState.store.js", () => ({
  convKey: (platform: string, scope: string, key: string) => `${platform}:${scope}:${key}`,
  stateSet: vi.fn(),
  stateGet: vi.fn(),
  stateDelete: vi.fn(),
}));

import { ContactsAdapter } from "@/messaging/contacts.adapter.js";
import { stateDelete, stateGet, stateSet } from "@/state/conversationState.store.js";
import {
  consumePendingAutoSaveContact,
  maybeAutoSaveGroupContact,
  stashPendingAutoSaveContact,
} from "./autoSaveContact.utils.js";

describe("autoSaveContact utils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves a new contact on success", async () => {
    vi.mocked(ContactsAdapter.findByPhone).mockResolvedValue(null);
    await maybeAutoSaveGroupContact("+15550001111", {
      name: "Aritra",
      phone: "+916289874218",
    });
    expect(ContactsAdapter.saveContact).toHaveBeenCalledWith(
      "+15550001111",
      "Aritra",
      "+916289874218",
    );
  });

  it("skips save when contact already exists", async () => {
    vi.mocked(ContactsAdapter.findByPhone).mockResolvedValue({
      id: 1,
      name: "Aritra",
      contact_owner: "+15550001111",
      contact: null,
      contact_phone: "+916289874218",
      created_at: new Date(),
      updated_at: new Date(),
    });
    await maybeAutoSaveGroupContact("+15550001111", {
      name: "Aritra",
      phone: "+916289874218",
    });
    expect(ContactsAdapter.saveContact).not.toHaveBeenCalled();
  });

  it("stashes and consumes pending auto-save after pay confirm", async () => {
    vi.mocked(stateGet).mockResolvedValue({ name: "Aritra", phone: "+916289874218" });
    vi.mocked(ContactsAdapter.findByPhone).mockResolvedValue(null);

    await stashPendingAutoSaveContact("+15550001111", "abcd".repeat(8), {
      name: "Aritra",
      phone: "+916289874218",
    });
    expect(stateSet).toHaveBeenCalled();

    await consumePendingAutoSaveContact("+15550001111", "abcd".repeat(8));
    expect(stateDelete).toHaveBeenCalled();
    expect(ContactsAdapter.saveContact).toHaveBeenCalledWith(
      "+15550001111",
      "Aritra",
      "+916289874218",
    );
  });
});
