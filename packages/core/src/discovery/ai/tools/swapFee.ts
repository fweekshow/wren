import type { WalletCall } from "@basemate/shared";
import { type Address, encodeFunctionData, getAddress, isAddress, toHex } from "viem";

export const SWAP_FEE_BPS_DENOMINATOR = 10_000n;

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

export type SwapFeeConfig =
  | { enabled: false; bps: 0n }
  | { enabled: true; bps: bigint; recipient: Address };

export interface SwapFeeSplit {
  feeRaw: bigint;
  netRaw: bigint;
}

export class SwapFeeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapFeeConfigurationError";
  }
}

export interface SwapFeeEnv {
  SWAP_FEE_BPS?: string;
  SWAP_FEE_RECIPIENT?: string;
}

export function resolveSwapFeeConfig(env: SwapFeeEnv = process.env as SwapFeeEnv): SwapFeeConfig {
  const rawBps = (env.SWAP_FEE_BPS ?? "").trim();
  if (rawBps === "" || rawBps === "0") return { enabled: false, bps: 0n };
  if (!/^\d+$/.test(rawBps)) {
    throw new SwapFeeConfigurationError("SWAP_FEE_BPS must be a whole number of basis points");
  }

  const bps = BigInt(rawBps);
  if (bps <= 0n || bps > SWAP_FEE_BPS_DENOMINATOR) {
    throw new SwapFeeConfigurationError("SWAP_FEE_BPS must be between 0 and 10000");
  }

  const rawRecipient = (env.SWAP_FEE_RECIPIENT ?? "").trim();
  if (!isAddress(rawRecipient)) {
    throw new SwapFeeConfigurationError(
      "SWAP_FEE_RECIPIENT must be a valid Base address when swap fees are enabled",
    );
  }

  return { enabled: true, bps, recipient: getAddress(rawRecipient) };
}

export function splitSwapFeeAmount(grossRaw: bigint, bps: bigint): SwapFeeSplit {
  if (grossRaw <= 0n) throw new Error("Swap amount must be greater than zero");
  const feeRaw = (grossRaw * bps) / SWAP_FEE_BPS_DENOMINATOR;
  if (feeRaw <= 0n) throw new Error("Swap amount is too small to collect the configured fee");
  const netRaw = grossRaw - feeRaw;
  if (netRaw <= 0n) throw new Error("Swap fee leaves no amount to swap");
  return { feeRaw, netRaw };
}

export function formatSwapFeePercent(bps: bigint): string {
  const whole = bps / 100n;
  const fraction = (bps % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}%` : `${whole}%`;
}

export function buildSourceTokenTransfer(
  fromAddress: string,
  feeRaw: bigint,
  recipient: Address,
): WalletCall {
  if (fromAddress.toUpperCase() === "ETH") {
    return {
      to: recipient,
      value: toHex(feeRaw),
      data: "0x",
      metadata: {
        description: "Transfer ETH",
        transactionType: "transfer",
      },
    };
  }

  return {
    to: fromAddress as Address,
    value: "0x0",
    data: encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [recipient, feeRaw],
    }),
    metadata: {
      description: "Transfer tokens",
      transactionType: "transfer",
    },
  };
}

type SwapBuildResult = { calls: WalletCall[]; label: string };

export async function applySwapFeeToBuild<T extends SwapBuildResult>(args: {
  grossRawAmount: bigint;
  fromAddress: string;
  buildMainSwap: (netRawAmount: bigint) => Promise<T | null>;
  config?: SwapFeeConfig;
}): Promise<T | null> {
  const config = args.config ?? resolveSwapFeeConfig();
  if (!config.enabled) return args.buildMainSwap(args.grossRawAmount);

  const { feeRaw, netRaw } = splitSwapFeeAmount(args.grossRawAmount, config.bps);
  const mainSwap = await args.buildMainSwap(netRaw);
  if (!mainSwap) return null;
  const feeCall = buildSourceTokenTransfer(args.fromAddress, feeRaw, config.recipient);

  return {
    ...mainSwap,
    calls: [feeCall, ...mainSwap.calls],
  };
}
