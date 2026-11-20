import { describe, expect, it, vi } from "vitest";

vi.mock("./contacts.adapter.js", () => ({
  ContactsAdapter: {
    normalizeHandle: (value: string | null | undefined) =>
      value && /^\+\d{7,15}$/.test(value) ? value : null,
  },
}));

vi.mock("@/discovery/adapters/txConfirmation.adapter.js", () => ({
  TxConfirmationAdapter: {},
}));

vi.mock("@/config/config.js", () => ({
  config: { payPage: { origin: "https://app.basemate.app" } },
}));

import type { TxConfirmationRow } from "@/discovery/adapters/txConfirmation.adapter.js";

import {
  type DeferredRecipientClaimDeps,
  deliverDeferredRecipientClaim,
} from "./deferredRecipientClaim.js";

function row(sid: string): TxConfirmationRow {
  return {
    sid,
    sender_id: "+15550001111",
    from_address: "0xabc",
    chain_id: "0x2105",
    label: null,
    status: "confirmed",
    tx_hash: null,
    mcp_request_id: null,
    approval_url: null,
    recipient_phone: "+15550002222",
    transfer_amount: "10",
    transfer_asset: "USDC",
    recipient_notification_status: "provider_accepted",
    recipient_notification_attempts: 1,
    recipient_notification_next_attempt_at: null,
    recipient_notification_last_error: null,
    recipient_notification_accepted_at: new Date(),
    created_at: new Date(),
    submitted_at: new Date(),
    resolved_at: new Date(),
    expires_at: new Date(Date.now() + 60_000),
  };
}

function deps(overrides: Partial<DeferredRecipientClaimDeps> = {}) {
  return {
    claimPending: vi.fn(async () => [row("sid1"), row("sid2")]),
    buildNotification: vi.fn(async () => ({
      phone: "+15550002222",
      message: "fresh private claim link",
    })),
    markSent: vi.fn(async () => 2),
    release: vi.fn(async () => 2),
    ...overrides,
  } satisfies DeferredRecipientClaimDeps;
}

describe("deliverDeferredRecipientClaim", () => {
  it("delivers one private batch and marks every transfer sent", async () => {
    const testDeps = deps();
    const deliver = vi.fn(async () => true);

    await expect(deliverDeferredRecipientClaim("+15550002222", deliver, testDeps)).resolves.toBe(
      "sent",
    );
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith("+15550002222", "fresh private claim link");
    expect(testDeps.markSent).toHaveBeenCalledWith(["sid1", "sid2"]);
    expect(testDeps.release).not.toHaveBeenCalled();
  });

  it("does not resend after the adapter reports no pending transfers", async () => {
    const testDeps = deps({ claimPending: vi.fn(async () => []) });
    const deliver = vi.fn(async () => true);

    await expect(deliverDeferredRecipientClaim("+15550002222", deliver, testDeps)).resolves.toBe(
      "none",
    );
    expect(deliver).not.toHaveBeenCalled();
    expect(testDeps.markSent).not.toHaveBeenCalled();
  });

  it("closes the batch without a link when setup was completed elsewhere", async () => {
    const testDeps = deps({ buildNotification: vi.fn(async () => null) });
    const deliver = vi.fn(async () => true);

    await expect(deliverDeferredRecipientClaim("+15550002222", deliver, testDeps)).resolves.toBe(
      "already_setup",
    );
    expect(deliver).not.toHaveBeenCalled();
    expect(testDeps.markSent).toHaveBeenCalledWith(["sid1", "sid2"]);
  });

  it("releases the batch for a future inbound message when delivery fails", async () => {
    const testDeps = deps();
    const deliver = vi.fn(async () => false);

    await expect(deliverDeferredRecipientClaim("+15550002222", deliver, testDeps)).rejects.toThrow(
      "delivery returned false",
    );
    expect(testDeps.release).toHaveBeenCalledWith(["sid1", "sid2"]);
    expect(testDeps.markSent).not.toHaveBeenCalled();
  });

  it("does not claim or send when the recipient is not opted in", async () => {
    const testDeps = deps({ mayDeliver: vi.fn(async () => false) });
    const deliver = vi.fn(async () => true);

    await expect(deliverDeferredRecipientClaim("+15550002222", deliver, testDeps)).resolves.toBe(
      "none",
    );
    expect(testDeps.claimPending).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(testDeps.markSent).not.toHaveBeenCalled();
    expect(testDeps.release).not.toHaveBeenCalled();
  });
});
