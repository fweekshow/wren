import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { isIP } from "node:net";
import {
  createPublicClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseUnits,
  type Address,
} from "viem";
import { base } from "viem/chains";

import { config } from "@/config/config.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { EmbeddedWalletAdapter } from "@/wallet/embeddedWallet.js";
import { BASE_USDC_ADDRESS } from "@/wallet/cdp.js";
import { buildOfframpUrl } from "@/wallet/onramp.js";
import {
  OfframpSessionAdapter,
  type OfframpPlatform,
  type OfframpSessionRow,
  type OfframpSessionStatus,
} from "@/wallet/offrampSession.js";

const API_HOST = "api.developer.coinbase.com";
const USDC_DECIMALS = 6;
const VALID_COINBASE_STATUSES = new Set([
  "TRANSACTION_STATUS_CREATED",
  "TRANSACTION_STATUS_STARTED",
  "TRANSACTION_STATUS_SUCCESS",
  "TRANSACTION_STATUS_FAILED",
  "TRANSACTION_STATUS_EXPIRED",
]);
const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

type Money = { value?: string; amount?: string; currency?: string } | null;
type CoinbaseOfframpTransaction = {
  id?: string;
  transaction_id?: string;
  transactionId?: string;
  status?: string;
  asset?: string;
  network?: string;
  sell_amount?: Money;
  sellAmount?: Money;
  total?: Money;
  coinbase_fee?: Money;
  coinbaseFee?: Money;
  from_address?: string;
  fromAddress?: string;
  to_address?: string;
  toAddress?: string;
  tx_hash?: string;
  txHash?: string;
};

export type OfframpPublicStatus = {
  id: string;
  status: OfframpSessionStatus;
  requestedAmount: string;
  sellAmount: string | null;
  fiatTotal: string | null;
  fiatCurrency: string | null;
  coinbaseFee: string | null;
  approvalUrl: string | null;
  txHash: string | null;
  launchExpiresAt: string;
  transferExpiresAt: string | null;
};

export class OfframpValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfframpValidationError";
  }
}

function rpcClient() {
  return createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org"),
  });
}

function normalizeAmount(value: string): string {
  const trimmed = value.trim().replaceAll(",", "");
  if (!/^\d+(?:\.\d{1,6})?$/.test(trimmed)) {
    throw new OfframpValidationError("Enter a valid USDC amount with up to 6 decimal places.");
  }
  const atomic = parseUnits(trimmed, USDC_DECIMALS);
  if (atomic <= 0n) throw new OfframpValidationError("Cash-out amount must be greater than zero.");
  return formatUnits(atomic, USDC_DECIMALS);
}

function amountValue(value: Money | undefined): string | null {
  const raw = value?.value ?? value?.amount;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function currencyValue(value: Money | undefined): string | null {
  return typeof value?.currency === "string" && value.currency.trim()
    ? value.currency.trim()
    : null;
}

function sameAmount(left: string, right: string): boolean {
  try {
    return parseUnits(left, USDC_DECIMALS) === parseUnits(right, USDC_DECIMALS);
  } catch {
    return false;
  }
}

function returnUrl(token: string): string {
  const url = new URL(config.cdp.offrampRedirectUrl);
  url.searchParams.set("o", token);
  return url.toString();
}

function publicLink(token: string): string {
  const url = new URL(config.cdp.fundPageUrl);
  url.searchParams.set("o", token);
  return url.toString();
}

export async function getBaseUsdcBalance(address: string): Promise<string> {
  if (!isAddress(address)) throw new OfframpValidationError("Connected wallet address is invalid.");
  const balance = await rpcClient().readContract({
    address: BASE_USDC_ADDRESS as Address,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [getAddress(address)],
  });
  return formatUnits(balance, USDC_DECIMALS);
}

export async function createOfframpDraft(input: {
  platform: OfframpPlatform;
  userKey: string;
  sourceAddress: string;
  amount: string;
}): Promise<{ token: string; url: string; session: OfframpSessionRow }> {
  if (!config.cdp.paymentsEnabled) {
    throw new OfframpValidationError("Coinbase cash-out is not configured.");
  }
  if (!isAddress(input.sourceAddress)) {
    throw new OfframpValidationError("Connect a valid Basemate wallet before cashing out.");
  }
  const embedded = await WalletAdapter.getEmbeddedWallet(input.userKey);
  if (!embedded || embedded.address.toLowerCase() !== input.sourceAddress.toLowerCase()) {
    throw new OfframpValidationError("Connect your Basemate wallet before cashing out.");
  }
  const amount = normalizeAmount(input.amount);
  const balance = await getBaseUsdcBalance(input.sourceAddress);
  if (parseUnits(amount, USDC_DECIMALS) > parseUnits(balance, USDC_DECIMALS)) {
    throw new OfframpValidationError(`You only have ${balance} USDC available.`);
  }
  const created = await OfframpSessionAdapter.create({
    platform: input.platform,
    userKey: input.userKey,
    sourceAddress: getAddress(input.sourceAddress),
    requestedAmount: amount,
  });
  return { ...created, url: publicLink(created.token) };
}

export async function launchOfframp(token: string, clientIp?: string): Promise<{
  coinbaseUrl: string;
  session: OfframpSessionRow;
}> {
  const session = await requireCapability(token);
  if (isTerminal(session.status)) throw new OfframpValidationError("This cash-out session has ended.");
  const resolvedClientIp = clientIp?.trim() || config.cdp.onrampClientIpFallback;
  if (!resolvedClientIp || !isIP(resolvedClientIp)) {
    throw new OfframpValidationError("Could not securely identify this browser for Coinbase.");
  }
  const coinbaseUrl = await buildOfframpUrl({
    address: session.sourceAddress,
    partnerUserRef: session.partnerUserRef,
    presetCryptoAmount: session.requestedAmount,
    redirectUrl: returnUrl(token),
    disableEdit: true,
    clientIp: resolvedClientIp,
  });
  const launched = await OfframpSessionAdapter.markLaunched(session.id);
  if (!launched) throw new OfframpValidationError("This cash-out session can no longer be launched.");
  return { coinbaseUrl, session: launched };
}

async function fetchTransactions(partnerUserRef: string): Promise<CoinbaseOfframpTransaction[]> {
  const requestPath = `/onramp/v1/sell/user/${encodeURIComponent(partnerUserRef)}/transactions`;
  const jwt = await generateJwt({
    apiKeyId: config.cdp.apiKeyId,
    apiKeySecret: config.cdp.apiKeySecret,
    requestMethod: "GET",
    requestHost: API_HOST,
    requestPath,
  });
  const url = new URL(`https://${API_HOST}${requestPath}`);
  url.searchParams.set("pageSize", "10");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
  });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`Coinbase offramp status failed (${response.status}): ${message}`);
  }
  const body = (await response.json()) as { transactions?: CoinbaseOfframpTransaction[] };
  return Array.isArray(body.transactions) ? body.transactions : [];
}

function validateTransaction(
  session: OfframpSessionRow,
  transaction: CoinbaseOfframpTransaction,
): {
  transactionId: string;
  status: string;
  sellAmount: string;
  fiatTotal: string | null;
  fiatCurrency: string | null;
  coinbaseFee: string | null;
  toAddress: string;
  txHash: string | null;
} {
  const transactionId = transaction.transaction_id ?? transaction.transactionId ?? transaction.id;
  const status = transaction.status;
  const sellAmount = amountValue(transaction.sell_amount ?? transaction.sellAmount);
  const sellCurrency = currencyValue(transaction.sell_amount ?? transaction.sellAmount);
  const fromAddress = transaction.from_address ?? transaction.fromAddress;
  const toAddress = transaction.to_address ?? transaction.toAddress;
  if (!transactionId || !status || !sellAmount || !toAddress) {
    throw new OfframpValidationError("Coinbase has not finished preparing the transfer details yet.");
  }
  if (!VALID_COINBASE_STATUSES.has(status)) {
    throw new OfframpValidationError("Coinbase returned an unknown transaction status.");
  }
  if ((transaction.asset ?? sellCurrency)?.toUpperCase() !== "USDC") {
    throw new OfframpValidationError("Coinbase returned a non-USDC cash-out transaction.");
  }
  if ((transaction.network ?? "").toLowerCase() !== "base") {
    throw new OfframpValidationError("Coinbase returned a transaction on the wrong network.");
  }
  if (!fromAddress || fromAddress.toLowerCase() !== session.sourceAddress.toLowerCase()) {
    throw new OfframpValidationError("Coinbase returned a transaction for a different wallet.");
  }
  if (!sameAmount(sellAmount, session.requestedAmount)) {
    throw new OfframpValidationError("Coinbase returned a different sell amount.");
  }
  if (!isAddress(toAddress)) {
    throw new OfframpValidationError("Coinbase returned an invalid deposit address.");
  }
  return {
    transactionId,
    status,
    sellAmount: normalizeAmount(sellAmount),
    fiatTotal: amountValue(transaction.total),
    fiatCurrency: currencyValue(transaction.total),
    coinbaseFee: amountValue(transaction.coinbase_fee ?? transaction.coinbaseFee),
    toAddress: getAddress(toAddress),
    txHash: transaction.tx_hash ?? transaction.txHash ?? null,
  };
}

export async function refreshOfframp(tokenOrSession: string | OfframpSessionRow): Promise<OfframpSessionRow> {
  const session =
    typeof tokenOrSession === "string" ? await requireCapability(tokenOrSession) : tokenOrSession;
  if (session.status === "draft" || isTerminal(session.status)) return session;

  const transactions = await fetchTransactions(session.partnerUserRef);
  if (transactions.length === 0) return session;
  const snapshot = validateTransaction(session, transactions[0]!);
  const mappedStatus = coinbaseLocalStatus(snapshot.status, session.status);
  const updated = await OfframpSessionAdapter.recordCoinbaseTransaction(session.id, {
    ...snapshot,
    localStatus: mappedStatus,
  });
  return updated ?? session;
}

export async function createOfframpApproval(token: string): Promise<{
  approvalUrl: string;
  session: OfframpSessionRow;
}> {
  const session = await refreshOfframp(token);
  if (session.status !== "transaction_ready" || !session.toAddress || !session.sellAmount) {
    throw new OfframpValidationError("Coinbase transfer details are not ready yet.");
  }
  const claimed = await OfframpSessionAdapter.claimApproval(session.id);
  if (!claimed) throw new OfframpValidationError("A transfer approval is already being prepared.");

  const transferData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [getAddress(claimed.toAddress!), parseUnits(claimed.sellAmount!, USDC_DECIMALS)],
  });
  const transferCall = { to: BASE_USDC_ADDRESS as `0x${string}`, data: transferData, value: "0x0" as const };

  // Embedded wallet: sign the USDC transfer server-side via the user's delegation
  // — no wallet popup. Coinbase then polls its own side for the incoming
  // transfer, so we just move the session to transfer_submitted.
  const embedded = await WalletAdapter.getEmbeddedWallet(claimed.userKey);
  if (
    embedded?.address &&
    embedded.address.toLowerCase() === claimed.sourceAddress.toLowerCase()
  ) {
    try {
      const result = await EmbeddedWalletAdapter.sendCalls({
        userId: embedded.cdpUserId,
        address: embedded.address,
        calls: [transferCall],
      });
      const hash = result.txHash ?? result.userOpHash ?? null;
      await OfframpSessionAdapter.updateTransferStatus(claimed.id, {
        status: "transfer_submitted",
        txHash: hash,
      });
      const updated = (await OfframpSessionAdapter.getById(claimed.id)) ?? claimed;
      // No approval URL — the transfer already executed; the page shows progress.
      return { approvalUrl: "", session: updated };
    } catch (error) {
      await OfframpSessionAdapter.releaseApprovalClaim(claimed.id);
      throw error;
    }
  }

  await OfframpSessionAdapter.releaseApprovalClaim(claimed.id);
  throw new OfframpValidationError("The connected embedded wallet does not match this cash-out.");
}

function coinbaseLocalStatus(
  coinbaseStatus: string,
  current: string,
): OfframpSessionStatus {
  if (coinbaseStatus === "TRANSACTION_STATUS_SUCCESS") return "success";
  if (coinbaseStatus === "TRANSACTION_STATUS_FAILED") return "failed";
  if (coinbaseStatus === "TRANSACTION_STATUS_EXPIRED") return "expired";
  if (current === "transfer_submitted" || current === "processing") return "processing";
  if (current === "approval_pending" || current === "approval_creating") {
    return current as OfframpSessionStatus;
  }
  return "transaction_ready";
}

export function toPublicOfframpStatus(session: OfframpSessionRow): OfframpPublicStatus {
  return {
    id: session.id,
    status: session.status as OfframpSessionStatus,
    requestedAmount: session.requestedAmount,
    sellAmount: session.sellAmount ?? null,
    fiatTotal: session.fiatTotal ?? null,
    fiatCurrency: session.fiatCurrency ?? null,
    coinbaseFee: session.coinbaseFee ?? null,
    approvalUrl: null,
    txHash: session.txHash ?? null,
    launchExpiresAt: session.launchExpiresAt.toISOString(),
    transferExpiresAt: session.transferExpiresAt?.toISOString() ?? null,
  };
}

export async function requireCapability(token: string): Promise<OfframpSessionRow> {
  const session = await OfframpSessionAdapter.getByCapability(token);
  if (!session) throw new OfframpValidationError("Cash-out session not found or expired.");
  return session;
}

function isTerminal(status: string): boolean {
  return ["success", "failed", "expired", "manual_review"].includes(status);
}
