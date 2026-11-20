import { encodeFunctionData, parseUnits, type Address } from "viem";

import { config } from "@/config/config.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { resolveTokenAsync } from "@/discovery/ai/tokens.js";
import { ContactsAdapter } from "@/messaging/contacts.adapter.js";
import { resolveSendTarget } from "@/messaging/resolveSendTarget.js";
import { stashPendingAutoSaveContact } from "@/messaging/utils/autoSaveContact.utils.js";
import {
  canonicalizeSenderId,
  isPhoneClaimHandle,
} from "@/messaging/utils/senderId.utils.js";
import { defaultSendStable, verifiedStableBySymbol } from "@/portfolio/verifiedStables.js";
import { convKey, stateGet, stateSet } from "@/state/conversationState.store.js";
import { PhoneEscrowAdapter } from "@/wallet/phoneEscrow.js";
import { PendingPayAdapter } from "@/wallet/pendingPay.js";
import type { WalletCall } from "@basemate/shared";

const BASE_CHAIN_ID = "0x2105" as const;
const APP_SEND_TTL_SEC = 24 * 60 * 60;
const MEMO_MAX = 140;
const MIN_SEND_USD = 1;

const ERC20_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

function appSendStateKey(senderId: string, sendId: string): string {
  return convKey("app", senderId, `send:${sendId}`);
}

export type AppSendResolveResult = {
  delivery: "instant" | "claim";
  displayName: string | null;
  phone: string;
};

export async function resolveAppSendPhone(
  senderId: string,
  phoneRaw: string,
): Promise<AppSendResolveResult | { error: string; status: number }> {
  const phone =
    ContactsAdapter.normalizeHandle(phoneRaw) ?? canonicalizeSenderId(phoneRaw.trim());
  if (!phone || !isPhoneClaimHandle(phone)) {
    return { error: "Enter a valid phone number in international format.", status: 400 };
  }
  if (phone === senderId || phone === canonicalizeSenderId(senderId)) {
    return { error: "You can't send to yourself.", status: 400 };
  }
  const target = await resolveSendTarget(senderId, { phone });
  if (target.kind === "wallet") {
    return { delivery: "instant", displayName: target.name ?? null, phone };
  }
  if (target.kind === "claim_phone") {
    return { delivery: "claim", displayName: target.name ?? null, phone };
  }
  return { delivery: "claim", displayName: null, phone };
}

async function readUsdcBalance(
  address: string,
  tokenAddress: string,
  decimals: number,
): Promise<number> {
  const { createPublicClient, http, erc20Abi } = await import("viem");
  const { base } = await import("viem/chains");
  const client = createPublicClient({ chain: base, transport: http() });
  const raw = await client.readContract({
    address: tokenAddress as Address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address as Address],
  });
  return Number(raw) / 10 ** decimals;
}

function buildDirectTransferCalls(
  to: Address,
  tokenAddress: string,
  decimals: number,
  amount: string,
  label: string,
): WalletCall[] {
  const rawAmount = parseUnits(amount, decimals);
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to, rawAmount],
  });
  return [
    {
      to: tokenAddress as Address,
      value: "0x0",
      data,
      metadata: { description: label, transactionType: "transfer" },
    },
  ];
}

export type CreateAppSendInput = {
  senderId: string;
  sendId: string;
  phone: string;
  name: string;
  amount: string;
  asset?: string;
  memo?: string;
};

export type CreateAppSendResult =
  | { ok: true; confirmToken: string; delivery: "instant" | "claim"; recipientPhone: string }
  | { ok: false; status: number; error: string; needsReauth?: boolean; depositAmount?: string };

export async function createAppSendPending(input: CreateAppSendInput): Promise<CreateAppSendResult> {
  const sendId = input.sendId.trim();
  if (!/^[0-9a-f-]{36}$/i.test(sendId)) {
    return { ok: false, status: 400, error: "Missing or invalid sendId." };
  }

  const name = input.name.trim();
  const phoneRaw = input.phone.trim();
  if (!name) return { ok: false, status: 400, error: "A contact name is required." };
  if (!phoneRaw) return { ok: false, status: 400, error: "A phone number is required." };

  const amount = input.amount.trim();
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric < MIN_SEND_USD) {
    return { ok: false, status: 400, error: `Minimum send is $${MIN_SEND_USD}.` };
  }

  const memo = typeof input.memo === "string" ? input.memo.trim() : "";
  if (memo.length > MEMO_MAX) {
    return { ok: false, status: 400, error: `Memo must be ${MEMO_MAX} characters or less.` };
  }

  const asset = (input.asset?.trim() || "USDC").toUpperCase();
  const stable = verifiedStableBySymbol(asset) ?? defaultSendStable();
  if (asset !== "USDC") {
    return { ok: false, status: 400, error: "Only USDC sends from the app are supported right now." };
  }

  const existing = await stateGet<{ confirmToken: string }>(appSendStateKey(input.senderId, sendId));
  if (existing?.confirmToken) {
    const resolved = await resolveAppSendPhone(input.senderId, phoneRaw);
    if ("error" in resolved) {
      return { ok: false, status: resolved.status, error: resolved.error };
    }
    return {
      ok: true,
      confirmToken: existing.confirmToken,
      delivery: resolved.delivery,
      recipientPhone: resolved.phone,
    };
  }

  const resolved = await resolveAppSendPhone(input.senderId, phoneRaw);
  if ("error" in resolved) {
    return { ok: false, status: resolved.status, error: resolved.error };
  }

  const embedded = await WalletAdapter.getEmbeddedWallet(input.senderId);
  if (!embedded?.address || !embedded.cdpUserId) {
    return { ok: false, status: 404, error: "No Basemate Account found for this account." };
  }
  if (embedded.delegationExpiresAt && embedded.delegationExpiresAt.getTime() <= Date.now()) {
    return {
      ok: false,
      status: 409,
      error: "Your Basemate authorization expired — reconnect in Agent Settings.",
      needsReauth: true,
    };
  }

  const token = await resolveTokenAsync(stable.symbol);
  if (!token.resolved || !token.address || token.address === "ETH") {
    return { ok: false, status: 400, error: "Could not resolve USDC on Base." };
  }

  try {
    const balance = await readUsdcBalance(embedded.address, token.address, token.decimals);
    if (balance < numeric) {
      const shortfall = Math.max(0.01, Math.round((numeric - balance) * 100) / 100);
      return {
        ok: false,
        status: 400,
        error: `Not enough USDC — add $${shortfall.toFixed(2)} to send $${amount}.`,
        depositAmount: String(shortfall),
      };
    }
  } catch {
    // Proceed — confirm step will fail cleanly if still underfunded.
  }

  const contactLabel = name;
  let calls: WalletCall[] | null = null;
  let recipientDisplay = resolved.phone;
  let label = "";
  let deliveredAmount = amount;
  let deliveredSymbol = stable.symbol;

  const { resolveCorridorStable } = await import("@/portfolio/corridorRouting.js");
  const { buildCorridorSendCalls } = await import("@/portfolio/corridorSend.js");
  const corridor = resolveCorridorStable(resolved.phone);

  if (resolved.delivery === "claim") {
    if (!config.phoneEscrow.enabled) {
      return { ok: false, status: 503, error: "Phone sends are not available right now." };
    }

    let usedCorridor = false;
    if (corridor?.address) {
      const routed = await buildCorridorSendCalls({
        mode: "escrow",
        usdcAmount: amount,
        localStable: corridor,
        senderAddress: embedded.address,
        phone: resolved.phone,
      });
      if (!routed.fallback) {
        const draft = PhoneEscrowAdapter.buildDepositDraft(resolved.phone, routed.localAmount, {
          address: corridor.address,
          symbol: corridor.symbol,
          decimals: corridor.decimals,
        });
        const intent = await PhoneEscrowAdapter.recordDepositIntent({
          senderId: input.senderId,
          phone: draft.phone,
          phoneHash: draft.phoneHash,
          tokenAddress: draft.tokenAddress,
          tokenSymbol: draft.tokenSymbol,
          tokenDecimals: draft.tokenDecimals,
          amountAtomic: draft.amountAtomic,
          amount: draft.amount,
          sourceId: sendId,
        });
        if (intent === "duplicate") {
          return { ok: false, status: 409, error: "This send was already submitted." };
        }
        calls = routed.calls;
        deliveredAmount = draft.amount;
        deliveredSymbol = draft.tokenSymbol;
        label =
          `Convert ${amount} USDC → ~${routed.quotedLocalAmount} ${draft.tokenSymbol} for ${contactLabel} to claim ` +
          `(${config.phoneEscrow.claimTtlHours}h)` +
          (memo ? ` — ${memo}` : "");
        usedCorridor = true;
      }
    }

    if (!usedCorridor) {
      const draft = PhoneEscrowAdapter.buildDepositDraft(resolved.phone, amount, {
        address: token.address,
        symbol: token.symbol,
        decimals: token.decimals,
      });
      const intent = await PhoneEscrowAdapter.recordDepositIntent({
        senderId: input.senderId,
        phone: draft.phone,
        phoneHash: draft.phoneHash,
        tokenAddress: draft.tokenAddress,
        tokenSymbol: draft.tokenSymbol,
        tokenDecimals: draft.tokenDecimals,
        amountAtomic: draft.amountAtomic,
        amount: draft.amount,
        sourceId: sendId,
      });
      if (intent === "duplicate") {
        return { ok: false, status: 409, error: "This send was already submitted." };
      }
      calls = draft.calls;
      deliveredAmount = draft.amount;
      deliveredSymbol = draft.tokenSymbol;
      label =
        `Send ${draft.amount} ${draft.tokenSymbol} for ${contactLabel} to claim ` +
        `(${config.phoneEscrow.claimTtlHours}h)` +
        (memo ? ` — ${memo}` : "");
    }
  } else {
    const target = await resolveSendTarget(input.senderId, { phone: resolved.phone });
    if (target.kind !== "wallet") {
      return { ok: false, status: 400, error: "Could not resolve recipient wallet." };
    }

    let usedCorridor = false;
    if (corridor?.address) {
      const routed = await buildCorridorSendCalls({
        mode: "transfer",
        usdcAmount: amount,
        localStable: corridor,
        senderAddress: embedded.address,
        recipientAddress: target.address,
        phone: resolved.phone,
      });
      if (!routed.fallback) {
        calls = routed.calls;
        deliveredAmount = routed.localAmount;
        deliveredSymbol = corridor.symbol;
        label =
          `Convert ${amount} USDC → ~${routed.quotedLocalAmount} ${corridor.symbol} to ${contactLabel}` +
          (memo ? ` — ${memo}` : "");
        usedCorridor = true;
      }
    }

    if (!usedCorridor) {
      label = `Send ${amount} ${stable.symbol} to ${contactLabel}` + (memo ? ` — ${memo}` : "");
      calls = buildDirectTransferCalls(
        target.address as Address,
        token.address,
        token.decimals,
        amount,
        label,
      );
      deliveredAmount = amount;
      deliveredSymbol = stable.symbol;
    }
  }

  if (!calls || !label) {
    return { ok: false, status: 500, error: "Failed to build send transaction." };
  }

  const { token: confirmToken } = await PendingPayAdapter.create({
    senderId: input.senderId,
    fromAddress: embedded.address,
    chainId: BASE_CHAIN_ID,
    calls,
    label,
    recipientDisplay,
    amount: deliveredAmount,
    tokenSymbol: deliveredSymbol,
    transferMemo: memo || null,
    walletKind: "embedded",
    expiresAtMs: APP_SEND_TTL_SEC * 1000,
  });

  await stashPendingAutoSaveContact(input.senderId, confirmToken, {
    name,
    phone: resolved.phone,
  });
  await stateSet(appSendStateKey(input.senderId, sendId), { confirmToken }, APP_SEND_TTL_SEC);

  return {
    ok: true,
    confirmToken,
    delivery: resolved.delivery,
    recipientPhone: resolved.phone,
  };
}
