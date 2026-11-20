import type { WalletCall } from "@basemate/shared";
import {
  encodeFunctionData,
  formatUnits,
  isAddress,
  parseUnits,
  type Address,
} from "viem";

import { CopyStrategyAdapter } from "@/copy-trading/adapters/copyStrategy.adapter.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import {
  resolveBasemateServerWallet,
  type StrategyWalletPlatform,
} from "@/discovery/strategy/wallet.js";
import {
  getBalances,
  sendCalls,
  type TokenBalance,
} from "@/wallet/cdp.js";

type SweepPlatform = "imessage" | "xmtp" | "whatsapp";

const NATIVE_ETH_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const SWEEP_GAS_RESERVE_ETH = "0.0003";

const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

export interface SweepWalletTarget {
  label: string;
  accountName: string;
  address: string;
}

export interface SweepPhaseResult {
  phase: "perps" | "vaults" | "tokens" | "eth";
  status: "sent" | "skipped" | "failed";
  hashes?: string[];
  message?: string;
}

export interface SweepWalletResult {
  label: string;
  address: string;
  phases: SweepPhaseResult[];
}

export interface SweepCustodialWalletsInput {
  platform: SweepPlatform;
  userKey: string;
  destination: string;
  mainWallet?: SweepWalletTarget | null;
  gasReserveEth?: string;
}

export interface SweepCustodialWalletsResult {
  destination: string;
  wallets: SweepWalletResult[];
  warnings: string[];
}

function transferCall(token: TokenBalance, destination: string): WalletCall | null {
  if (token.amount <= 0n) return null;
  const tokenAddress = token.contractAddress.toLowerCase();
  if (tokenAddress === NATIVE_ETH_ADDRESS || !isAddress(tokenAddress)) return null;
  return {
    to: tokenAddress as Address,
    value: "0x0",
    data: encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [destination as Address, token.amount],
    }),
    metadata: {
      description: `Sweep ${token.formatted} ${token.symbol}`,
      transactionType: "send",
    },
  };
}

function nativeEthTransferCall(amountWei: bigint, destination: string): WalletCall {
  return {
    to: destination as Address,
    value: `0x${amountWei.toString(16)}`,
    data: "0x",
    metadata: {
      description: `Sweep ${formatUnits(amountWei, 18)} ETH`,
      transactionType: "send",
    },
  };
}

function pushUniqueTarget(targets: SweepWalletTarget[], target: SweepWalletTarget | null | undefined): void {
  if (!target?.address || !target.accountName || !isAddress(target.address)) return;
  const normalized = target.address.toLowerCase();
  if (targets.some((existing) => existing.address.toLowerCase() === normalized)) return;
  targets.push({ ...target, address: normalized });
}

export async function resolveCustodialSweepWallets(input: {
  platform: SweepPlatform;
  userKey: string;
  mainWallet?: SweepWalletTarget | null;
}): Promise<SweepWalletTarget[]> {
  const targets: SweepWalletTarget[] = [];

  if (input.mainWallet) {
    pushUniqueTarget(targets, input.mainWallet);
  } else if (input.platform === "imessage") {
    const wallet = await WalletAdapter.findBySenderId(input.userKey);
    if (wallet) {
      pushUniqueTarget(targets, {
        label: "Main wallet",
        accountName: wallet.accountName,
        address: wallet.address,
      });
    }
  }

  const perpWallet = await resolveBasemateServerWallet(
    input.platform as StrategyWalletPlatform,
    input.userKey,
  ).catch(() => null);
  if (perpWallet) {
    pushUniqueTarget(targets, {
      label: "Perp wallet",
      accountName: perpWallet.walletName,
      address: perpWallet.walletAddress,
    });
  }

  const copyStrategies = await CopyStrategyAdapter.listForUser(input.platform, input.userKey).catch(() => []);
  for (const strategy of copyStrategies) {
    pushUniqueTarget(targets, {
      label: "Copy trading wallet",
      accountName: strategy.copy_wallet_name,
      address: strategy.copy_wallet_address,
    });
  }

  return targets;
}

async function runPhase(
  accountName: string,
  calls: WalletCall[],
  phase: SweepPhaseResult["phase"],
  skippedMessage: string,
): Promise<SweepPhaseResult> {
  if (calls.length === 0) {
    return { phase, status: "skipped", message: skippedMessage };
  }
  try {
    const { hashes } = await sendCalls({ accountName, calls });
    return { phase, status: "sent", hashes };
  } catch (err) {
    return {
      phase,
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function sweepWallet(
  target: SweepWalletTarget,
  destination: string,
  gasReserveWei: bigint,
): Promise<SweepWalletResult> {
  const phases: SweepPhaseResult[] = [];

  phases.push({ phase: "perps", status: "skipped", message: "perps are not part of Wren" });
  phases.push({ phase: "vaults", status: "skipped", message: "yield vaults are not part of Wren" });

  try {
    const balances = await getBalances(target.address);
    const tokenCalls = balances
      .map((balance) => transferCall(balance, destination))
      .filter((call): call is WalletCall => Boolean(call));
    phases.push(await runPhase(target.accountName, tokenCalls, "tokens", "no ERC-20 balances to sweep"));
  } catch (err) {
    phases.push({
      phase: "tokens",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const balances = await getBalances(target.address);
    const eth = balances.find((balance) => balance.contractAddress.toLowerCase() === NATIVE_ETH_ADDRESS);
    const sweepableEth = (eth?.amount ?? 0n) - gasReserveWei;
    const calls = sweepableEth > 0n ? [nativeEthTransferCall(sweepableEth, destination)] : [];
    phases.push(await runPhase(target.accountName, calls, "eth", "no ETH above gas reserve"));
  } catch (err) {
    phases.push({
      phase: "eth",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    label: target.label,
    address: target.address,
    phases,
  };
}

export async function sweepCustodialWallets(
  input: SweepCustodialWalletsInput,
): Promise<SweepCustodialWalletsResult> {
  if (!isAddress(input.destination)) {
    throw new Error("invalid sweep destination address");
  }
  const targets = await resolveCustodialSweepWallets(input);
  const gasReserveWei = parseUnits(input.gasReserveEth ?? SWEEP_GAS_RESERVE_ETH, 18);
  const wallets: SweepWalletResult[] = [];

  for (const target of targets) {
    wallets.push(await sweepWallet(target, input.destination, gasReserveWei));
  }

  return {
    destination: input.destination,
    wallets,
    warnings: [
      "Aave positions are not auto-withdrawn yet.",
      "Base App self-custody funds are not swept; only Basemate server wallets are included.",
    ],
  };
}

export interface CashoutLiquidInput {
  target: SweepWalletTarget;
  destination: string;
  gasReserveEth?: string;
}

/**
 * Liquid-only cashout: send free ERC-20 (USDC etc.) + ETH above the gas reserve
 * from a Basemate server wallet to the user's Base App wallet. Does NOT close
 * perps or redeem vaults — callers must block this when open positions exist.
 */
export async function cashoutLiquidFromWallet(
  input: CashoutLiquidInput,
): Promise<SweepWalletResult> {
  if (!isAddress(input.destination)) {
    throw new Error("invalid cashout destination address");
  }
  const { target, destination } = input;
  const gasReserveWei = parseUnits(input.gasReserveEth ?? SWEEP_GAS_RESERVE_ETH, 18);
  const phases: SweepPhaseResult[] = [];

  try {
    const balances = await getBalances(target.address);
    const tokenCalls = balances
      .map((balance) => transferCall(balance, destination))
      .filter((call): call is WalletCall => Boolean(call));
    phases.push(await runPhase(target.accountName, tokenCalls, "tokens", "no liquid USDC to cash out"));
  } catch (err) {
    phases.push({
      phase: "tokens",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const balances = await getBalances(target.address);
    const eth = balances.find((balance) => balance.contractAddress.toLowerCase() === NATIVE_ETH_ADDRESS);
    const sweepableEth = (eth?.amount ?? 0n) - gasReserveWei;
    const calls = sweepableEth > 0n ? [nativeEthTransferCall(sweepableEth, destination)] : [];
    phases.push(await runPhase(target.accountName, calls, "eth", "no ETH above gas reserve"));
  } catch (err) {
    phases.push({
      phase: "eth",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return { label: target.label, address: target.address, phases };
}

/** Preview copy for liquid cashout — explicitly states open positions are NOT closed. */
export function formatCashoutPreview(input: {
  destination: string;
  usdcLiquid: number;
  ethLiquid: number;
}): string {
  const usd = `$${input.usdcLiquid.toFixed(2)} USDC`;
  const eth = input.ethLiquid > 0 ? ` + ${input.ethLiquid.toFixed(4)} ETH (above gas)` : "";
  return [
    `cashing out ${usd}${eth} to your Base App wallet:`,
    input.destination,
    "",
    "open positions stay open — only free funds move. tap confirm below 💙",
  ].join("\n");
}

/** Result copy for a finished cashout (token + eth phases only). */
export function formatCashoutResult(result: SweepWalletResult, destination: string): string {
  const lines = [`cashout to ${destination} done 💙`];
  for (const phase of result.phases) {
    const suffix = phase.hashes?.length
      ? `: ${phase.hashes.map((hash) => `https://app.basemate.app/txn/${hash}`).join(", ")}`
      : phase.message
        ? `: ${phase.message}`
        : "";
    lines.push(`- ${phase.phase}: ${phase.status}${suffix}`);
  }
  return lines.join("\n");
}

export function formatSweepPreview(targets: SweepWalletTarget[], destination: string): string {
  if (targets.length === 0) {
    return "i couldn't find any Basemate server wallets to sweep.";
  }
  const lines = [
    `This will sweep ${targets.length} Basemate server wallet${targets.length === 1 ? "" : "s"} to ${destination}:`,
    ...targets.map((target) => `- ${target.label}: ${target.address}`),
    "",
    "I'll close all perps, redeem Morpho/Moonwell vaults, send ERC-20 balances, then send ETH above the gas reserve.",
    "Aave positions and your Base App wallet are not included.",
    "",
    "Reply confirm to run it.",
  ];
  return lines.join("\n");
}

export function formatSweepResult(result: SweepCustodialWalletsResult): string {
  const lines = [`Sweep to ${result.destination} finished.`];
  for (const wallet of result.wallets) {
    lines.push("", `${wallet.label} (${wallet.address}):`);
    for (const phase of wallet.phases) {
      const suffix = phase.hashes?.length
        ? `: ${phase.hashes.map((hash) => `https://app.basemate.app/txn/${hash}`).join(", ")}`
        : phase.message
          ? `: ${phase.message}`
          : "";
      lines.push(`- ${phase.phase}: ${phase.status}${suffix}`);
    }
  }
  if (result.warnings.length > 0) {
    lines.push("", ...result.warnings.map((warning) => `Note: ${warning}`));
  }
  return lines.join("\n");
}
