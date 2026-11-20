import type { WalletCall } from "@basemate/shared";

import { config } from "@/config/config.js";
import { logger } from "@/utils/logger.js";
import { EmbeddedWalletAdapter } from "@/wallet/embeddedWallet.js";

import { flashGetOrder, flashSubmitOrder, FlashApiError } from "./client.js";
import type { FlashEvmTx, FlashOrderDetail, FlashPreparedOrder } from "./types.js";

export class FlashPlaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlashPlaceError";
  }
}

export type PlaceFlashOrderArgs = {
  cdpUserId: string;
  prepared: FlashPreparedOrder;
};

export type PlaceFlashOrderResult = {
  orderId: string;
  approveTxHash?: string;
  detail?: FlashOrderDetail;
};

function approveCallFromTx(tx: FlashEvmTx): WalletCall {
  if (!tx.to || !tx.data) {
    throw new FlashPlaceError("Flash returned an incomplete approve transaction.");
  }
  return {
    to: tx.to as `0x${string}`,
    data: tx.data as `0x${string}`,
    value: "0x0",
  };
}

/**
 * CDP signEvmTypedData requires domain.chainId as an integer, but Flash returns
 * it as a decimal string (e.g. "8453"). Large uint256 message fields stay strings.
 */
function normalizeTypedDataForCdp(typedData: {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}): typeof typedData {
  const domain = { ...typedData.domain };
  if (typeof domain.chainId === "string" && /^\d+$/.test(domain.chainId)) {
    domain.chainId = Number(domain.chainId);
  }
  return { ...typedData, domain };
}

function parseOrderTypedData(raw: string): {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FlashPlaceError("Flash order typed data was not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new FlashPlaceError("Flash order typed data was empty.");
  }
  const obj = parsed as Record<string, unknown>;
  if (
    !obj.domain ||
    !obj.types ||
    typeof obj.primaryType !== "string" ||
    !obj.message ||
    typeof obj.message !== "object"
  ) {
    throw new FlashPlaceError("Flash order typed data is missing EIP-712 fields.");
  }
  return normalizeTypedDataForCdp({
    domain: obj.domain as Record<string, unknown>,
    types: obj.types as Record<string, Array<{ name: string; type: string }>>,
    primaryType: obj.primaryType,
    message: obj.message as Record<string, unknown>,
  });
}

/**
 * Place a Flash order from a prepared quote snapshot (Definitive EVM flow):
 * 1) optional approveTx (ERC-20 → Flash settlement, or Permit2)
 * 2) optional Permit2 EIP-712 signature
 * 3) order EIP-712 signature
 * 4) POST /order, echoing permit fields when present
 */
export async function placeFlashOrder(args: PlaceFlashOrderArgs): Promise<PlaceFlashOrderResult> {
  const { cdpUserId, prepared } = args;

  if (prepared.funderAddress.toLowerCase() === "") {
    throw new FlashPlaceError("Missing funder address for Flash order.");
  }
  if (!prepared.orderTypedData) {
    throw new FlashPlaceError("Missing Flash order typed data — re-quote with funderAddress.");
  }

  let approveTxHash: string | undefined;
  if (prepared.approveTx) {
    const result = await EmbeddedWalletAdapter.sendCalls({
      userId: cdpUserId,
      address: prepared.funderAddress,
      calls: [approveCallFromTx(prepared.approveTx)],
    });
    approveTxHash = result.txHash;
    logger.info(
      { approveTxHash, funder: prepared.funderAddress, quoteId: prepared.quoteId },
      "[flash] allowance approved",
    );
  }

  let evmPermitSignature: string | undefined;
  if (prepared.permitTypedData) {
    const permitTyped = parseOrderTypedData(prepared.permitTypedData);
    const permit = await EmbeddedWalletAdapter.signTypedData({
      userId: cdpUserId,
      address: prepared.funderAddress,
      typedData: permitTyped,
    });
    evmPermitSignature = permit.signature;
    logger.info(
      { funder: prepared.funderAddress, quoteId: prepared.quoteId },
      "[flash] Permit2 signed",
    );
  }

  const typedData = parseOrderTypedData(prepared.orderTypedData);
  const { signature } = await EmbeddedWalletAdapter.signTypedData({
    userId: cdpUserId,
    address: prepared.funderAddress,
    typedData,
  });

  const feeBps =
    prepared.flashIntegratorFeeBps?.trim() ||
    config.flash.integratorFeeBps.trim() ||
    undefined;
  const attribution = config.flash.attributionCode.trim() || undefined;

  try {
    const { orderId } = await flashSubmitOrder({
      targetChain: "base",
      contraChain: "base",
      targetAsset: prepared.targetAsset,
      contraAsset: prepared.contraAsset,
      side: prepared.side,
      qty: prepared.qty,
      orderType: prepared.orderType,
      funderAddress: prepared.funderAddress,
      quoteId: prepared.quoteId,
      userSignature: signature,
      evmOrderTypedData: prepared.orderTypedData,
      ...(prepared.permitTypedData && evmPermitSignature
        ? {
            evmPermitTypedData: prepared.permitTypedData,
            evmPermitSignature,
          }
        : {}),
      maxSlippage: prepared.maxSlippage,
      limitNotionalPrice: prepared.limitNotionalPrice,
      durationSeconds: prepared.durationSeconds,
      triggers: prepared.triggers,
      flashIntegratorFeeBps: feeBps,
      erc8021AttributionCode: attribution,
    });

    let detail: FlashOrderDetail | undefined;
    try {
      detail = await flashGetOrder({
        orderId,
        funderAddress: prepared.funderAddress,
      });
    } catch (err) {
      logger.warn({ err, orderId }, "[flash] getOrder after submit failed");
    }

    return { orderId, approveTxHash, detail };
  } catch (err) {
    if (err instanceof FlashApiError) {
      throw new FlashPlaceError(`Flash rejected the order: ${err.message}`);
    }
    throw err;
  }
}
