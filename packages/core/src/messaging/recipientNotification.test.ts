import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findByPhone: vi.fn(),
  getDisplayName: vi.fn(),
  getReceiveAddress: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock("./contacts.adapter.js", () => ({
  ContactsAdapter: {
    normalizeHandle: (value: string | null | undefined) => {
      if (!value) return null;
      const cleaned = value.replace(/[^\d+]/g, "");
      return /^\+\d{7,15}$/.test(cleaned) ? cleaned : null;
    },
    findByPhone: mocks.findByPhone,
  },
}));

vi.mock("@/discovery/adapters/wallet.adapter.js", () => ({
  WalletAdapter: {
    getDisplayName: mocks.getDisplayName,
    getReceiveAddress: mocks.getReceiveAddress,
  },
}));

vi.mock("@/wallet/walletSetupSession.js", () => ({
  WalletSetupSessionAdapter: { create: mocks.createSession },
  CLAIM_SESSION_TTL_MS: 604800000,
}));

vi.mock("@/config/config.js", () => ({
  config: {
    payPage: { origin: "https://app.basemate.app" },
    phoneEscrow: { claimTtlHours: 72 },
  },
}));

import type { TxConfirmationRow } from "@/discovery/adapters/txConfirmation.adapter.js";

import {
  buildDeferredRecipientClaimNotification,
  buildRecipientTransferNotification,
} from "./recipientNotification.js";

function row(over: Partial<TxConfirmationRow> = {}): TxConfirmationRow {
  return {
    sid: "sid1",
    sender_id: "+15550001111",
    from_address: "0xabc",
    chain_id: "0x2105",
    label: "send 10 USDC",
    status: "submitted",
    tx_hash: `0x${"1".repeat(64)}`,
    mcp_request_id: "req1",
    approval_url: null,
    recipient_phone: "+15550002222",
    transfer_amount: "10",
    transfer_asset: "usdc",
    transfer_memo: null,
    recipient_notification_status: "pending",
    recipient_notification_attempts: 0,
    recipient_notification_next_attempt_at: new Date(),
    recipient_notification_last_error: null,
    recipient_notification_accepted_at: null,
    created_at: new Date(),
    submitted_at: new Date(),
    resolved_at: null,
    expires_at: new Date(Date.now() + 60_000),
    ...over,
  };
}

describe("recipient transfer notifications", () => {
  beforeEach(() => {
    mocks.findByPhone.mockReset();
    mocks.getDisplayName.mockReset();
    mocks.getReceiveAddress.mockReset();
    mocks.createSession.mockReset();
    mocks.createSession.mockResolvedValue("claim-token");
    // Default: recipient already has an embedded wallet, so no claim link is appended.
    mocks.getReceiveAddress.mockResolvedValue("0xrecipient");
  });

  it("prefers the recipient's saved contact name", async () => {
    mocks.findByPhone.mockResolvedValue({ name: "Bestie" });
    mocks.getDisplayName.mockResolvedValue("Alex");

    await expect(buildRecipientTransferNotification(row())).resolves.toEqual({
      phone: "+15550002222",
      message: "Bestie sent you 10 USDC.",
      requiresClaim: false,
    });
    expect(mocks.getDisplayName).not.toHaveBeenCalled();
  });

  it("uses the sender-owned display name before falling back to phone", async () => {
    mocks.findByPhone.mockResolvedValue(null);
    mocks.getDisplayName.mockResolvedValueOnce("Alex").mockResolvedValueOnce(null);

    expect((await buildRecipientTransferNotification(row()))?.message).toBe(
      "Alex sent you 10 USDC.",
    );
    expect((await buildRecipientTransferNotification(row()))?.message).toBe(
      "+15550001111 sent you 10 USDC.",
    );
  });

  it("includes the sender's optional transfer message", async () => {
    mocks.findByPhone.mockResolvedValue({ name: "Mateo" });

    expect(
      (await buildRecipientTransferNotification(
        row({ transfer_amount: "0.01", transfer_memo: "Thank you for the pizza" }),
      ))?.message,
    ).toBe(
      "Mateo sent you 0.01 USDC.\n\n\"Thank you for the pizza\"",
    );
  });

  it("includes a claim link when the recipient has no embedded wallet", async () => {
    mocks.findByPhone.mockResolvedValue({ name: "Bestie" });
    mocks.getReceiveAddress.mockResolvedValue(null);

    await expect(buildRecipientTransferNotification(row())).resolves.toEqual({
      phone: "+15550002222",
      message:
        "Bestie sent you 10 USDC.\n\n" +
        "wren://g/sid1?s=claim-token\n\n" +
        "Open it within 72 hours or it goes back.",
      requiresClaim: true,
    });
    expect(mocks.createSession).toHaveBeenCalledWith("+15550002222", 604800000);
  });

  it("omits the claim link when the recipient already has an embedded wallet", async () => {
    mocks.findByPhone.mockResolvedValue({ name: "Bestie" });
    mocks.getReceiveAddress.mockResolvedValue("0xexisting");

    const result = await buildRecipientTransferNotification(row());
    expect(result?.message).toBe("Bestie sent you 10 USDC.");
    expect(result?.message).not.toContain("claim your funds");
    expect(result?.requiresClaim).toBe(false);
  });

  it("renders a bundle summary held entirely in amount (empty asset)", async () => {
    mocks.findByPhone.mockResolvedValue({ name: "Bestie" });

    const result = await buildRecipientTransferNotification(
      row({ transfer_amount: "5 USDC + 10 ETH", transfer_asset: "" }),
    );
    expect(result?.message).toBe("Bestie sent you 5 USDC + 10 ETH.");
  });

  it("returns null when there is no amount", async () => {
    const result = await buildRecipientTransferNotification(row({ transfer_amount: null }));
    expect(result).toBeNull();
  });

  it("creates one fresh link with a combined summary after the recipient replies", async () => {
    mocks.getReceiveAddress.mockResolvedValue(null);

    await expect(
      buildDeferredRecipientClaimNotification("+15550002222", [
        row({ sid: "sid1", transfer_amount: "10", transfer_asset: "USDC" }),
        row({ sid: "sid2", transfer_amount: "0.5", transfer_asset: "eth" }),
      ]),
    ).resolves.toEqual({
      phone: "+15550002222",
      message:
        "10 USDC + 0.5 ETH is ready.\n\n" +
        "wren://g/sid1?s=claim-token\n\n" +
        "Open it within 72 hours or it goes back.",
    });
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledWith("+15550002222", 604800000);
  });

  it("does not create a deferred link if the recipient completed setup elsewhere", async () => {
    mocks.getReceiveAddress.mockResolvedValue("0xexisting");

    await expect(
      buildDeferredRecipientClaimNotification("+15550002222", [row()]),
    ).resolves.toBeNull();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
