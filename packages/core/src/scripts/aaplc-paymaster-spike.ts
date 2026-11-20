/**
 * Live paymaster spike: $2 USDC → AAPLc on Slipstream from a real embedded wallet.
 *
 * Dry-run (default):
 *   bun --env-file ../../apps/basemate-tba/.env src/scripts/aaplc-paymaster-spike.ts
 *
 * Send the userOp:
 *   SPIKE_LIVE=1 SPIKE_SENDER_ID=+1XXXXXXXXXX bun --env-file ../../apps/basemate-tba/.env src/scripts/aaplc-paymaster-spike.ts
 */

import { createPublicClient, formatUnits, http, parseAbi, type Address } from "viem";
import { base } from "viem/chains";

import { resolveBaseRpcUrl } from "@/chain/base-rpc.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { buildB20UsdcSpotBuy } from "@/discovery/stocks/giftStock.service.js";
import { EmbeddedWalletAdapter } from "@/wallet/embeddedWallet.js";

const AAPLC = "0xb200000000000000000000C2e324d24d7eEcd1fb" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

async function main() {
  const senderId = (process.env.SPIKE_SENDER_ID ?? "").trim();
  const usd = (process.env.SPIKE_USD ?? "2").trim();
  const live = process.env.SPIKE_LIVE === "1";
  if (!senderId) {
    throw new Error("Set SPIKE_SENDER_ID to the iMessage sender id (E.164 phone).");
  }

  const embedded = await WalletAdapter.getEmbeddedWallet(senderId);
  if (!embedded) {
    throw new Error(`No embedded wallet for ${senderId}. Connect on app.basemate.app first.`);
  }

  const client = createPublicClient({
    chain: base,
    transport: http(resolveBaseRpcUrl()),
  });
  const [usdcRaw, aaplBefore] = await Promise.all([
    client.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [embedded.address as Address],
    }),
    client.readContract({
      address: AAPLC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [embedded.address as Address],
    }),
  ]);
  const usdcHuman = formatUnits(usdcRaw, 6);
  console.log(`wallet ${embedded.address}`);
  console.log(`USDC ${usdcHuman}  AAPLc ${formatUnits(aaplBefore, 8)}`);

  if (Number(usdcHuman) < Number(usd)) {
    throw new Error(`Need at least $${usd} USDC. Wallet has ${usdcHuman}.`);
  }

  const built = await buildB20UsdcSpotBuy({
    toAddress: AAPLC,
    toSymbol: "AAPLc",
    toDecimals: 8,
    usdcHuman: usd,
    walletAddress: embedded.address,
    amountUsd: usd,
  });
  if (!built) {
    throw new Error("Slipstream quote failed — no AAPLc/USDC pool meta.");
  }

  console.log(built.label);
  console.log(`calls ${built.calls.length}`);
  for (const call of built.calls) {
    console.log(`  ${call.to} ${(call.metadata as { transactionType?: string } | undefined)?.transactionType ?? ""}`);
  }

  if (!live) {
    console.log("dry-run. set SPIKE_LIVE=1 to send the userOp.");
    return;
  }

  const result = await EmbeddedWalletAdapter.sendCalls({
    userId: embedded.cdpUserId,
    address: embedded.address,
    calls: built.calls,
  });
  console.log(`tx ${result.txHash}`);
  console.log(`userOp ${result.userOpHash ?? "(none)"}`);

  const aaplAfter = await client.readContract({
    address: AAPLC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [embedded.address as Address],
  });
  console.log(`AAPLc after ${formatUnits(aaplAfter, 8)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
