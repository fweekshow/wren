export type ClaimState = "unclaimed" | "claimed" | "returned" | "sent";

/** Map phone-escrow row status to dashboard claim pill. */
export function claimStateFromEscrowStatus(status: string | null | undefined): ClaimState | null {
  if (!status) return null;
  const s = status.toLowerCase();
  if (s === "released") return "claimed";
  if (s === "refunded" || s === "refunding" || s === "cancelled") return "returned";
  if (s === "deposited" || s === "link_created" || s === "releasing") return "unclaimed";
  return null;
}

export function claimStateForSend(params: {
  recipientPhone: string | null;
  txHash: string | null;
  escrowStatus: string | null | undefined;
}): ClaimState {
  if (!params.recipientPhone) return "sent";
  const fromEscrow = claimStateFromEscrowStatus(params.escrowStatus);
  if (fromEscrow) return fromEscrow;
  if (params.txHash) return "sent";
  return "unclaimed";
}
