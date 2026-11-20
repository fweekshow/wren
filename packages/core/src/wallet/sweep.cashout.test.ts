import { beforeEach, describe, expect, it, vi } from "vitest";

const sendCallsMock = vi.fn();
const getBalancesMock = vi.fn();

vi.mock("@/wallet/cdp.js", () => ({
  sendCalls: (args: unknown) => sendCallsMock(args),
  getBalances: (addr: string) => getBalancesMock(addr),
  BASE_USDC_ADDRESS: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
}));

// Sweep imports these for the full-sweep path; cashout never calls them, but the
// module graph still loads them — stub to avoid pulling in DB/network at import.
vi.mock("@/copy-trading/adapters/copyStrategy.adapter.js", () => ({
  CopyStrategyAdapter: { listForUser: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@/discovery/adapters/wallet.adapter.js", () => ({
  WalletAdapter: { findBySenderId: vi.fn().mockResolvedValue(null) },
}));
vi.mock("@/discovery/services/avantisClose.service.js", () => ({
  buildAvantisCloseCallsForWallet: vi.fn().mockResolvedValue({ calls: [] }),
}));
vi.mock("@/discovery/services/yieldRedeem.service.js", () => ({
  buildMoonwellRedeemAllCalls: vi.fn().mockResolvedValue({ calls: [] }),
  buildMorphoRedeemAllCalls: vi.fn().mockResolvedValue({ calls: [] }),
}));
vi.mock("@/discovery/strategy/wallet.js", () => ({
  resolveBasemateServerWallet: vi.fn().mockResolvedValue(null),
}));

const { cashoutLiquidFromWallet } = await import("./sweep.js");

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const NATIVE_ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TARGET = {
  label: "Basemate wallet",
  accountName: "cp-abc",
  address: "0x1111111111111111111111111111111111111111",
};
const DESTINATION = "0x2222222222222222222222222222222222222222";

beforeEach(() => {
  sendCallsMock.mockReset();
  getBalancesMock.mockReset();
  sendCallsMock.mockResolvedValue({ hashes: ["0xhash"] });
});

describe("cashoutLiquidFromWallet", () => {
  it("sends liquid USDC + ETH above gas reserve, no perp/vault closes", async () => {
    getBalancesMock.mockResolvedValue([
      { symbol: "USDC", contractAddress: USDC, amount: 42_500000n, decimals: 6, formatted: "42.5" },
      { symbol: "ETH", contractAddress: NATIVE_ETH, amount: 5_000_000_000_000_000n, decimals: 18, formatted: "0.005" },
    ]);

    const result = await cashoutLiquidFromWallet({ target: TARGET, destination: DESTINATION });

    const phases = Object.fromEntries(result.phases.map((p) => [p.phase, p.status]));
    expect(phases.tokens).toBe("sent");
    expect(phases.eth).toBe("sent");
    expect(result.phases.some((p) => p.phase === "perps")).toBe(false);
    expect(result.phases.some((p) => p.phase === "vaults")).toBe(false);
    // tokens phase + eth phase = 2 sendCalls invocations
    expect(sendCallsMock).toHaveBeenCalledTimes(2);
  });

  it("skips both phases when nothing is liquid (zero balance)", async () => {
    getBalancesMock.mockResolvedValue([]);

    const result = await cashoutLiquidFromWallet({ target: TARGET, destination: DESTINATION });

    expect(result.phases.every((p) => p.status === "skipped")).toBe(true);
    expect(sendCallsMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid destination", async () => {
    await expect(
      cashoutLiquidFromWallet({ target: TARGET, destination: "not-an-address" }),
    ).rejects.toThrow(/invalid cashout destination/);
  });
});
