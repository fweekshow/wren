import { type Address, decodeFunctionData, toHex } from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  applySwapFeeToBuild,
  buildSourceTokenTransfer,
  formatSwapFeePercent,
  resolveSwapFeeConfig,
  splitSwapFeeAmount,
  SwapFeeConfigurationError,
} from "./swapFee.js";

const FEE_RECIPIENT = "0x4a7eF13b4D7456bAAa219c26765702880a1303FD" as Address;
const SOURCE_TOKEN = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x2222222222222222222222222222222222222222" as Address;
const enabledConfig = { enabled: true as const, bps: 42n, recipient: FEE_RECIPIENT };
const TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function swapCall(description: string, value: `0x${string}` = "0x0") {
  return {
    to: ROUTER,
    data: "0x1234" as const,
    value,
    metadata: { description, transactionType: "swap" },
  };
}

describe("swap fee configuration and math", () => {
  it("parses a service-specific 42 bps fee", () => {
    expect(
      resolveSwapFeeConfig({
        SWAP_FEE_BPS: "42",
        SWAP_FEE_RECIPIENT: FEE_RECIPIENT,
      }),
    ).toEqual(enabledConfig);
    expect(formatSwapFeePercent(42n)).toBe("0.42%");
  });

  it("treats an absent or zero rate as disabled", () => {
    expect(resolveSwapFeeConfig({})).toEqual({ enabled: false, bps: 0n });
    expect(resolveSwapFeeConfig({ SWAP_FEE_BPS: "0" })).toEqual({
      enabled: false,
      bps: 0n,
    });
  });

  it("fails closed when an enabled fee has no valid recipient", () => {
    expect(() => resolveSwapFeeConfig({ SWAP_FEE_BPS: "42" })).toThrow(SwapFeeConfigurationError);
    expect(() =>
      resolveSwapFeeConfig({
        SWAP_FEE_BPS: "42.5",
        SWAP_FEE_RECIPIENT: FEE_RECIPIENT,
      }),
    ).toThrow(/whole number/i);
  });

  it("splits the gross amount with exact bigint rounding", () => {
    expect(splitSwapFeeAmount(1_000_000n, 42n)).toEqual({
      feeRaw: 4_200n,
      netRaw: 995_800n,
    });
    expect(() => splitSwapFeeAmount(1n, 42n)).toThrow(/too small/i);
  });

  it("builds a native ETH transfer to the configured recipient", () => {
    const call = buildSourceTokenTransfer("ETH", 4_200n, FEE_RECIPIENT);
    expect(call.to).toBe(FEE_RECIPIENT);
    expect(call.value).toBe(toHex(4_200n));
    expect(call.data).toBe("0x");
  });

  it("builds an ERC-20 source-token transfer to the configured recipient", () => {
    const call = buildSourceTokenTransfer(SOURCE_TOKEN, 4_200n, FEE_RECIPIENT);
    expect(call.to).toBe(SOURCE_TOKEN);
    expect(call.value).toBe("0x0");
    const decoded = decodeFunctionData({ abi: TRANSFER_ABI, data: call.data! });
    expect(decoded.functionName).toBe("transfer");
    expect(decoded.args).toEqual([FEE_RECIPIENT, 4_200n]);
  });
});

describe("applySwapFeeToBuild", () => {
  it("prepends a direct fee transfer for ETH input and swaps only the net amount", async () => {
    const buildMainSwap = vi.fn(async (amount: bigint) => ({
      calls: [swapCall(`Swap ${amount} ETH`, toHex(amount))],
      label: "Swap ETH → TOKEN",
    }));

    const result = await applySwapFeeToBuild({
      grossRawAmount: 1_000_000n,
      fromAddress: "ETH",
      buildMainSwap,
      config: enabledConfig,
    });

    expect(buildMainSwap).toHaveBeenCalledOnce();
    expect(buildMainSwap).toHaveBeenCalledWith(995_800n);
    expect(result?.calls).toHaveLength(2);
    expect(result?.calls[0]?.metadata?.transactionType).toBe("transfer");
    expect(result?.calls[0]?.metadata?.description).toBe("Transfer ETH");
    expect(result?.calls[1]?.metadata?.description).toBe("Swap 995800 ETH");
    expect(result?.label).toBe("Swap ETH → TOKEN");
    expect(JSON.stringify(result)).not.toMatch(/fee/i);
  });

  it("transfers the ERC-20 source fee before approving and executing the net swap", async () => {
    const mainApprove = {
      to: SOURCE_TOKEN as Address,
      data: "0xbeef" as const,
      value: "0x0" as const,
      metadata: { description: "Approve main route", transactionType: "approve" },
    };
    const mainSwap = swapCall("Swap source → token");
    const buildMainSwap = vi.fn(async () => ({
      calls: [mainApprove, mainSwap],
      label: "Main swap",
    }));

    const result = await applySwapFeeToBuild({
      grossRawAmount: 1_000_000n,
      fromAddress: SOURCE_TOKEN,
      buildMainSwap,
      config: enabledConfig,
    });

    expect(buildMainSwap).toHaveBeenCalledWith(995_800n);
    expect(result?.calls[0]?.to).toBe(SOURCE_TOKEN);
    expect(result?.calls.slice(1).map((call) => call.data)).toEqual([
      mainApprove.data,
      mainSwap.data,
    ]);
    const decoded = decodeFunctionData({
      abi: TRANSFER_ABI,
      data: result!.calls[0]!.data!,
    });
    expect(decoded.args).toEqual([FEE_RECIPIENT, 4_200n]);
    expect((decoded.args[1] as bigint) + 995_800n).toBe(1_000_000n);
    expect(JSON.stringify(result)).not.toMatch(/fee/i);
  });

  it("conserves the gross native value across fee and main swap calls", async () => {
    const result = await applySwapFeeToBuild({
      grossRawAmount: 10_000n,
      fromAddress: "ETH",
      buildMainSwap: async (amount) => ({
        calls: [swapCall("Main ETH swap", toHex(amount))],
        label: "Main ETH swap",
      }),
      config: enabledConfig,
    });

    const totalValue = result!.calls.reduce((sum, call) => sum + BigInt(call.value ?? "0x0"), 0n);
    expect(totalValue).toBe(10_000n);
  });

  it("returns no transaction when the net swap cannot be built", async () => {
    const result = await applySwapFeeToBuild({
      grossRawAmount: 1_000_000n,
      fromAddress: SOURCE_TOKEN,
      buildMainSwap: async () => null,
      config: enabledConfig,
    });
    expect(result).toBeNull();
  });

  it("does not build or charge a fee when the service fee is disabled", async () => {
    const result = await applySwapFeeToBuild({
      grossRawAmount: 1_000_000n,
      fromAddress: SOURCE_TOKEN,
      buildMainSwap: async (amount) => ({
        calls: [swapCall(`Swap ${amount}`)],
        label: "Main",
      }),
      config: { enabled: false, bps: 0n },
    });
    expect(result?.calls).toHaveLength(1);
    expect(result?.calls[0]?.metadata?.description).toBe("Swap 1000000");
  });
});
