import { config } from "@/config/config.js";
import type { StockGiftRow } from "@/wallet/stockGift.js";

export type MuseSendStatus = "awaiting_payment" | "buying" | "sent" | "failed";

export function formatRecipientLine(name: string | undefined, phone: string): string {
  const label = name?.trim();
  return label ? `${label} (${phone})` : phone;
}

export function giftRecipientLine(recipient?: {
  name?: string;
  phone?: string | null;
  display?: string;
} | null): string | null {
  if (!recipient) return null;
  if (recipient.phone) {
    const display = recipient.display?.trim();
    if (display && display.includes(recipient.phone)) return display;
    const label = recipient.name?.trim() || display;
    const name = label && label !== recipient.phone ? label : undefined;
    return formatRecipientLine(name, recipient.phone);
  }
  return recipient.display?.trim() || null;
}

export function museSendStatus(row: StockGiftRow): MuseSendStatus {
  if (row.giftTxHash) return "sent";
  if (row.giftFailedAt) return "failed";
  if (row.giftStartedAt) return "buying";
  return "awaiting_payment";
}

/** @deprecated use museSendStatus */
export const museGiftStatus = museSendStatus;

export function museAlreadyOnBasemate(recipient?: { kind?: string } | null): boolean {
  return recipient?.kind === "wallet";
}

export function museTrackCopy(input: {
  status: MuseSendStatus | "needs_connect" | "awaiting_payment";
  recipientLine: string;
  amountLabel: string;
  alreadyOnBasemate: boolean;
  claimUrl?: string | null;
}): {
  alreadyOnBasemate: boolean;
  delivery: "wallet" | "claim";
  claimUrl: string | null;
  tellSender: string | null;
  tellReceiver: string | null;
} {
  const delivery = input.alreadyOnBasemate ? "wallet" : "claim";
  const claimUrl = input.alreadyOnBasemate ? null : (input.claimUrl ?? null);
  const who = input.recipientLine || "them";
  if (input.status === "sent") {
    return {
      alreadyOnBasemate: input.alreadyOnBasemate,
      delivery,
      claimUrl,
      tellSender: input.alreadyOnBasemate
        ? `Sent ${input.amountLabel} to ${who}. It's in their Basemate — no claim link.`
        : [
            `Sent ${input.amountLabel} to ${who}.`,
            claimUrl,
            `Basemate texts them over iMessage — forward the claim link above if you want to make sure they get it, else unclaimed funds will be returned to your Basemate account in ${config.phoneEscrow.claimTtlHours} hours.`,
          ]
            .filter(Boolean)
            .join("\n\n"),
      tellReceiver: input.alreadyOnBasemate
        ? `${input.amountLabel} just landed in your Basemate. No claim needed — open Basemate.`
        : `${input.amountLabel} is waiting for you.${claimUrl ? ` Claim: ${claimUrl}` : ""}`,
    };
  }
  if (input.status === "failed") {
    return {
      alreadyOnBasemate: input.alreadyOnBasemate,
      delivery,
      claimUrl: null,
      tellSender: `That send to ${who} didn't go through. Check Basemate or try again.`,
      tellReceiver: null,
    };
  }
  return {
    alreadyOnBasemate: input.alreadyOnBasemate,
    delivery,
    claimUrl: null,
    tellSender: null,
    tellReceiver: null,
  };
}

export function publicMuseSend(row: StockGiftRow) {
  const phone =
    row.intent.recipient && "phone" in row.intent.recipient
      ? (row.intent.recipient.phone ?? "")
      : "";
  const recipientLine = giftRecipientLine(row.intent.recipient);
  const status = museSendStatus(row);
  const amountLabel = row.intent.usd ? `$${row.intent.usd} of ${row.intent.symbol}` : row.intent.symbol;
  const alreadyOnBasemate = museAlreadyOnBasemate(row.intent.recipient);
  const track = museTrackCopy({
    status,
    recipientLine: recipientLine ?? "",
    amountLabel,
    alreadyOnBasemate,
    claimUrl: row.claimUrl,
  });
  return {
    sendId: row.id,
    giftId: row.id,
    status,
    headline: "Stock is ready to send",
    sayThis: recipientLine ? `Stock is ready to send to ${recipientLine}` : "Stock is ready to send",
    payToken: row.fundSessionToken,
    txHash: row.giftTxHash,
    amountLabel,
    recipientDisplay: recipientLine,
    recipientPhone: phone || null,
    recipientLine,
    stockLabel: row.intent.symbol ?? null,
    mustPoll: status === "awaiting_payment" || status === "buying",
    pollEveryMs: 1000,
    pollPath: `/api/muse/sends/${row.id}`,
    ...track,
  };
}

/** @deprecated use publicMuseSend */
export const publicMuseGift = publicMuseSend;
