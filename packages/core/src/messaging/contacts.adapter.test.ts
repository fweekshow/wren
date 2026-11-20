import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  ensureProfile: vi.fn(async () => undefined),
  getOrCreateForHandle: vi.fn(async () => ({ address: "0xrecipient" })),
}));

vi.mock("@/discovery/db.js", () => ({
  db: {
    async query(sql: string, params: unknown[] = []) {
      testState.queries.push({ sql, params });
      return { rows: [] };
    },
  },
}));

vi.mock("@/discovery/adapters/wallet.adapter.js", () => ({
  WalletAdapter: {
    ensureProfile: testState.ensureProfile,
    getOrCreateForHandle: testState.getOrCreateForHandle,
    resolveSenderKey: async (id: string) => id,
  },
}));

import { ContactsAdapter } from "./contacts.adapter.js";

describe("ContactsAdapter phone escrow model", () => {
  beforeEach(() => {
    testState.queries.length = 0;
    testState.ensureProfile.mockClear();
    testState.getOrCreateForHandle.mockClear();
  });

  it("stores normalized phone contacts without provisioning recipient CDP wallets", async () => {
    await ContactsAdapter.saveContact("sender-1", "Manila", "+63 917 123 4567");

    expect(testState.ensureProfile).toHaveBeenCalledWith("sender-1");
    expect(testState.getOrCreateForHandle).not.toHaveBeenCalled();
    expect(testState.queries).toContainEqual({
      sql: expect.stringContaining("contact_phone"),
      params: ["Manila", "sender-1", "+639171234567"],
    });
  });

  it("does not store a contact-card number that omits the country code", async () => {
    // Strict: no country code means no phone is stored (never inferred), so the
    // contact isn't saved with an unreachable/guessed handle.
    await ContactsAdapter.saveContact("sender-1", "Jesse Base", "(818) 860-8766");

    // Falls through to the name-only insert path — the phone upsert is skipped.
    expect(testState.queries).not.toContainEqual(
      expect.objectContaining({ sql: expect.stringContaining("contact_phone") }),
    );
  });
});

describe("ContactsAdapter.normalizeHandle", () => {
  it("keeps a valid E.164 number as-is", () => {
    expect(ContactsAdapter.normalizeHandle("+18188608766")).toBe("+18188608766");
    expect(ContactsAdapter.normalizeHandle("+63 917 123 4567")).toBe("+639171234567");
  });

  it("rejects numbers without an explicit country code (no inference)", () => {
    expect(ContactsAdapter.normalizeHandle("(818) 860-8766")).toBeNull();
    expect(ContactsAdapter.normalizeHandle("818-860-8766")).toBeNull();
    expect(ContactsAdapter.normalizeHandle("8188608766")).toBeNull();
    expect(ContactsAdapter.normalizeHandle("1-818-860-8766")).toBeNull();
  });

  it("returns null for ambiguous / empty inputs", () => {
    expect(ContactsAdapter.normalizeHandle("12345")).toBeNull();
    expect(ContactsAdapter.normalizeHandle("639171234567")).toBeNull();
    expect(ContactsAdapter.normalizeHandle(null)).toBeNull();
    expect(ContactsAdapter.normalizeHandle("")).toBeNull();
  });
});

describe("ContactsAdapter.findByNameFuzzy", () => {
  const contact = (id: number, name: string, phone: string) => ({
    id,
    name,
    contact_owner: "sender-1",
    contact: null,
    contact_phone: phone,
    created_at: new Date(),
    updated_at: new Date(),
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves a unique first or last name token", async () => {
    vi.spyOn(ContactsAdapter, "listContacts").mockResolvedValue([
      contact(1, "Alex Smith", "+15550000001"),
      contact(2, "Jordan Lee", "+15550000002"),
    ]);

    await expect(ContactsAdapter.findByNameFuzzy("sender-1", "alex")).resolves.toEqual({
      matches: [expect.objectContaining({ name: "Alex Smith" })],
      ambiguous: false,
    });
    await expect(ContactsAdapter.findByNameFuzzy("sender-1", "Lee")).resolves.toEqual({
      matches: [expect.objectContaining({ name: "Jordan Lee" })],
      ambiguous: false,
    });
  });

  it("returns every contact sharing a first or last name", async () => {
    vi.spyOn(ContactsAdapter, "listContacts").mockResolvedValue([
      contact(1, "Alex Smith", "+15550000001"),
      contact(2, "Alex Jones", "+15550000002"),
      contact(3, "Jordan Smith", "+15550000003"),
    ]);

    const firstName = await ContactsAdapter.findByNameFuzzy("sender-1", "Alex");
    expect(firstName.ambiguous).toBe(true);
    expect(firstName.matches.map((row) => row.name)).toEqual(["Alex Smith", "Alex Jones"]);

    const lastName = await ContactsAdapter.findByNameFuzzy("sender-1", "smith");
    expect(lastName.ambiguous).toBe(true);
    expect(lastName.matches.map((row) => row.name)).toEqual(["Alex Smith", "Jordan Smith"]);
  });

  it("returns duplicate exact full names as ambiguous", async () => {
    vi.spyOn(ContactsAdapter, "listContacts").mockResolvedValue([
      contact(1, "Alex Smith", "+15550000001"),
      contact(2, "Alex Smith", "+15550000002"),
      contact(3, "Alex Jones", "+15550000003"),
    ]);

    const result = await ContactsAdapter.findByNameFuzzy("sender-1", "ALEX SMITH");
    expect(result.ambiguous).toBe(true);
    expect(result.matches.map((row) => row.contact_phone)).toEqual([
      "+15550000001",
      "+15550000002",
    ]);
  });

  it("prefers an exact full name and retains fuzzy typo matching", async () => {
    vi.spyOn(ContactsAdapter, "listContacts").mockResolvedValue([
      contact(1, "Alex", "+15550000001"),
      contact(2, "Alex Smith", "+15550000002"),
      contact(3, "Degeneer", "+15550000003"),
    ]);

    await expect(ContactsAdapter.findByNameFuzzy("sender-1", "Alex")).resolves.toEqual({
      matches: [expect.objectContaining({ id: 1 })],
      ambiguous: false,
    });
    await expect(ContactsAdapter.findByNameFuzzy("sender-1", "Degener")).resolves.toEqual({
      matches: [expect.objectContaining({ name: "Degeneer" })],
      ambiguous: false,
    });
  });
});
