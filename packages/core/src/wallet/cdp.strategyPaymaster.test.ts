import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getOrCreateAccount = vi.fn();
const getOrCreateSmartAccount = vi.fn();
const sendUserOperation = vi.fn();
const waitForUserOperation = vi.fn();
const listTokenBalances = vi.fn();
const sendTransaction = vi.fn();
const waitForTransactionReceipt = vi.fn();
const useNetwork = vi.fn();

vi.mock("@coinbase/cdp-sdk", () => ({
  CdpClient: class {
    evm = {
      getOrCreateAccount,
      getOrCreateSmartAccount,
      sendUserOperation,
      waitForUserOperation,
      listTokenBalances,
    };
  },
}));

vi.mock("@/config/config.js", () => ({
  config: {
    cdp: {
      enabled: true,
      apiKeyId: "test-id",
      apiKeySecret: "test-secret",
      walletSecret: "test-wallet-secret",
    },
  },
}));

const OWNER = {
  address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
  useNetwork,
};
const SMART = {
  address: "0x2222222222222222222222222222222222222222" as `0x${string}`,
  owners: [OWNER],
};

const {
  getOrCreateStrategySmartWallet,
  isStrategyPaymasterEnabled,
  sendStrategyCalls,
} = await import("./cdp.js");

beforeEach(() => {
  delete process.env.STRATEGY_USE_CDP_PAYMASTER;
  getOrCreateAccount.mockReset().mockResolvedValue(OWNER);
  getOrCreateSmartAccount.mockReset().mockResolvedValue(SMART);
  sendUserOperation.mockReset().mockResolvedValue({
    userOpHash: "0xuserop",
    status: "broadcast",
    smartAccountAddress: SMART.address,
  });
  waitForUserOperation.mockReset().mockResolvedValue({
    status: "complete",
    transactionHash: "0xtxhash",
    userOpHash: "0xuserop",
    smartAccountAddress: SMART.address,
  });
  listTokenBalances.mockReset().mockResolvedValue({
    balances: [
      {
        token: { contractAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", symbol: "ETH" },
        amount: { amount: 1n, decimals: 18 },
      },
    ],
    nextPageToken: undefined,
  });
  sendTransaction.mockReset().mockResolvedValue({ transactionHash: "0xeoa" });
  waitForTransactionReceipt.mockReset().mockResolvedValue({});
  useNetwork.mockReset().mockResolvedValue({
    sendTransaction,
    waitForTransactionReceipt,
  });
});

afterEach(() => {
  delete process.env.STRATEGY_USE_CDP_PAYMASTER;
});

describe("isStrategyPaymasterEnabled", () => {
  it("defaults to false", () => {
    expect(isStrategyPaymasterEnabled()).toBe(false);
  });

  it("is true only when STRATEGY_USE_CDP_PAYMASTER=true", () => {
    process.env.STRATEGY_USE_CDP_PAYMASTER = "true";
    expect(isStrategyPaymasterEnabled()).toBe(true);
  });
});

describe("getOrCreateStrategySmartWallet", () => {
  it("returns EOA address when paymaster is off", async () => {
    const res = await getOrCreateStrategySmartWallet("cp-abc");
    expect(res.walletAddress).toBe(OWNER.address);
    expect(res.ownerAddress).toBe(OWNER.address);
    expect(getOrCreateSmartAccount).not.toHaveBeenCalled();
  });

  it("returns smart account address when paymaster is on", async () => {
    process.env.STRATEGY_USE_CDP_PAYMASTER = "true";
    const res = await getOrCreateStrategySmartWallet("cp-abc123");
    expect(getOrCreateSmartAccount).toHaveBeenCalledWith({
      name: "sa-abc123",
      owner: OWNER,
    });
    expect(res.walletAddress).toBe(SMART.address);
    expect(res.ownerAddress).toBe(OWNER.address);
  });

  it("keeps follower st- wallets on the EOA even when paymaster is on", async () => {
    process.env.STRATEGY_USE_CDP_PAYMASTER = "true";
    const res = await getOrCreateStrategySmartWallet("st-follower");
    expect(getOrCreateSmartAccount).not.toHaveBeenCalled();
    expect(res.walletAddress).toBe(OWNER.address);
  });
});

describe("sendStrategyCalls", () => {
  const calls = [
    {
      to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
      data: "0x095ea7b3" as `0x${string}`,
      value: "0x0" as `0x${string}`,
    },
    {
      to: "0x3333333333333333333333333333333333333333" as `0x${string}`,
      data: "0xdeadbeef" as `0x${string}`,
      value: "0x0" as `0x${string}`,
    },
  ];

  it("falls back to EOA sendCalls when paymaster is off", async () => {
    const res = await sendStrategyCalls({ accountName: "cp-abc", calls });
    expect(sendUserOperation).not.toHaveBeenCalled();
    expect(sendTransaction).toHaveBeenCalled();
    expect(res.hashes.length).toBeGreaterThan(0);
  });

  it("batches into one sponsored user op for cp- wallets when paymaster is on", async () => {
    process.env.STRATEGY_USE_CDP_PAYMASTER = "true";
    const res = await sendStrategyCalls({ accountName: "cp-abc", calls });

    expect(sendUserOperation).toHaveBeenCalledTimes(1);
    const args = sendUserOperation.mock.calls[0][0];
    expect(args.smartAccount).toBe(SMART);
    expect(args.network).toBe("base");
    expect(args.calls).toHaveLength(2);
    expect(args.calls[0].to).toBe(calls[0]!.to);
    expect(args.calls[1].to).toBe(calls[1]!.to);
    // No ETH preflight — listTokenBalances only used by EOA path
    expect(waitForUserOperation).toHaveBeenCalledWith({
      smartAccountAddress: SMART.address,
      userOpHash: "0xuserop",
    });
    expect(res.hashes).toEqual(["0xtxhash"]);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("falls back to EOA path for non-cp account names even with paymaster on", async () => {
    process.env.STRATEGY_USE_CDP_PAYMASTER = "true";
    await sendStrategyCalls({ accountName: "st-follower", calls: [calls[0]!] });
    expect(sendUserOperation).not.toHaveBeenCalled();
    expect(sendTransaction).toHaveBeenCalled();
  });
});
