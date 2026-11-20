/**
 * Shared Doppler SDK + viem public client for Base mainnet.
 * Read-only by default — creates are encoded for user wallet_sendCalls.
 *
 * Note: Doppler SDK pins its own viem types; we avoid strict PublicClient
 * coupling to dodge duplicate-viem version friction with @basemate/core.
 */

import { DopplerSDK } from "@whetstone-research/doppler-sdk/evm";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

import { resolveBaseRpcUrl } from "@/chain/base-rpc.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedClient: any = null;
let cachedSdk: DopplerSDK | null = null;

export function getDopplerPublicClient() {
  if (cachedClient) return cachedClient;
  cachedClient = createPublicClient({
    chain: base,
    transport: http(resolveBaseRpcUrl()),
  });
  return cachedClient;
}

export function getDopplerSdk(): DopplerSDK {
  if (cachedSdk) return cachedSdk;
  cachedSdk = new DopplerSDK({
    // Doppler SDK depends on its own viem copy — structural cast is intentional.
    publicClient: getDopplerPublicClient() as never,
    chainId: base.id,
  });
  return cachedSdk;
}

/** Test helper */
export function resetDopplerSdkCache(): void {
  cachedClient = null;
  cachedSdk = null;
}
