import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config/config.js", () => ({
  config: { env: "test" },
}));

interface WalletRow {
  sender_id: string;
  account_name: string;
  address: string;
  provisioned_via_contact: boolean;
  tx_pref?: string | null;
  display_name?: string | null;
}

vi.mock("@/discovery/db.js", () => {
  const rows = new Map<string, WalletRow>();

  function lookupRow(params: unknown[]): WalletRow | undefined {
    for (const value of params) {
      if (typeof value !== "string") continue;
      if (rows.has(value)) return rows.get(value);
      if (/^\d{7,15}$/.test(value) && rows.has(`+${value}`)) return rows.get(`+${value}`);
    }
    return undefined;
  }

  return {
    __rows: rows,
    db: {
      async query(query: string | { text: string; values?: unknown[] }, params: unknown[] = []) {
        const sql = typeof query === "string" ? query : query.text;
        if (typeof query !== "string") params = query.values ?? params;
        const s = sql.replace(/\s+/g, " ").trim();
        const lower = s.toLowerCase();
        if (lower.startsWith("select")) {
          const row = lookupRow(params);
          if (!row) return { rows: [] };
          // Drizzle's node-postgres mapper reads rows as objects keyed by
          // selected column names.
          // Drizzle node-postgres uses rowMode: "array" — return positional
          // values in SELECT column order.
          if (lower.includes('select "account_name", "address"')) {
            return { rows: [[row.account_name, row.address]] };
          }
          if (/select\s+"display_name"\s+from/.test(lower)) {
            return { rows: [[row.display_name ?? null]] };
          }
          if (/select\s+"sender_id"\s+from/.test(lower)) {
            return { rows: [[row.sender_id]] };
          }
          return {
            rows: [
              [
                row.sender_id,
                row.account_name,
                row.address,
                row.display_name ?? null,
                null, // basename
                null, // first_seen_at
                null, // last_active_at
                row.tx_pref ?? null,
                null, // pay_mode
                null, // embedded_pay_mode
                null, // auto_send_limit_usd
                null, // cdp_user_id
                null, // embedded_address
                null, // delegation_id
                null, // delegation_expires_at
                row.provisioned_via_contact,
              ],
            ],
          };
        }
        if (lower.startsWith('insert into "imessage_wallets"')) {
          const sender_id = params.find(
            (value): value is string => typeof value === "string" && value.startsWith("+"),
          );
          const account_name = params.find(
            (value): value is string => typeof value === "string" && value.startsWith("im-"),
          );
          const addresses = params.filter(
            (value): value is string => typeof value === "string" && value.startsWith("0x"),
          );
          const address = addresses[0] ?? "";
          const provisionedViaContact = params.some((value) => value === true);
          if (sender_id && !rows.has(sender_id)) {
            const { createHash } = await import("node:crypto");
            const fallbackName = `im-${createHash("sha256").update(sender_id).digest("hex").slice(0, 30)}`;
            rows.set(sender_id, {
              sender_id,
              account_name: account_name ?? fallbackName,
              address,
              provisioned_via_contact: provisionedViaContact,
            });
          } else if (sender_id && address) {
            const existing = rows.get(sender_id);
            if (existing && !existing.address) existing.address = address;
          }
          return { rows: [] };
        }
        if (lower.startsWith('update "imessage_wallets"')) {
          const row = lookupRow(params);
          if (row) {
            if (lower.includes("provisioned_via_contact")) {
              row.provisioned_via_contact = false;
            }
            const address = params.find(
              (value): value is string =>
                typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value),
            );
            if (address && lower.includes('"address"')) {
              row.address = address;
            }
            const accountName = params.find(
              (value): value is string => typeof value === "string" && value.startsWith("im-"),
            );
            if (accountName && lower.includes('"account_name"')) {
              row.account_name = accountName;
            }
            const displayName = params.find(
              (value): value is string =>
                typeof value === "string" &&
                !value.startsWith("+") &&
                !value.startsWith("0x") &&
                !value.startsWith("im-") &&
                !/^\d+$/.test(value),
            );
            if (displayName && lower.includes("display_name")) {
              row.display_name = displayName;
            }
          }
          return { rows: [] };
        }
        return { rows: [] };
      },
    },
  };
});

vi.mock("@/wallet/cdp.js", () => ({
  // Deterministic per account name, mirroring CDP's idempotent getOrCreateAccount.
  // Produces a well-formed 0x address so it passes the adapter's format check.
  getOrCreateUserWallet: vi.fn(async (accountName: string) => {
    const { createHash } = await import("node:crypto");
    return { address: `0x${createHash("sha256").update(accountName).digest("hex").slice(0, 40)}` };
  }),
}));

import * as dbModule from "@/discovery/db.js";

import { WalletAdapter } from "./wallet.adapter.js";

const rows = (dbModule as unknown as { __rows: Map<string, WalletRow> }).__rows;

describe("WalletAdapter recipient wallet reuse", () => {
  beforeEach(() => {
    rows.clear();
  });

  it("reuses a contact-funded wallet on the recipient's first text and welcomes them once", async () => {
    const handle = "+639171234567";

    // Someone sends funds to this number before the recipient ever texts.
    const provisioned = await WalletAdapter.getOrCreateForHandle(handle);
    expect(rows.get(handle)?.provisioned_via_contact).toBe(true);
    expect(rows.get(handle)?.address).toBe(provisioned.address);

    // Recipient texts for the first time: same wallet (funds intact), welcomed.
    const first = await WalletAdapter.getOrCreate(handle);
    expect(first.isNew).toBe(true);
    expect(first.address).toBe(provisioned.address);

    // Subsequent texts are not treated as new (flag cleared).
    const second = await WalletAdapter.getOrCreate(handle);
    expect(second.isNew).toBe(false);
    expect(second.address).toBe(provisioned.address);
  });

  it("tops up the recipient's existing wallet when they texted before being funded", async () => {
    const handle = "+14155550000";

    const first = await WalletAdapter.getOrCreate(handle);
    expect(first.isNew).toBe(true);

    // A later contact-send must land on the wallet they already use.
    const funded = await WalletAdapter.getOrCreateForHandle(handle);
    expect(funded.address).toBe(first.address);
  });

  it("provisions a brand-new sender wallet as new without the contact flag", async () => {
    const wallet = await WalletAdapter.getOrCreate("+10000000000");
    expect(wallet.isNew).toBe(true);
    expect(rows.get("+10000000000")?.provisioned_via_contact).toBe(false);
  });

  it("stores and reads a sender-owned display name", async () => {
    const handle = "+15550001111";

    await WalletAdapter.setDisplayName(handle, "Alex");

    expect(await WalletAdapter.getDisplayName(handle)).toBe("Alex");
  });
});
