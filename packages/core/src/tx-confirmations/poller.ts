import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

import {
  TxConfirmationAdapter,
  type TxConfirmationRow,
} from "@/discovery/adapters/txConfirmation.adapter.js";
import { type PollerJobHandle, startPollerJob } from "@/infra/queues/base.js";
import { recipientTransferAllowed } from "@/messaging/smsConsentGate.js";
import { buildRecipientTransferNotification } from "@/messaging/recipientNotification.js";
import { APP_ACTIVITY_HINT, formatReceipt } from "@/messaging/utils/wallet.utils.js";
import { logger } from "@/utils/logger.js";

export type ReceiptOutcome = "success" | "reverted";

export const RECIPIENT_NOTIFICATION_MAX_ATTEMPTS = 5;
const RECIPIENT_NOTIFICATION_BACKOFF_MS = [15_000, 60_000, 5 * 60_000, 15 * 60_000];

export interface TxConfirmationPollerDeps {
  recipientNotificationsEnabled: boolean;
  listActionable: () => Promise<TxConfirmationRow[]>;
  listRecipientNotificationActionable: (now: Date) => Promise<TxConfirmationRow[]>;
  claimRecipientNotification: (sid: string, now: Date) => Promise<TxConfirmationRow | null>;
  markRecipientNotificationAccepted: (sid: string, requiresClaim: boolean) => Promise<boolean>;
  markRecipientNotificationFailed: (
    sid: string,
    error: string,
    nextAttemptAt: Date | null,
  ) => Promise<boolean>;
  /** Resolve a receipt outcome, or null if the tx is not yet mined. */
  getReceipt: (txHash: string) => Promise<ReceiptOutcome | null>;
  markConfirmed: (sid: string) => Promise<boolean>;
  markFailed: (sid: string) => Promise<boolean>;
  expireStale: () => Promise<number>;
  deliver: (row: TxConfirmationRow, message: string) => Promise<boolean>;
  deliverRecipient: (phone: string, message: string) => Promise<boolean>;
  /**
   * False holds the row: do not claim, do not mark accepted, do not count a failure.
   * Used when the destination is on the SMS program and has not replied Y.
   */
  recipientNotificationAllowed: (phone: string) => Promise<boolean>;
  buildRecipientNotification: (
    row: TxConfirmationRow,
  ) => Promise<{ phone: string; message: string; requiresClaim: boolean } | null>;
  buildMessage: (row: TxConfirmationRow, outcome: ReceiptOutcome) => string;
  now: () => Date;
}

export interface TxConfirmationTickResult {
  checked: number;
  confirmed: number;
  failed: number;
  delivered: number;
  recipientDelivered: number;
}

/**
 * Strip the pre-sign / pre-confirm CTA from a stored tx label so a receipt
 * doesn't replay "reply YES to buy" or "sign below".
 */
export function cleanTxLabel(label: string): string {
  const cleaned = label
    .replace(/\s*[—–-]\s*sign\b.*$/i, "")
    .replace(/\s*\bsign (?:below|here|now)\b\s*:?\s*$/i, "")
    .replace(/\s*[—–-]\s*reply\s+yes\b.*$/i, "")
    .replace(/\s*\breply\s+yes\b.*$/i, "")
    .replace(/\s*👇\s*$/u, "")
    .replace(/\s*[:—–-]\s*$/, "")
    .trim();
  return cleaned || label.trim();
}

function parseSwapConfirmLabel(
  label: string,
): { fromQty: string; fromSym: string; usd?: string; toSym: string } | null {
  const m = label.match(
    /^Swap\s+(\d+(?:\.\d+)?)\s+([A-Za-z0-9.]+)(?:\s+\(\$([^)]+)\))?\s*→\s*([A-Za-z0-9.]+)/i,
  );
  if (!m?.[1] || !m[2] || !m[4]) return null;
  const usd = m[3]?.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  return { fromQty: m[1], fromSym: m[2], usd: usd || undefined, toSym: m[4] };
}

/** Chat receipt after a tx lands. No em dashes, no "reply YES" leftover. */
export function formatConfirmedChatTitle(label: string): string {
  const cleaned = cleanTxLabel(label);
  const swap = parseSwapConfirmLabel(cleaned);
  if (swap) {
    if (swap.usd) return `got it. bought ${swap.toSym} for $${swap.usd}.`;
    return `got it. swapped ${swap.fromQty} ${swap.fromSym} for ${swap.toSym}.`;
  }
  const send = cleaned.match(/^Send\s+(.+)$/i);
  if (send?.[1]) return `sent. ${send[1]}.`;
  return `${cleaned}. done.`;
}

/** Default confirmation/failure copy delivered back to the iMessage chat. */
export function buildConfirmationMessage(row: TxConfirmationRow, outcome: ReceiptOutcome): string {
  const raw = row.label?.trim();
  const what = raw ? cleanTxLabel(raw) : "your transaction";
  return outcome === "success"
    ? formatReceipt({ title: formatConfirmedChatTitle(raw ?? what), footer: APP_ACTIVITY_HINT })
    : `${what} didn't go through. nothing moved, try again.`;
}

function defaultDeps(): Omit<TxConfirmationPollerDeps, "deliver" | "deliverRecipient"> {
  const client = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
  });

  return {
    recipientNotificationsEnabled: true,
    listActionable: () => TxConfirmationAdapter.listActionable(),
    listRecipientNotificationActionable: (now) =>
      TxConfirmationAdapter.listRecipientNotificationActionable(50, now),
    claimRecipientNotification: (sid, now) =>
      TxConfirmationAdapter.claimRecipientNotification(sid, now),
    markRecipientNotificationAccepted: (sid, requiresClaim) =>
      TxConfirmationAdapter.markRecipientNotificationAccepted(sid, requiresClaim),
    markRecipientNotificationFailed: (sid, error, nextAttemptAt) =>
      TxConfirmationAdapter.markRecipientNotificationFailed(sid, error, nextAttemptAt),
    getReceipt: async (txHash) => {
      try {
        const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
        return receipt.status === "success" ? "success" : "reverted";
      } catch {
        // Not mined yet (or RPC blip) — leave the row submitted and retry next tick.
        return null;
      }
    },
    markConfirmed: (sid) => TxConfirmationAdapter.markConfirmed(sid),
    markFailed: (sid) => TxConfirmationAdapter.markFailed(sid),
    expireStale: () => TxConfirmationAdapter.expireStale(),
    buildRecipientNotification: buildRecipientTransferNotification,
    buildMessage: buildConfirmationMessage,
    now: () => new Date(),
    recipientNotificationAllowed: (phone) => recipientTransferAllowed(phone),
  };
}

/**
 * Polls transactions a user signed in the `/sign` page and, once the receipt
 * lands on Base, DMs them the outcome in iMessage.
 *
 * The transaction is moved to its terminal state before the sender DM. Recipient
 * notifications have their own durable lifecycle and are retried independently,
 * so a messaging failure can never resubmit or alter the on-chain transaction.
 */
export class TxConfirmationPoller {
  private readonly deps: TxConfirmationPollerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: Partial<TxConfirmationPollerDeps> = {}) {
    const fallbackDeliver: TxConfirmationPollerDeps["deliver"] = async () => {
      logger.warn("⚠️ TxConfirmationPoller has no deliver fn — confirmation dropped");
      return false;
    };
    const fallbackRecipientDeliver: TxConfirmationPollerDeps["deliverRecipient"] = async () => {
      logger.warn(
        "⚠️ TxConfirmationPoller has no recipient deliver fn — recipient notification dropped",
      );
      return false;
    };
    this.deps = {
      ...defaultDeps(),
      deliver: fallbackDeliver,
      deliverRecipient: fallbackRecipientDeliver,
      ...deps,
    };
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    logger.info(`🔔 TxConfirmationPoller started (every ${Math.round(intervalMs / 1000)}s)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async startBullMq(intervalMs = 15_000): Promise<PollerJobHandle> {
    return startPollerJob("tx-confirmation-poller", () => this.tickOnce(), intervalMs);
  }

  /** Guarded wrapper so overlapping intervals don't double-process. */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tickOnce();
    } catch (err) {
      logger.error(`❌ TxConfirmationPoller tick failed: ${(err as Error)?.message || err}`);
    } finally {
      this.running = false;
    }
  }

  /** Run one polling pass. Exposed for tests. */
  async tickOnce(): Promise<TxConfirmationTickResult> {
    await this.deps.expireStale();

    const rows = await this.deps.listActionable();
    const result: TxConfirmationTickResult = {
      checked: rows.length,
      confirmed: 0,
      failed: 0,
      delivered: 0,
      recipientDelivered: 0,
    };

    for (const row of rows) {
      if (!row.tx_hash) continue;

      const outcome = await this.deps.getReceipt(row.tx_hash);
      if (!outcome) continue; // not mined yet

      // Win the terminal transition first so the DM can only fire once.
      const won =
        outcome === "success"
          ? await this.deps.markConfirmed(row.sid)
          : await this.deps.markFailed(row.sid);
      if (!won) continue;

      if (outcome === "success") result.confirmed += 1;
      else result.failed += 1;

      try {
        const ok = await this.deps.deliver(row, this.deps.buildMessage(row, outcome));
        if (ok) result.delivered += 1;
        else logger.warn(`⚠️ TxConfirmation ${row.sid} resolved but delivery returned false`);
      } catch (err) {
        logger.error(
          `❌ TxConfirmation ${row.sid} delivery threw: ${(err as Error)?.message || err}`,
        );
      }
    }

    const notificationRows = this.deps.recipientNotificationsEnabled
      ? await this.deps.listRecipientNotificationActionable(this.deps.now())
      : [];
    for (const candidate of notificationRows) {
      const destination = candidate.recipient_phone?.trim();
      if (destination && !(await this.deps.recipientNotificationAllowed(destination))) {
        // Leave recipient_notification_status pending. Claiming would increment
        // attempts, and deliverRecipient false is counted as a failed attempt.
        logger.info(
          `📨 holding recipient notification for ${candidate.sid} → ${destination} until SMS opt-in`,
        );
        continue;
      }

      const claimed = await this.deps.claimRecipientNotification(candidate.sid, this.deps.now());
      if (!claimed) continue;

      try {
        const notification = await this.deps.buildRecipientNotification(claimed);
        if (!notification) throw new Error("recipient notification metadata is incomplete");

        logger.info(
          `📨 sending recipient invite for ${claimed.sid} → ${notification.phone} ` +
            `(${claimed.transfer_amount ?? "?"} ${claimed.transfer_asset ?? ""}, ` +
            `attempt ${claimed.recipient_notification_attempts})`,
        );
        const ok = await this.deps.deliverRecipient(notification.phone, notification.message);
        if (!ok) throw new Error("recipient delivery returned false");

        const accepted = await this.deps.markRecipientNotificationAccepted(
          claimed.sid,
          notification.requiresClaim,
        );
        if (accepted) {
          result.recipientDelivered += 1;
          logger.info(
            `📨 recipient invite accepted by provider for ${claimed.sid} → ${notification.phone}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const attempts = claimed.recipient_notification_attempts;
        const exhausted = attempts >= RECIPIENT_NOTIFICATION_MAX_ATTEMPTS;
        const backoffMs =
          RECIPIENT_NOTIFICATION_BACKOFF_MS[
            Math.min(Math.max(attempts - 1, 0), RECIPIENT_NOTIFICATION_BACKOFF_MS.length - 1)
          ]!;
        const nextAttemptAt = exhausted ? null : new Date(this.deps.now().getTime() + backoffMs);
        await this.deps.markRecipientNotificationFailed(claimed.sid, message, nextAttemptAt);
        logger.warn(
          `⚠️ TxConfirmation ${claimed.sid} recipient delivery failed ` +
            `(attempt ${attempts}/${RECIPIENT_NOTIFICATION_MAX_ATTEMPTS}` +
            `${nextAttemptAt ? `, retry at ${nextAttemptAt.toISOString()}` : ", exhausted"}): ` +
            message,
        );
      }
    }

    return result;
  }
}
