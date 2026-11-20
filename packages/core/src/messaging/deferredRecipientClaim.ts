import {
  TxConfirmationAdapter,
  type TxConfirmationRow,
} from "@/discovery/adapters/txConfirmation.adapter.js";

import { ContactsAdapter } from "./contacts.adapter.js";
import { buildDeferredRecipientClaimNotification } from "./recipientNotification.js";

export type DeferredRecipientClaimResult = "none" | "sent" | "already_setup";

export interface DeferredRecipientClaimDeps {
  claimPending: (phone: string) => Promise<TxConfirmationRow[]>;
  buildNotification: (
    phone: string,
    rows: TxConfirmationRow[],
  ) => Promise<{ phone: string; message: string } | null>;
  markSent: (sids: string[]) => Promise<number>;
  release: (sids: string[]) => Promise<number>;
  /** When false, leave the claim pending and send nothing. */
  mayDeliver?: (phone: string) => Promise<boolean>;
}

function defaultDeps(): DeferredRecipientClaimDeps {
  return {
    claimPending: (phone) => TxConfirmationAdapter.claimPendingRecipientClaims(phone),
    buildNotification: buildDeferredRecipientClaimNotification,
    markSent: (sids) => TxConfirmationAdapter.markRecipientClaimsSent(sids),
    release: (sids) => TxConfirmationAdapter.releaseRecipientClaims(sids),
    mayDeliver: async (phone) => {
      const { recipientTransferAllowed } = await import("./smsConsentGate.js");
      return recipientTransferAllowed(phone);
    },
  };
}

/**
 * Delivers one fresh setup link for every transfer queued for this recipient.
 * The caller supplies the transport so iMessage can always keep the URL in a
 * private DM, even when the qualifying inbound message came from a group.
 */
export async function deliverDeferredRecipientClaim(
  senderId: string,
  deliver: (phone: string, message: string) => Promise<boolean>,
  deps: DeferredRecipientClaimDeps = defaultDeps(),
): Promise<DeferredRecipientClaimResult> {
  const phone = ContactsAdapter.normalizeHandle(senderId);
  if (!phone) return "none";
  if (deps.mayDeliver && !(await deps.mayDeliver(phone))) return "none";

  const rows = await deps.claimPending(phone);
  if (rows.length === 0) return "none";
  const sids = rows.map((row) => row.sid);

  try {
    const notification = await deps.buildNotification(phone, rows);
    if (!notification) {
      await deps.markSent(sids);
      return "already_setup";
    }

    const delivered = await deliver(notification.phone, notification.message);
    if (!delivered) throw new Error("deferred recipient claim delivery returned false");
    await deps.markSent(sids);
    return "sent";
  } catch (error) {
    await deps.release(sids);
    throw error;
  }
}
