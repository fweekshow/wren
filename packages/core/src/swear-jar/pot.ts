import type { WalletCall } from "@basemate/shared";

import { CDP_NETWORK, getCdpClient } from "@/wallet/cdp.js";
import { logger } from "@/utils/logger.js";

import { potAccountNameForConversation, potSmartAccountName } from "./constants.js";

export type GroupPot = {
  /** CDP owner EOA account name (`sj-…`). */
  accountName: string;
  /** Smart account address — receives fines and sends refunds/settle (paymaster). */
  address: string;
  ownerAddress: string;
};

/** Create/fetch this group's pot as a CDP smart account (gas sponsored on Base). */
export async function getOrCreateGroupPot(conversationId: string): Promise<GroupPot> {
  const accountName = potAccountNameForConversation(conversationId);
  const cdp = getCdpClient();
  const owner = await cdp.evm.getOrCreateAccount({ name: accountName });
  const smart = await cdp.evm.getOrCreateSmartAccount({
    name: potSmartAccountName(accountName),
    owner,
  });
  logger.info(
    { conversationId, accountName, pot: smart.address },
    "[swear-jar] group pot ready",
  );
  return {
    accountName,
    address: smart.address,
    ownerAddress: owner.address,
  };
}

/** Send calls from the group pot smart account (Portal paymaster on Base — no ETH). */
export async function sendFromGroupPot(args: {
  conversationId: string;
  calls: WalletCall[];
}): Promise<{ txHash: string }> {
  if (args.calls.length === 0) throw new Error("no calls to send from group pot");

  const accountName = potAccountNameForConversation(args.conversationId);
  const cdp = getCdpClient();
  const owner = await cdp.evm.getOrCreateAccount({ name: accountName });
  const smartAccount = await cdp.evm.getOrCreateSmartAccount({
    name: potSmartAccountName(accountName),
    owner,
  });

  const userOpCalls = args.calls.map((call) => {
    if (!call.to) throw new Error("call is missing a destination address");
    return {
      to: call.to as `0x${string}`,
      data: (call.data ?? "0x") as `0x${string}`,
      value: call.value ? BigInt(call.value) : 0n,
    };
  });

  // Same pattern as strategy paymaster: on Base, CDP sponsors via project paymaster.
  const userOp = await cdp.evm.sendUserOperation({
    smartAccount,
    network: CDP_NETWORK,
    calls: userOpCalls,
  });

  const receipt = await cdp.evm.waitForUserOperation({
    smartAccountAddress: smartAccount.address,
    userOpHash: userOp.userOpHash,
  });

  if (receipt.status !== "complete") {
    throw new Error(`swear-jar pot user operation ${receipt.status}`);
  }
  if (!("transactionHash" in receipt) || !receipt.transactionHash) {
    throw new Error("swear-jar pot user operation completed without a transaction hash");
  }

  return { txHash: receipt.transactionHash };
}
