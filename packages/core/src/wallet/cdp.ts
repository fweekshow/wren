import { CdpClient } from "@coinbase/cdp-sdk";
import type { WalletCall } from "@basemate/shared";
import {
  createPublicClient,
  decodeFunctionData,
  formatUnits,
  http,
  isAddress,
  parseUnits,
  type Address,
} from "viem";
import { base } from "viem/chains";

import { config } from "@/config/config.js";

/**
 * Coinbase Developer Platform (CDP) — custodial server wallets on Base.
 *
 * These are CDP "API key wallets": the private keys are held by CDP and
 * controlled by our server via the Secret API Key + Wallet Secret. basemate
 * custodies the funds on the user's behalf, which is what lets the iMessage bot
 * (a text-only transport that cannot prompt the user to sign) move funds when
 * the user asks (e.g. withdrawals). Treat the credentials as highly sensitive.
 */

/** Base mainnet network slug used across all CDP wallet operations. */
export const CDP_NETWORK = "base" as const;

/** USDC on Base mainnet (6 decimals) — the primary asset. */
export const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase();
const USDC_DECIMALS = 6;

/** Native ETH placeholder address per EIP-7528, as returned by listTokenBalances. */
const NATIVE_ETH_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const ERC20_APPROVE_ALLOWANCE_ABI = [
  {
    name: "approve",
    type: "function",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    name: "allowance",
    type: "function",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

const APPROVAL_POLL_INTERVAL_MS = 1_000;
const APPROVAL_POLL_ATTEMPTS = 20;

type AllowanceClient = {
  readContract(args: {
    address: Address;
    abi: typeof ERC20_APPROVE_ALLOWANCE_ABI;
    functionName: "allowance";
    args: [Address, Address];
  }): Promise<bigint>;
};

export interface TokenBalance {
  symbol: string;
  contractAddress: string;
  /** Atomic (smallest-unit) amount. */
  amount: bigint;
  decimals: number;
  /** Human-readable amount, e.g. "12.5". */
  formatted: string;
}

let client: CdpClient | null = null;
let publicClient: AllowanceClient | null = null;

/** True when CDP credentials are configured. Callers should check before invoking wallet ops. */
export function isCdpEnabled(): boolean {
  return config.cdp.enabled;
}

/** Lazily construct the shared CdpClient from config. Throws if CDP is not configured. */
export function getCdpClient(): CdpClient {
  if (!config.cdp.enabled) {
    throw new Error(
      "CDP is not configured — set CDP_API_KEY_ID, CDP_API_KEY_SECRET and CDP_WALLET_SECRET",
    );
  }
  if (!client) {
    client = new CdpClient({
      apiKeyId: config.cdp.apiKeyId,
      apiKeySecret: config.cdp.apiKeySecret,
      walletSecret: config.cdp.walletSecret,
    });
  }
  return client;
}

function getBasePublicClient(): AllowanceClient {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: base,
      transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
    }) as AllowanceClient;
  }
  return publicClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseApproveCall(call: WalletCall): { token: Address; spender: Address; amount: bigint } | null {
  if (!call.to || !call.data || !isAddress(call.to)) return null;
  try {
    const decoded = decodeFunctionData({
      abi: ERC20_APPROVE_ALLOWANCE_ABI,
      data: call.data,
    });
    if (decoded.functionName !== "approve") return null;
    const [spender, amount] = decoded.args;
    if (!isAddress(spender)) return null;
    return {
      token: call.to as Address,
      spender,
      amount,
    };
  } catch {
    return null;
  }
}

async function waitForAllowance(params: {
  owner: Address;
  token: Address;
  spender: Address;
  amount: bigint;
}): Promise<void> {
  const rpc = getBasePublicClient();
  let lastAllowance = 0n;
  let lastReadError: unknown = null;

  for (let attempt = 0; attempt < APPROVAL_POLL_ATTEMPTS; attempt += 1) {
    try {
      const allowance = await rpc.readContract({
        address: params.token,
        abi: ERC20_APPROVE_ALLOWANCE_ABI,
        functionName: "allowance",
        args: [params.owner, params.spender],
      });
      lastAllowance = allowance;
      lastReadError = null;
      if (allowance >= params.amount) return;
    } catch (err) {
      lastReadError = err;
    }

    await sleep(APPROVAL_POLL_INTERVAL_MS);
  }

  if (lastReadError) {
    console.warn("⚠️ [CDP] allowance read failed after approval:", lastReadError);
  }

  throw new Error(
    `approval confirmed but allowance is still too low (${lastAllowance.toString()} < ${params.amount.toString()})`,
  );
}

/**
 * Create or fetch the server wallet for a given account name. Names must be
 * 2-36 chars of [a-zA-Z0-9-] and unique per project (see WalletAdapter for how
 * iMessage sender ids are mapped to a safe name). Idempotent.
 */
export async function getOrCreateUserWallet(accountName: string): Promise<{ address: string }> {
  const cdp = getCdpClient();
  const account = await cdp.evm.getOrCreateAccount({ name: accountName });
  return { address: account.address };
}

/**
 * When true, VibeTrading strategy `cp-` wallets execute via CDP smart accounts
 * with Portal paymaster gas sponsorship (no ETH required). Default off until
 * Portal allowlist + canary pass — flip with STRATEGY_USE_CDP_PAYMASTER=true.
 */
export function isStrategyPaymasterEnabled(): boolean {
  return process.env.STRATEGY_USE_CDP_PAYMASTER === "true";
}

export interface StrategySmartWallet {
  /** CDP named owner account (`cp-...`). */
  walletName: string;
  /** Smart account address — the funding / trader address when paymaster is on. */
  walletAddress: string;
  /** Owner EOA address (not funded for live strategies when paymaster is on). */
  ownerAddress: string;
}

/**
 * Deterministic CDP smart-account name for a strategy `cp-` owner.
 * CDP requires `name` or `address` on getOrCreateSmartAccount (2–36 chars).
 */
export function strategySmartAccountName(accountName: string): string {
  if (accountName.startsWith("cp-")) {
    // cp-<30 hex> → sa-<30 hex> (33 chars, within CDP limit)
    return `sa-${accountName.slice(3)}`;
  }
  const safe = accountName.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 33);
  return `sa-${safe}`.slice(0, 36);
}

/**
 * Resolve the execution address for a strategy CDP account.
 *
 * With paymaster enabled: returns the CDP smart account owned by the named
 * `cp-` EOA (idempotent). Without paymaster: returns the EOA address (legacy).
 */
export async function getOrCreateStrategySmartWallet(
  accountName: string,
): Promise<StrategySmartWallet> {
  const cdp = getCdpClient();
  const owner = await cdp.evm.getOrCreateAccount({ name: accountName });

  // Paymaster scope is strategy creator `cp-` wallets only — follower `st-`
  // (and any other) names stay on the EOA path so trader address matches signer.
  if (!isStrategyPaymasterEnabled() || !accountName.startsWith("cp-")) {
    return {
      walletName: accountName,
      walletAddress: owner.address,
      ownerAddress: owner.address,
    };
  }

  const smart = await cdp.evm.getOrCreateSmartAccount({
    name: strategySmartAccountName(accountName),
    owner,
  });
  return {
    walletName: accountName,
    walletAddress: smart.address,
    ownerAddress: owner.address,
  };
}

/** Fetch all token balances for an address on Base, paginating to completion. */
export async function getBalances(address: string): Promise<TokenBalance[]> {
  const cdp = getCdpClient();
  const out: TokenBalance[] = [];
  let pageToken: string | undefined;

  do {
    const page = await cdp.evm.listTokenBalances({
      address: address as `0x${string}`,
      network: CDP_NETWORK,
      pageSize: 50,
      pageToken,
    });
    for (const b of page.balances) {
      const decimals = b.amount.decimals;
      const contractAddress = b.token.contractAddress.toLowerCase();
      out.push({
        symbol: b.token.symbol || shortSymbolFor(contractAddress),
        contractAddress,
        amount: b.amount.amount,
        decimals,
        formatted: formatUnits(b.amount.amount, decimals),
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  return out;
}

function shortSymbolFor(contractAddress: string): string {
  if (contractAddress === NATIVE_ETH_ADDRESS) return "ETH";
  if (contractAddress === BASE_USDC_ADDRESS) return "USDC";
  return `${contractAddress.slice(0, 6)}…`;
}

/** Convenience: USDC balance (human-readable string) for an address, "0" if none. */
export async function getUsdcBalance(address: string): Promise<string> {
  const balances = await getBalances(address);
  const usdc = balances.find((b) => b.contractAddress === BASE_USDC_ADDRESS);
  return usdc?.formatted ?? "0";
}

/** Convenience: native ETH balance (atomic wei) for an address, 0n if none. */
export async function getEthBalance(address: string): Promise<bigint> {
  const balances = await getBalances(address);
  const eth = balances.find((b) => b.contractAddress === NATIVE_ETH_ADDRESS);
  return eth?.amount ?? 0n;
}

export interface WithdrawParams {
  /** CDP account name to send FROM (the user's server wallet). */
  accountName: string;
  /** Destination 0x address. */
  to: string;
  /** Human-readable amount, e.g. "12.5". */
  amount: string;
  /** Asset to withdraw. Only USDC and ETH are supported for now. */
  asset: "usdc" | "eth";
}

export interface WithdrawResult {
  transactionHash: string;
}

/**
 * Withdraw USDC or ETH from a user's custodial wallet to an external address.
 * The wallet pays its own gas in ETH, so an ETH balance is required even for
 * ERC-20 (USDC) transfers.
 */
export async function withdraw(params: WithdrawParams): Promise<WithdrawResult> {
  const { accountName, to, amount, asset } = params;
  if (!isAddress(to)) {
    throw new Error(`invalid destination address: ${to}`);
  }
  const decimals = asset === "usdc" ? USDC_DECIMALS : 18;
  const atomic = parseUnits(amount, decimals);
  if (atomic <= 0n) {
    throw new Error("amount must be greater than 0");
  }

  const cdp = getCdpClient();
  const account = await cdp.evm.getOrCreateAccount({ name: accountName });
  const { transactionHash } = await account.transfer({
    to: to as `0x${string}`,
    amount: atomic,
    token: asset,
    network: CDP_NETWORK,
  });
  return { transactionHash };
}

/**
 * Raised when a custodial wallet has no ETH to pay gas. The iMessage layer
 * surfaces this to the user so they know to fund a little ETH on Base before
 * the bot can submit on-chain calls (perps, swaps, sends) on their behalf.
 */
export class InsufficientGasError extends Error {
  constructor(message = "custodial wallet has no ETH for gas") {
    super(message);
    this.name = "InsufficientGasError";
  }
}

/**
 * Raised when CDP cannot simulate a prepared transaction. This usually means
 * the calldata is no longer executable for the current wallet state: stale
 * balance, missing allowance, changed route, or a protocol-level revert.
 */
export class GasEstimationError extends Error {
  constructor(message = "unable to estimate gas") {
    super(message);
    this.name = "GasEstimationError";
  }
}

export interface SendCallsParams {
  /** CDP account name to send FROM (the user's server wallet). */
  accountName: string;
  /** Ordered list of calls (e.g. USDC approve, then Avantis open). */
  calls: WalletCall[];
}

export interface SendCallsResult {
  /** Transaction hashes in the order the calls were submitted. */
  hashes: string[];
}

/**
 * Sign and broadcast a batch of arbitrary on-chain calls from a user's
 * custodial wallet, one at a time, waiting for each receipt before sending the
 * next. This is how the text-only iMessage transport "signs" a prepared
 * transaction (perps approve + open, swaps, sends): the user confirms in chat
 * and the server submits the calls via CDP.
 *
 * The wallet pays its own gas in ETH, so a non-zero ETH balance is required —
 * we pre-flight that and throw {@link InsufficientGasError} otherwise.
 */
export async function sendCalls(params: SendCallsParams): Promise<SendCallsResult> {
  const { accountName, calls } = params;
  if (calls.length === 0) {
    throw new Error("no calls to send");
  }

  const cdp = getCdpClient();
  const account = await cdp.evm.getOrCreateAccount({ name: accountName });

  const ethBalance = await getEthBalance(account.address);
  if (ethBalance <= 0n) {
    throw new InsufficientGasError();
  }

  const net = await account.useNetwork(CDP_NETWORK);

  const hashes: string[] = [];
  for (const call of calls) {
    if (!call.to) {
      throw new Error("call is missing a destination address");
    }
    const approval = parseApproveCall(call);
    let result: Awaited<ReturnType<typeof net.sendTransaction>>;
    try {
      result = await net.sendTransaction({
        transaction: {
          to: call.to,
          data: call.data ?? "0x",
          value: call.value ? BigInt(call.value) : 0n,
        },
      });
    } catch (err) {
      if (isGasEstimationFailure(err)) {
        throw new GasEstimationError(errorMessage(err));
      }
      throw err;
    }
    await net.waitForTransactionReceipt(result);
    if (approval) {
      await waitForAllowance({
        owner: account.address as Address,
        token: approval.token,
        spender: approval.spender,
        amount: approval.amount,
      });
    }
    hashes.push(result.transactionHash);
  }

  return { hashes };
}

/**
 * Strategy-only send path. When paymaster is enabled and `accountName` is a
 * `cp-` wallet, batches calls into one sponsored user operation (no ETH
 * preflight). Otherwise falls back to {@link sendCalls} (EOA + ETH gas).
 *
 * Does not touch embedded / iMessage / escrow flows — those keep using sendCalls.
 */
export async function sendStrategyCalls(params: SendCallsParams): Promise<SendCallsResult> {
  const { accountName, calls } = params;
  if (calls.length === 0) {
    throw new Error("no calls to send");
  }

  if (!isStrategyPaymasterEnabled() || !accountName.startsWith("cp-")) {
    return sendCalls(params);
  }

  const cdp = getCdpClient();
  const owner = await cdp.evm.getOrCreateAccount({ name: accountName });
  const smartAccount = await cdp.evm.getOrCreateSmartAccount({
    name: strategySmartAccountName(accountName),
    owner,
  });

  const userOpCalls = calls.map((call) => {
    if (!call.to) {
      throw new Error("call is missing a destination address");
    }
    return {
      to: call.to as `0x${string}`,
      data: (call.data ?? "0x") as `0x${string}`,
      value: call.value ? BigInt(call.value) : 0n,
    };
  });

  // On Base, CDP SDK defaults paymasterUrl to the project Base Node RPC; Portal
  // Paymaster allowlist / spend limits apply automatically (no useCdpPaymaster
  // flag on the server-account API — that flag is end-user only).
  let userOp: Awaited<ReturnType<typeof cdp.evm.sendUserOperation>>;
  try {
    userOp = await cdp.evm.sendUserOperation({
      smartAccount,
      network: CDP_NETWORK,
      calls: userOpCalls,
    });
  } catch (err) {
    if (isGasEstimationFailure(err)) {
      throw new GasEstimationError(errorMessage(err));
    }
    throw err;
  }

  const receipt = await cdp.evm.waitForUserOperation({
    smartAccountAddress: smartAccount.address,
    userOpHash: userOp.userOpHash,
  });

  if (receipt.status !== "complete") {
    throw new Error(`strategy user operation ${receipt.status}`);
  }
  if (!("transactionHash" in receipt) || !receipt.transactionHash) {
    throw new Error("strategy user operation completed without a transaction hash");
  }

  return { hashes: [receipt.transactionHash] };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const message = (err as { errorMessage?: unknown; message?: unknown }).errorMessage ??
      (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(err);
}

function isGasEstimationFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const maybe = err as {
    errorMessage?: unknown;
    message?: unknown;
    statusCode?: unknown;
    errorType?: unknown;
  };
  const message = errorMessage(err).toLowerCase();
  return (
    message.includes("unable to estimate gas") ||
    (maybe.statusCode === 400 &&
      maybe.errorType === "invalid_request" &&
      message.includes("estimate gas"))
  );
}
