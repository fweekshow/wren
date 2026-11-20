import { beforeEach, describe, expect, it, vi } from "vitest";

// The poller imports the adapter, which imports the pg pool — stub it so the
// suite never touches a real database (we override every dep anyway).
vi.mock("@/discovery/db.js", () => ({ db: { connect: vi.fn() } }));
// Stub the logger so we don't pull in config (which requires env at import).
vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/infra/queues/base.js", () => ({
  startPollerJob: vi.fn(),
}));
vi.mock("@/messaging/recipientNotification.js", () => ({
  buildRecipientTransferNotification: vi.fn(),
}));
vi.mock("@/messaging/smsConsentGate.js", () => ({
  recipientTransferAllowed: vi.fn(async () => true),
}));

import type { TxConfirmationRow } from "@/discovery/adapters/txConfirmation.adapter.js";

import {
  buildConfirmationMessage,
  cleanTxLabel,
  type ReceiptOutcome,
  TxConfirmationPoller,
} from "./poller.js";

function row(over: Partial<TxConfirmationRow> = {}): TxConfirmationRow {
  return {
    sid: "sid1",
    sender_id: "+15551234567",
    from_address: "0xabc",
    chain_id: "0x2105",
    label: "buy 0.1 ETH",
    status: "submitted",
    tx_hash: "0x" + "11".repeat(32),
    mcp_request_id: null,
    approval_url: null,
    recipient_phone: null,
    transfer_amount: null,
    transfer_asset: null,
    recipient_notification_status: null,
    recipient_notification_attempts: 0,
    recipient_notification_next_attempt_at: null,
    recipient_notification_last_error: null,
    recipient_notification_accepted_at: null,
    created_at: new Date(),
    submitted_at: new Date(),
    resolved_at: null,
    expires_at: new Date(Date.now() + 3_600_000),
    ...over,
  };
}

describe("cleanTxLabel / buildConfirmationMessage", () => {
  it("strips the pre-sign call-to-action from the label", () => {
    expect(cleanTxLabel("Swap 1 USDC ($1) → BASEMATE on Base — sign below:")).toBe(
      "Swap 1 USDC ($1) → BASEMATE on Base",
    );
    expect(cleanTxLabel("Close ETH long on Avantis 👇")).toBe("Close ETH long on Avantis");
    expect(cleanTxLabel("Send 2 USDC to Sarah")).toBe("Send 2 USDC to Sarah");
    expect(
      cleanTxLabel("Swap 2 USDC ($2) → AAPLc on Aerodrome Slipstream on Base — reply YES to buy."),
    ).toBe("Swap 2 USDC ($2) → AAPLc on Aerodrome Slipstream on Base");
  });

  it("builds a natural confirmation that points to in-app activity, not Basescan", () => {
    const msg = buildConfirmationMessage(
      row({ label: "Swap 1 USDC ($1) → BASEMATE on Base — sign below:" }),
      "success",
    );
    expect(msg).toBe("got it. bought BASEMATE for $1.\n\nview your activity in the app");
    expect(msg).not.toContain("sign below");
    expect(msg).not.toContain("basescan.org");
    expect(msg).not.toContain("—");
  });

  it("does not replay YES prompts on auto-buy receipts", () => {
    const msg = buildConfirmationMessage(
      row({
        label: "Swap 2 USDC ($2) → AAPLc on Aerodrome Slipstream on Base — reply YES to buy.",
      }),
      "success",
    );
    expect(msg).toBe("got it. bought AAPLc for $2.\n\nview your activity in the app");
    expect(msg).not.toContain("YES");
  });
});

function makePoller(opts: {
  rows: TxConfirmationRow[];
  outcome: ReceiptOutcome | null;
  won?: boolean;
  recipientRows?: TxConfirmationRow[];
  recipientClaimWon?: boolean;
  recipientDelivery?: boolean;
  recipientRequiresClaim?: boolean;
  recipientNotificationsEnabled?: boolean;
  recipientNotificationAllowed?: (phone: string) => Promise<boolean>;
}) {
  const deliver = vi.fn(async () => true);
  const deliverRecipient = vi.fn(async () => opts.recipientDelivery ?? true);
  const markConfirmed = vi.fn(async () => opts.won ?? true);
  const markFailed = vi.fn(async () => opts.won ?? true);
  const markRecipientNotificationAccepted = vi.fn(async () => true);
  const markRecipientNotificationFailed = vi.fn(async () => true);
  const expireStale = vi.fn(async () => 0);
  const now = new Date("2026-07-11T12:00:00.000Z");
  const recipientRows = opts.recipientRows ?? [];
  const claimRecipientNotification = vi.fn(async (sid: string) => {
    if (opts.recipientClaimWon === false) return null;
    const candidate = recipientRows.find((item) => item.sid === sid);
    return candidate
      ? row({
          ...candidate,
          recipient_notification_status: "processing",
          recipient_notification_attempts: candidate.recipient_notification_attempts + 1,
        })
      : null;
  });
  const poller = new TxConfirmationPoller({
    recipientNotificationsEnabled: opts.recipientNotificationsEnabled ?? true,
    listActionable: async () => opts.rows,
    listRecipientNotificationActionable: async () => recipientRows,
    claimRecipientNotification,
    markRecipientNotificationAccepted,
    markRecipientNotificationFailed,
    getReceipt: async () => opts.outcome,
    markConfirmed,
    markFailed,
    expireStale,
    deliver,
    deliverRecipient,
    now: () => now,
    buildRecipientNotification: async (confirmation) =>
      confirmation.recipient_phone && confirmation.transfer_amount && confirmation.transfer_asset
        ? {
            phone: confirmation.recipient_phone,
            message: `Alex sent you ${confirmation.transfer_amount} ${confirmation.transfer_asset} with Basemate 🎉`,
            requiresClaim: opts.recipientRequiresClaim ?? false,
          }
        : null,
    ...(opts.recipientNotificationAllowed
      ? { recipientNotificationAllowed: opts.recipientNotificationAllowed }
      : {}),
  });
  return {
    poller,
    deliver,
    deliverRecipient,
    markConfirmed,
    markFailed,
    markRecipientNotificationAccepted,
    markRecipientNotificationFailed,
    claimRecipientNotification,
    expireStale,
    now,
  };
}

describe("TxConfirmationPoller", () => {
  beforeEach(() => vi.clearAllMocks());

  it("confirms a mined tx and delivers once", async () => {
    const { poller, deliver, markConfirmed, markFailed } = makePoller({
      rows: [row()],
      outcome: "success",
    });
    const res = await poller.tickOnce();
    expect(res).toMatchObject({ checked: 1, confirmed: 1, failed: 0, delivered: 1 });
    expect(markConfirmed).toHaveBeenCalledWith("sid1");
    expect(markFailed).not.toHaveBeenCalled();
    expect(deliver.mock.calls[0]?.[1]).toContain("buy 0.1 ETH. done.");
    expect(deliver.mock.calls[0]?.[1]).toContain("view your activity in the app");
    expect(deliver.mock.calls[0]?.[1]).not.toContain("basescan.org");
  });

  it("delivers a failure note for a reverted tx", async () => {
    const { poller, deliver, deliverRecipient, markFailed } = makePoller({
      rows: [
        row({
          recipient_phone: "+15550002222",
          transfer_amount: "10",
          transfer_asset: "USDC",
        }),
      ],
      outcome: "reverted",
    });
    const res = await poller.tickOnce();
    expect(res).toMatchObject({ failed: 1, delivered: 1 });
    expect(markFailed).toHaveBeenCalledWith("sid1");
    expect(deliver.mock.calls[0]?.[1]).toContain("didn't go through");
    expect(deliverRecipient).not.toHaveBeenCalled();
  });

  it("notifies the recipient with amount and asset only after a successful receipt", async () => {
    const confirmed = row({
      status: "confirmed",
      recipient_phone: "+919163504284",
      transfer_amount: "10",
      transfer_asset: "USDC",
      recipient_notification_status: "pending",
      recipient_notification_next_attempt_at: new Date("2026-07-11T11:59:00.000Z"),
    });
    const { poller, deliverRecipient, markRecipientNotificationAccepted } = makePoller({
      rows: [],
      recipientRows: [confirmed],
      outcome: null,
    });

    const res = await poller.tickOnce();

    expect(res.recipientDelivered).toBe(1);
    expect(deliverRecipient).toHaveBeenCalledWith(
      "+919163504284",
      "Alex sent you 10 USDC with Basemate 🎉",
    );
    expect(markRecipientNotificationAccepted).toHaveBeenCalledWith("sid1", false);
  });

  it("queues a deferred claim only after the proactive notice is delivered", async () => {
    const confirmed = row({
      status: "confirmed",
      recipient_phone: "+919163504284",
      transfer_amount: "10",
      transfer_asset: "USDC",
      recipient_notification_status: "pending",
      recipient_notification_next_attempt_at: new Date("2026-07-11T11:59:00.000Z"),
    });
    const { poller, markRecipientNotificationAccepted } = makePoller({
      rows: [],
      recipientRows: [confirmed],
      recipientRequiresClaim: true,
      outcome: null,
    });

    await poller.tickOnce();

    expect(markRecipientNotificationAccepted).toHaveBeenCalledWith("sid1", true);
  });

  it("schedules a bounded retry when recipient delivery is rejected", async () => {
    const candidate = row({
      status: "confirmed",
      recipient_phone: "+919163504284",
      transfer_amount: "10",
      transfer_asset: "USDC",
      recipient_notification_status: "pending",
      recipient_notification_attempts: 0,
      recipient_notification_next_attempt_at: new Date("2026-07-11T11:59:00.000Z"),
    });
    const { poller, markRecipientNotificationFailed, now } = makePoller({
      rows: [],
      recipientRows: [candidate],
      recipientDelivery: false,
      outcome: null,
    });

    await poller.tickOnce();

    expect(markRecipientNotificationFailed).toHaveBeenCalledWith(
      "sid1",
      "recipient delivery returned false",
      new Date(now.getTime() + 15_000),
    );
  });

  it("marks recipient notification failed after the maximum attempt", async () => {
    const candidate = row({
      status: "confirmed",
      recipient_phone: "+919163504284",
      transfer_amount: "10",
      transfer_asset: "USDC",
      recipient_notification_status: "retryable_failed",
      recipient_notification_attempts: 4,
      recipient_notification_next_attempt_at: new Date("2026-07-11T11:59:00.000Z"),
    });
    const { poller, markRecipientNotificationFailed } = makePoller({
      rows: [],
      recipientRows: [candidate],
      recipientDelivery: false,
      outcome: null,
    });

    await poller.tickOnce();

    expect(markRecipientNotificationFailed).toHaveBeenCalledWith(
      "sid1",
      "recipient delivery returned false",
      null,
    );
  });

  it("holds a recipient transfer without claiming or failing when SMS consent is not opted in", async () => {
    const candidate = row({
      status: "confirmed",
      recipient_phone: "+15550002222",
      transfer_amount: "10",
      transfer_asset: "USDC",
      recipient_notification_status: "pending",
      recipient_notification_next_attempt_at: new Date("2026-07-11T11:59:00.000Z"),
    });
    const {
      poller,
      deliverRecipient,
      claimRecipientNotification,
      markRecipientNotificationAccepted,
      markRecipientNotificationFailed,
    } = makePoller({
      rows: [],
      recipientRows: [candidate],
      outcome: null,
      recipientNotificationAllowed: async () => false,
    });

    const res = await poller.tickOnce();

    expect(res.recipientDelivered).toBe(0);
    expect(claimRecipientNotification).not.toHaveBeenCalled();
    expect(deliverRecipient).not.toHaveBeenCalled();
    expect(markRecipientNotificationAccepted).not.toHaveBeenCalled();
    expect(markRecipientNotificationFailed).not.toHaveBeenCalled();
  });

  it("does not deliver when another worker wins the recipient claim", async () => {
    const { poller, deliverRecipient, markRecipientNotificationAccepted } = makePoller({
      rows: [],
      recipientRows: [
        row({
          status: "confirmed",
          recipient_phone: "+15550002222",
          transfer_amount: "10",
          transfer_asset: "USDC",
          recipient_notification_status: "pending",
        }),
      ],
      recipientClaimWon: false,
      outcome: null,
    });

    await poller.tickOnce();

    expect(deliverRecipient).not.toHaveBeenCalled();
    expect(markRecipientNotificationAccepted).not.toHaveBeenCalled();
  });

  it("leaves recipient notifications for the Photon owner when disabled", async () => {
    const { poller, claimRecipientNotification, deliverRecipient } = makePoller({
      rows: [],
      recipientRows: [
        row({
          status: "confirmed",
          recipient_phone: "+919163504284",
          transfer_amount: "10",
          transfer_asset: "USDC",
          recipient_notification_status: "pending",
        }),
      ],
      recipientNotificationsEnabled: false,
      outcome: null,
    });

    await poller.tickOnce();

    expect(claimRecipientNotification).not.toHaveBeenCalled();
    expect(deliverRecipient).not.toHaveBeenCalled();
  });

  it("skips a tx that isn't mined yet", async () => {
    const { poller, deliver, deliverRecipient, markConfirmed } = makePoller({
      rows: [
        row({
          recipient_phone: "+15550002222",
          transfer_amount: "10",
          transfer_asset: "USDC",
        }),
      ],
      outcome: null,
    });
    const res = await poller.tickOnce();
    expect(res).toMatchObject({ confirmed: 0, delivered: 0 });
    expect(markConfirmed).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(deliverRecipient).not.toHaveBeenCalled();
  });

  it("does not deliver when it loses the terminal transition (already resolved)", async () => {
    const { poller, deliver } = makePoller({ rows: [row()], outcome: "success", won: false });
    const res = await poller.tickOnce();
    expect(res).toMatchObject({ confirmed: 0, delivered: 0 });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("expires stale rows each pass", async () => {
    const { poller, expireStale } = makePoller({ rows: [], outcome: null });
    await poller.tickOnce();
    expect(expireStale).toHaveBeenCalledTimes(1);
  });
});
