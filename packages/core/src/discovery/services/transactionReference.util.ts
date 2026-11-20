import type { Address, Hex } from "viem";

export const BASE_NETWORK_ID = "0x2105";

export interface ParsedTransactionReference {
  txHash: Hex;
  /** Signer wallet from Base App metadata. Some clients omit it. */
  fromAddress: Address | null;
  networkId: string;
}

/** Parse Base App transactionReference payloads (object or JSON string). */
export function parseTransactionReference(content: unknown): ParsedTransactionReference | null {
  let parsed: unknown = content;
  if (typeof content === "string") {
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;

  const ref =
    "transactionReference" in parsed
      ? (parsed as { transactionReference: unknown }).transactionReference
      : parsed;
  if (!ref || typeof ref !== "object") return null;

  const { reference, networkId, metadata } = ref as {
    reference?: unknown;
    networkId?: unknown;
    metadata?: { fromAddress?: unknown };
  };

  if (typeof reference !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(reference)) return null;
  if (typeof networkId !== "string") return null;

  const fromAddressRaw = metadata?.fromAddress;
  const fromAddress =
    typeof fromAddressRaw === "string" && /^0x[a-fA-F0-9]{40}$/i.test(fromAddressRaw)
      ? (fromAddressRaw.toLowerCase() as Address)
      : null;

  return {
    txHash: reference as Hex,
    fromAddress,
    networkId,
  };
}
