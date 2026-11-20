import type { WalletCall } from "@basemate/shared";

import { logger } from "@/utils/logger.js";

import {
  EmbeddedWalletError,
  type EmbeddedSendResult,
  type EmbeddedSignTypedDataResult,
  type EmbeddedTypedData,
} from "./embeddedWallet.cdp.js";

const CHAIN = "eip155:8453";

function privyAuth(): { appId: string; secret: string } {
  const appId = process.env.PRIVY_APP_ID?.trim() || "";
  const secret = process.env.PRIVY_APP_SECRET?.trim() || "";
  if (!appId || !secret) {
    throw new EmbeddedWalletError("Payments are not ready yet.");
  }
  return { appId, secret };
}

async function privyFetch(path: string, init?: RequestInit): Promise<unknown> {
  const { appId, secret } = privyAuth();
  const res = await fetch(`https://api.privy.io${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString("base64")}`,
      "privy-app-id": appId,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const message =
      body && typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : `Signing failed (${res.status}).`;
    const needsReauth = res.status === 401 || res.status === 403;
    throw new EmbeddedWalletError(message, needsReauth);
  }
  return body;
}

async function resolveWalletId(userId: string, address: string): Promise<string> {
  if (userId.startsWith("0x") || /^[a-z0-9]{10,}$/i.test(userId) && !userId.startsWith("did:")) {
    return userId;
  }
  const user = (await privyFetch(`/v1/users/${encodeURIComponent(userId)}`)) as {
    linked_accounts?: Array<{ type?: string; address?: string; id?: string; wallet_id?: string }>;
  };
  const wanted = address.toLowerCase();
  const match = (user.linked_accounts ?? []).find(
    (account) => account.address?.toLowerCase() === wanted,
  );
  const walletId = match?.wallet_id || match?.id;
  if (!walletId) throw new EmbeddedWalletError("Could not find an account to send from.", true);
  return walletId;
}

/**
 * Server-side signer for Privy embedded accounts. Method names match the CDP
 * adapter so stock sends keep calling EmbeddedWalletAdapter.
 */
export class EmbeddedWalletAdapter {
  static async getReusableDelegation(
    _userId: string,
    _address: string,
  ): Promise<{ expiresAt: string } | null> {
    return { expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() };
  }

  static async hasActiveDelegation(_userId: string, _address: string): Promise<boolean> {
    return true;
  }

  static async sendCalls(args: {
    userId: string;
    address: string;
    calls: WalletCall[];
    useCdpPaymaster?: boolean;
  }): Promise<EmbeddedSendResult> {
    if (args.calls.length === 0) throw new EmbeddedWalletError("Nothing to send.");
    const walletId = await resolveWalletId(args.userId, args.address);
    let txHash = "";
    let userOpHash: string | undefined;
    for (const call of args.calls) {
      const body = await privyFetch(`/v1/wallets/${encodeURIComponent(walletId)}/rpc`, {
        method: "POST",
        body: JSON.stringify({
          method: "eth_sendTransaction",
          caip2: CHAIN,
          sponsor: args.useCdpPaymaster !== false,
          params: {
            transaction: {
              to: call.to,
              data: call.data ?? "0x",
              value: call.value ? `0x${BigInt(call.value).toString(16)}` : "0x0",
            },
          },
        }),
      });
      const record = body as { data?: { hash?: string; transaction_hash?: string; user_operation_hash?: string } };
      txHash = record.data?.hash || record.data?.transaction_hash || txHash;
      userOpHash = record.data?.user_operation_hash || userOpHash;
    }
    if (!txHash) {
      logger.error("[privySigner] send returned no transaction hash");
      throw new EmbeddedWalletError("The send did not finish.");
    }
    return { txHash, userOpHash, status: "complete" };
  }

  static async signTypedData(args: {
    userId: string;
    address: string;
    typedData: EmbeddedTypedData;
    chainId?: number;
  }): Promise<EmbeddedSignTypedDataResult> {
    const walletId = await resolveWalletId(args.userId, args.address);
    const body = await privyFetch(`/v1/wallets/${encodeURIComponent(walletId)}/rpc`, {
      method: "POST",
      body: JSON.stringify({
        method: "eth_signTypedData_v4",
        caip2: CHAIN,
        params: {
          typed_data: {
            domain: args.typedData.domain,
            types: args.typedData.types,
            primary_type: args.typedData.primaryType,
            message: args.typedData.message,
          },
        },
      }),
    });
    const signature = (body as { data?: { signature?: `0x${string}` } }).data?.signature;
    if (!signature?.startsWith("0x")) throw new EmbeddedWalletError("Could not sign.");
    return { signature };
  }

  static async signMessage(args: {
    userId: string;
    address: string;
    message: string;
  }): Promise<EmbeddedSignTypedDataResult> {
    const walletId = await resolveWalletId(args.userId, args.address);
    const body = await privyFetch(`/v1/wallets/${encodeURIComponent(walletId)}/rpc`, {
      method: "POST",
      body: JSON.stringify({
        method: "personal_sign",
        caip2: CHAIN,
        params: { message: args.message },
      }),
    });
    const signature = (body as { data?: { signature?: `0x${string}` } }).data?.signature;
    if (!signature?.startsWith("0x")) throw new EmbeddedWalletError("Could not sign.");
    return { signature };
  }
}
