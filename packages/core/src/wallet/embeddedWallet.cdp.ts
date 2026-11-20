import { CdpClient } from "@coinbase/cdp-sdk";
import type { WalletCall } from "@basemate/shared";
import { encodeAbiParameters, encodePacked, hashTypedData, sliceHex, type Hex } from "viem";

import { config } from "@/config/config.js";
import { logger } from "@/utils/logger.js";

/**
 * Delegated signing for Basemate CDP embedded wallets. After a user grants a
 * delegation on basemate.app, the backend signs on their behalf here using the
 * CDP API key + Wallet Secret — no user interaction, no keys.coinbase.
 *
 * Embedded wallets are provisioned as smart accounts, so transactions run as
 * user operations with `useCdpPaymaster: true` (gas sponsored via the CDP
 * paymaster config), and settle on Base.
 */

let client: CdpClient | null = null;
function cdp(): CdpClient {
  if (!client) {
    client = new CdpClient({
      apiKeyId: config.cdp.apiKeyId,
      apiKeySecret: config.cdp.apiKeySecret,
      walletSecret: config.cdp.walletSecret,
    });
  }
  return client;
}

export class EmbeddedWalletError extends Error {
  /** True when the failure is a lapsed/absent delegation and the user must re-auth. */
  readonly needsReauth: boolean;
  constructor(message: string, needsReauth = false) {
    super(message);
    this.name = "EmbeddedWalletError";
    this.needsReauth = needsReauth;
  }
}

const REAUTH_MARKERS = [
  "delegation_not_found",
  "delegation_expired",
  "delegation_revoked",
  "no active delegation",
  "no delegation",
  "unauthorized",
  "not authorized",
  "invalid delegation",
];

/**
 * Markers for paymaster gas-sponsorship failures — the paymaster policy did not
 * cover this transaction (e.g. arbitrary ERC-20 not whitelisted) and the
 * wallet's own EntryPoint deposit is too low to self-fund.
 */
const GAS_SPONSORSHIP_MARKERS = [
  "insufficient balance to perform useroperation",
  "precheck failed: sender balance and deposit",
  "sender balance and deposit together",
  "paymaster deposit too low",
  "paymaster does not have enough",
  "aa21 didn't pay prefund",
];

function isGasSponsorshipError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return GAS_SPONSORSHIP_MARKERS.some((m) => msg.includes(m));
}

function isDelegationError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return REAUTH_MARKERS.some((m) => msg.includes(m));
}

function isMissingDelegationError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status?: unknown }).status)
      : undefined;
  return status === 404 || message.includes("delegation_not_found") || message.includes("no active delegation");
}

/** WalletCall (hex value) -> CDP EvmCall (decimal wei value). */
function toEvmCall(call: WalletCall): { to: string; value: string; data: string } {
  if (!call.to) throw new EmbeddedWalletError("Cannot execute a call without a destination address.");
  return {
    to: call.to,
    value: BigInt(call.value ?? "0x0").toString(),
    data: call.data ?? "0x",
  };
}

export interface EmbeddedSendResult {
  /** Smart-account user operation hash (embedded wallets are smart accounts). */
  userOpHash?: string;
  /** Final on-chain transaction hash. Present only after successful inclusion. */
  txHash: string;
  status?: string;
}

/** EIP-712 payload shape accepted by CDP endUser.signEvmTypedData. */
export type EmbeddedTypedData = {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

export interface EmbeddedSignTypedDataResult {
  signature: `0x${string}`;
}

export class EmbeddedWalletAdapter {
  /**
   * Return an existing user-scoped delegation after confirming that the smart
   * account belongs to the CDP end user. Delegated signing only needs the active
   * grant; CDP does not return its ID from the lookup endpoint.
   */
  static async getReusableDelegation(
    userId: string,
    address: string,
  ): Promise<{ expiresAt: string } | null> {
    const normalizedAddress = address.toLowerCase();
    const user = await cdp().endUser.getEndUser({ userId });
    const ownsSmartAccount = user.evmSmartAccountObjects.some(
      (account) => account.address.toLowerCase() === normalizedAddress,
    );
    if (!ownsSmartAccount) {
      throw new EmbeddedWalletError("This smart account does not belong to the signed-in CDP user.");
    }

    try {
      const delegation = await cdp().endUser.getDelegationForEndUser({ userId });
      if (!delegation?.expiresAt || new Date(delegation.expiresAt) <= new Date()) return null;
      return { expiresAt: delegation.expiresAt };
    } catch (err) {
      if (isMissingDelegationError(err)) return null;
      throw err;
    }
  }

  /** True when the embedded account has an active (non-expired) delegation. */
  static async hasActiveDelegation(userId: string, address: string): Promise<boolean> {
    try {
      const delegation = await cdp().endUser.getDelegationForEndUserAccount({ userId, address });
      return Boolean(delegation?.expiresAt) && new Date(delegation.expiresAt) > new Date();
    } catch {
      return false;
    }
  }

  /**
   * Execute calls on the user's embedded smart account via delegated signing,
   * with gas sponsored by the CDP paymaster. Throws EmbeddedWalletError with
   * `needsReauth` when the delegation has lapsed.
   *
   * `useCdpPaymaster` defaults to true. Pass false for self-funded gas — the
   * smart account pays from its own ETH balance (iStonks launches, which are
   * too gas-heavy to sponsor).
   */
  static async sendCalls(args: {
    userId: string;
    address: string;
    calls: WalletCall[];
    useCdpPaymaster?: boolean;
  }): Promise<EmbeddedSendResult> {
    if (args.calls.length === 0) throw new EmbeddedWalletError("No calls were provided to execute.");
    try {
      const result = (await cdp().endUser.sendUserOperation({
        userId: args.userId,
        address: args.address,
        network: "base",
        calls: args.calls.map(toEvmCall),
        useCdpPaymaster: args.useCdpPaymaster ?? true,
      })) as { userOpHash?: string | null; transactionHash?: string | null; status?: string };

      let txHash = result.transactionHash ?? undefined;
      let status = result.status;
      if (result.userOpHash && (!txHash || status !== "complete")) {
        const receipt = await cdp().evm.waitForUserOperation({
          smartAccountAddress: args.address as `0x${string}`,
          userOpHash: result.userOpHash as `0x${string}`,
        });
        status = receipt.status;
        if (receipt.status !== "complete") {
          throw new EmbeddedWalletError(`Embedded wallet operation ${receipt.status}.`);
        }
        txHash = receipt.transactionHash;
      }
      if (status && status !== "complete") {
        throw new EmbeddedWalletError(`Embedded wallet operation ${status}.`);
      }
      if (!txHash) {
        throw new EmbeddedWalletError("Embedded wallet operation completed without a transaction hash.");
      }

      return {
        userOpHash: result.userOpHash ?? undefined,
        txHash,
        status,
      };
    } catch (err) {
      if (isDelegationError(err)) {
        throw new EmbeddedWalletError(
          "Your Basemate account authorization expired — reconnect to keep sending.",
          true,
        );
      }
      if (isGasSponsorshipError(err)) {
        throw new EmbeddedWalletError(
          "GAS_NOT_SPONSORED: gas sponsorship not available for this token",
          false,
        );
      }
      logger.error({ err }, "[embeddedWallet] sendUserOperation failed");
      throw new EmbeddedWalletError(
        err instanceof Error ? err.message : "Embedded wallet transaction failed.",
      );
    }
  }

  /**
   * Sign EIP-712 typed data for an embedded smart account via delegated signing.
   *
   * Coinbase Smart Wallets require a replay-safe hash + SignatureWrapper for
   * EIP-1271 validation (same as CDP `signAndWrapTypedDataForSmartAccount`).
   * We sign the replay-safe payload with the smart account's owner EOA under
   * the end-user delegation, then wrap for the contract.
   */
  static async signTypedData(args: {
    userId: string;
    address: string;
    typedData: EmbeddedTypedData;
    /** Chain id for Coinbase Smart Wallet replay-safe wrapping. Default Base. */
    chainId?: number;
  }): Promise<EmbeddedSignTypedDataResult> {
    try {
      const chainId = args.chainId ?? 8453;
      const user = await cdp().endUser.getEndUser({ userId: args.userId });
      const smart = user.evmSmartAccountObjects.find(
        (a) => a.address.toLowerCase() === args.address.toLowerCase(),
      );
      if (!smart) {
        throw new EmbeddedWalletError("This smart account does not belong to the signed-in CDP user.");
      }
      const ownerAddress = smart.ownerAddresses?.[0];
      if (!ownerAddress) {
        throw new EmbeddedWalletError("Smart account has no owner address to sign with.");
      }

      const typedForHash = toViemTypedData(args.typedData);
      const replaySafe = createReplaySafeTypedData({
        typedData: typedForHash,
        chainId: BigInt(chainId),
        smartAccountAddress: args.address as Hex,
      });

      const result = await cdp().endUser.signEvmTypedData({
        userId: args.userId,
        address: ownerAddress,
        typedData: replaySafe as Parameters<
          ReturnType<typeof cdp>["endUser"]["signEvmTypedData"]
        >[0]["typedData"],
      });
      const rawSig = result.signature as Hex;
      if (!rawSig?.startsWith("0x")) {
        throw new EmbeddedWalletError("Typed-data signature was empty.");
      }

      const signature = createSmartAccountSignatureWrapper({
        signatureHex: rawSig,
        ownerIndex: 0n,
      });
      return { signature };
    } catch (err) {
      if (err instanceof EmbeddedWalletError) throw err;
      if (isDelegationError(err)) {
        throw new EmbeddedWalletError(
          "Your Basemate account authorization expired — reconnect to keep trading.",
          true,
        );
      }
      logger.error({ err }, "[embeddedWallet] signEvmTypedData failed");
      throw new EmbeddedWalletError(
        err instanceof Error ? err.message : "Embedded wallet typed-data signing failed.",
      );
    }
  }

  /**
   * Sign an EIP-191 personal message via delegated signing (e.g. Flash cancel).
   * Signs with the smart-account owner EOA (EIP-191); callers that need
   * contract-validated message sigs may need additional wrapping.
   */
  static async signMessage(args: {
    userId: string;
    address: string;
    message: string;
  }): Promise<EmbeddedSignTypedDataResult> {
    try {
      const user = await cdp().endUser.getEndUser({ userId: args.userId });
      const smart = user.evmSmartAccountObjects.find(
        (a) => a.address.toLowerCase() === args.address.toLowerCase(),
      );
      const signAddress = smart?.ownerAddresses?.[0] ?? args.address;

      const result = await cdp().endUser.signEvmMessage({
        userId: args.userId,
        address: signAddress,
        message: args.message,
      });
      const signature = result.signature as `0x${string}`;
      if (!signature?.startsWith("0x")) {
        throw new EmbeddedWalletError("Message signature was empty.");
      }
      return { signature };
    } catch (err) {
      if (err instanceof EmbeddedWalletError) throw err;
      if (isDelegationError(err)) {
        throw new EmbeddedWalletError(
          "Your Basemate account authorization expired — reconnect to keep trading.",
          true,
        );
      }
      logger.error({ err }, "[embeddedWallet] signEvmMessage failed");
      throw new EmbeddedWalletError(
        err instanceof Error ? err.message : "Embedded wallet message signing failed.",
      );
    }
  }
}

function toViemTypedData(typedData: EmbeddedTypedData) {
  return {
    domain: typedData.domain as Parameters<typeof hashTypedData>[0]["domain"],
    types: typedData.types as Parameters<typeof hashTypedData>[0]["types"],
    primaryType: typedData.primaryType,
    message: typedData.message as Parameters<typeof hashTypedData>[0]["message"],
  };
}

/** Mirrors CDP createReplaySafeTypedData for Coinbase Smart Wallet EIP-1271. */
function createReplaySafeTypedData(args: {
  typedData: ReturnType<typeof toViemTypedData>;
  chainId: bigint;
  smartAccountAddress: Hex;
}) {
  const originalHash = hashTypedData(args.typedData);
  return {
    domain: {
      name: "Coinbase Smart Wallet",
      version: "1",
      chainId: Number(args.chainId),
      verifyingContract: args.smartAccountAddress,
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      CoinbaseSmartWalletMessage: [{ name: "hash", type: "bytes32" }],
    },
    primaryType: "CoinbaseSmartWalletMessage",
    message: { hash: originalHash },
  };
}

/** Mirrors CDP createSmartAccountSignatureWrapper. */
function createSmartAccountSignatureWrapper(args: {
  signatureHex: Hex;
  ownerIndex: bigint;
}): Hex {
  const r = sliceHex(args.signatureHex, 0, 32);
  const s = sliceHex(args.signatureHex, 32, 64);
  const v = Number(`0x${args.signatureHex.slice(130, 132)}`);
  const signatureData = encodePacked(["bytes32", "bytes32", "uint8"], [r, s, v]);
  return encodeAbiParameters(
    [
      {
        components: [
          { name: "ownerIndex", type: "uint8" },
          { name: "signatureData", type: "bytes" },
        ],
        name: "SignatureWrapper",
        type: "tuple",
      },
    ],
    [{ ownerIndex: Number(args.ownerIndex), signatureData }],
  );
}
