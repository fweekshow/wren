import { beforeEach, describe, expect, it, vi } from "vitest";

const getOrCreateUserWallet = vi.fn(async (_name: string) => ({
  address: `0x${"1".repeat(40)}`,
}));
const getOrCreateStrategySmartWallet = vi.fn(async (name: string) => ({
  walletName: name,
  walletAddress: `0x${"2".repeat(40)}`,
  ownerAddress: `0x${"1".repeat(40)}`,
}));
const isCdpEnabled = vi.fn(() => true);
const isStrategyPaymasterEnabled = vi.fn(() => false);
const getExistingExecutionWallet = vi.fn();

vi.mock("@/wallet/cdp.js", () => ({
  getOrCreateUserWallet: (n: string) => getOrCreateUserWallet(n),
  getOrCreateStrategySmartWallet: (n: string) => getOrCreateStrategySmartWallet(n),
  isCdpEnabled: () => isCdpEnabled(),
  isStrategyPaymasterEnabled: () => isStrategyPaymasterEnabled(),
}));

vi.mock("@/discovery/adapters/strategy.adapter.js", () => ({
  StrategyAdapter: { getExistingExecutionWallet: (id: string) => getExistingExecutionWallet(id) },
}));

const { resolveCreatorExecutionWallet, strategyUserWalletName } = await import("./wallet.js");

const XMTP_A = "a".repeat(64);

beforeEach(() => {
  getOrCreateUserWallet.mockClear();
  getOrCreateStrategySmartWallet.mockClear();
  getExistingExecutionWallet.mockReset().mockResolvedValue(null);
  isStrategyPaymasterEnabled.mockReturnValue(false);
  delete process.env.STRATEGY_WALLET_NAME;
});

describe("resolveCreatorExecutionWallet (dual owners)", () => {
  it("derives an isolated cp- wallet for a telegram-native owner", async () => {
    const res = await resolveCreatorExecutionWallet("tg:555");
    expect(res?.walletName).toBe(strategyUserWalletName("telegram", "555"));
    expect(res?.walletName).toMatch(/^cp-/);
  });

  it("derives the xmtp owner's wallet for a raw inbox key", async () => {
    const res = await resolveCreatorExecutionWallet(XMTP_A);
    // xmtp path checks for an existing reused wallet first (none here), then derives.
    expect(getExistingExecutionWallet).toHaveBeenCalledWith(XMTP_A);
    expect(res?.walletName).toBe(strategyUserWalletName("xmtp", XMTP_A));
  });

  it("gives different owners different wallets (isolation)", async () => {
    const a = await resolveCreatorExecutionWallet("tg:111");
    const b = await resolveCreatorExecutionWallet("tg:222");
    expect(a?.walletName).not.toBe(b?.walletName);
  });

  it("returns null (fails safe) on an unrecognized owner key", async () => {
    expect(await resolveCreatorExecutionWallet("garbage")).toBeNull();
  });

  it("returns smart account address when paymaster is enabled", async () => {
    isStrategyPaymasterEnabled.mockReturnValue(true);
    const res = await resolveCreatorExecutionWallet("tg:555");
    expect(getOrCreateStrategySmartWallet).toHaveBeenCalled();
    expect(res?.walletAddress).toBe(`0x${"2".repeat(40)}`);
    expect(getOrCreateUserWallet).not.toHaveBeenCalled();
  });

  it("re-resolves xmtp cached EOA to smart account when paymaster is on", async () => {
    isStrategyPaymasterEnabled.mockReturnValue(true);
    const walletName = strategyUserWalletName("xmtp", XMTP_A);
    getExistingExecutionWallet.mockResolvedValue({
      walletName,
      walletAddress: "0x7284221CEc9738549df818157e77613b3cf64714",
    });
    const res = await resolveCreatorExecutionWallet(XMTP_A);
    expect(getOrCreateStrategySmartWallet).toHaveBeenCalledWith(walletName);
    expect(res?.walletAddress).not.toBe("0x7284221CEc9738549df818157e77613b3cf64714");
  });
});
