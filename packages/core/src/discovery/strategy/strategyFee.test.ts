import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData } from "viem";

const sendStrategyCallsMock = vi.fn();
const getBalancesMock = vi.fn();

vi.mock("@/wallet/cdp.js", () => ({
  sendStrategyCalls: (args: unknown) => sendStrategyCallsMock(args),
  getBalances: (addr: string) => getBalancesMock(addr),
  BASE_USDC_ADDRESS: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
}));

const adapter = {
  getById: vi.fn(),
  getHighWaterMark: vi.fn(),
  setHighWaterMark: vi.fn(),
  recordFeeSettlement: vi.fn(),
  setRealizedPnl: vi.fn(),
  getReconciledRealizedPnlUsd: vi.fn(),
};

vi.mock("@/discovery/adapters/strategy.adapter.js", () => ({
  StrategyAdapter: adapter,
}));

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { computeProfitFee, applyPaperProfitFee, settleCreatorStrategyProfitFee } = await import(
  "./strategyFee.js"
);

const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const FEE_WALLET = "0x4a7eF13b4D7456bAAa219c26765702880a1303FD";
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

function baseStrategy(overrides: Record<string, unknown> = {}) {
  return {
    id: "11de7fac-0000-0000-0000-000000000000",
    execution_wallet_name: "cp-abc",
    execution_wallet_address: "0x1111111111111111111111111111111111111111",
    realized_pnl_usd: 0,
    ...overrides,
  };
}

function usdcBalance(amountRaw: bigint) {
  return [{ symbol: "USDC", contractAddress: BASE_USDC, amount: amountRaw, decimals: 6, formatted: "x" }];
}

describe("computeProfitFee (HWM math)", () => {
  it("charges 10% of the first all-time-high profit", () => {
    const f = computeProfitFee(0, 100);
    expect(f.newHwm).toBe(100);
    expect(f.incrementalProfit).toBe(100);
    expect(f.feeUsd).toBeCloseTo(10, 9);
  });

  it("charges nothing during drawdown and recovery below the HWM", () => {
    expect(computeProfitFee(100, 20).feeUsd).toBe(0); // drawdown
    expect(computeProfitFee(100, 80).feeUsd).toBe(0); // partial recovery
    expect(computeProfitFee(100, 100).feeUsd).toBe(0); // back to mark exactly
  });

  it("only charges the increment above the previous mark", () => {
    const f = computeProfitFee(100, 120);
    expect(f.incrementalProfit).toBe(20);
    expect(f.feeUsd).toBeCloseTo(2, 9);
    expect(f.newHwm).toBe(120);
  });

  it("never charges a strategy that has only ever lost", () => {
    const f = computeProfitFee(0, -50);
    expect(f.newHwm).toBe(0); // HWM floored at the prior 0, never negative
    expect(f.incrementalProfit).toBe(0);
    expect(f.feeUsd).toBe(0);
  });

  it("totals exactly 10% of net profit across a +100/-80/+60/+40 sequence", () => {
    // cumulative realized PnL after each close
    const cumulative = [100, 20, 80, 120];
    let hwm = 0;
    let totalFee = 0;
    for (const realized of cumulative) {
      const f = computeProfitFee(hwm, realized);
      totalFee += f.feeUsd;
      hwm = f.newHwm;
    }
    expect(totalFee).toBeCloseTo(12, 9); // 10 + 0 + 0 + 2
    expect(totalFee).toBeCloseTo(0.1 * 120, 9); // 10% of net profit
    expect(hwm).toBe(120);
  });
});

describe("settleCreatorStrategyProfitFee (live)", () => {
  beforeEach(() => {
    sendStrategyCallsMock.mockReset().mockResolvedValue({ hashes: ["0xfeehash"] });
    getBalancesMock.mockReset().mockResolvedValue(usdcBalance(1_000_000000n));
    adapter.getById.mockReset();
    adapter.getHighWaterMark.mockReset();
    adapter.setHighWaterMark.mockReset().mockResolvedValue(undefined);
    adapter.recordFeeSettlement.mockReset().mockResolvedValue(undefined);
    adapter.setRealizedPnl.mockReset().mockResolvedValue(undefined);
    // Fee is now based on reconciled realized PnL. Default to the same $100 the
    // live tests use; the fee-finality test overrides this to prove unreconciled
    // PnL is ignored.
    adapter.getReconciledRealizedPnlUsd.mockReset().mockResolvedValue(100);
    process.env.VIBE_TRADING_FEE_WALLET = FEE_WALLET;
  });

  it("transfers 10% of new profit, bumps HWM, and records the settlement", async () => {
    adapter.getById.mockResolvedValue(baseStrategy({ realized_pnl_usd: 100 }));
    adapter.getHighWaterMark.mockResolvedValue(0);

    const result = await settleCreatorStrategyProfitFee("11de7fac-0000-0000-0000-000000000000");

    expect(result.status).toBe("settled");
    expect(result.feeUsd).toBeCloseTo(10, 9);
    expect(result.txHash).toBe("0xfeehash");

    expect(sendStrategyCallsMock).toHaveBeenCalledTimes(1);
    const sent = sendStrategyCallsMock.mock.calls[0][0];
    expect(sent.accountName).toBe("cp-abc");
    expect(sent.calls).toHaveLength(1);
    expect(sent.calls[0].to.toLowerCase()).toBe(BASE_USDC);
    const decoded = decodeFunctionData({ abi: TRANSFER_ABI, data: sent.calls[0].data });
    expect((decoded.args?.[0] as string).toLowerCase()).toBe(FEE_WALLET.toLowerCase());
    expect(decoded.args?.[1]).toBe(10_000000n); // $10 USDC, 6 decimals

    expect(adapter.setHighWaterMark).toHaveBeenCalledWith(
      "11de7fac-0000-0000-0000-000000000000",
      100,
    );
    expect(adapter.recordFeeSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ feeUsd: expect.closeTo(10, 6), profitIncrementUsd: 100, hwmAfter: 100, txHash: "0xfeehash" }),
    );
  });

  it("is idempotent — no transfer when realized PnL hasn't passed the HWM", async () => {
    adapter.getById.mockResolvedValue(baseStrategy({ realized_pnl_usd: 100 }));
    adapter.getHighWaterMark.mockResolvedValue(100);

    const result = await settleCreatorStrategyProfitFee("s");

    expect(result.status).toBe("skipped");
    expect(sendStrategyCallsMock).not.toHaveBeenCalled();
    expect(adapter.setHighWaterMark).not.toHaveBeenCalled();
  });

  it("defers (no transfer, HWM unchanged) when the wallet can't cover the fee", async () => {
    adapter.getById.mockResolvedValue(baseStrategy({ realized_pnl_usd: 100 }));
    adapter.getHighWaterMark.mockResolvedValue(0);
    getBalancesMock.mockResolvedValue(usdcBalance(5_000000n)); // $5 < $10 fee

    const result = await settleCreatorStrategyProfitFee("s");

    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/insufficient/i);
    expect(sendStrategyCallsMock).not.toHaveBeenCalled();
    expect(adapter.setHighWaterMark).not.toHaveBeenCalled();
  });

  it("advances the HWM before the transfer so a reverted send never double-charges", async () => {
    // HWM is advanced FIRST (idempotency guard). If the on-chain transfer then
    // reverts, the HWM is already committed so the next tick sees no new increment
    // and skips — preventing the same fee from being charged twice.
    adapter.getById.mockResolvedValue(baseStrategy({ realized_pnl_usd: 100 }));
    adapter.getHighWaterMark.mockResolvedValue(0);
    sendStrategyCallsMock.mockRejectedValue(new Error("custodial wallet has no ETH for gas"));

    const result = await settleCreatorStrategyProfitFee("s");

    expect(result.status).toBe("failed");
    // HWM IS advanced even though the transfer failed — this is the fix.
    expect(adapter.setHighWaterMark).toHaveBeenCalledWith("s", 100);
    // Settlement record is NOT written (no confirmed tx hash).
    expect(adapter.recordFeeSettlement).not.toHaveBeenCalled();
  });

  it("skips when the fee wallet is unset (opens still work, close fee waits)", async () => {
    delete process.env.VIBE_TRADING_FEE_WALLET;
    adapter.getById.mockResolvedValue(baseStrategy({ realized_pnl_usd: 100 }));
    adapter.getHighWaterMark.mockResolvedValue(0);

    const result = await settleCreatorStrategyProfitFee("s");

    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/fee wallet/i);
    expect(sendStrategyCallsMock).not.toHaveBeenCalled();
  });

  it("skips a strategy with no execution wallet", async () => {
    adapter.getById.mockResolvedValue(baseStrategy({ execution_wallet_name: null }));
    adapter.getHighWaterMark.mockResolvedValue(0);

    const result = await settleCreatorStrategyProfitFee("s");

    expect(result.status).toBe("skipped");
    expect(adapter.getHighWaterMark).not.toHaveBeenCalled();
  });

  it("fee-finality: never charges on unreconciled PnL", async () => {
    // realized_pnl_usd shows +100 profit, but nothing is reconciled yet →
    // the HWM must NOT advance and no transfer may happen.
    adapter.getById.mockResolvedValue(baseStrategy({ realized_pnl_usd: 100 }));
    adapter.getHighWaterMark.mockResolvedValue(0);
    adapter.getReconciledRealizedPnlUsd.mockResolvedValue(0);

    const result = await settleCreatorStrategyProfitFee("s");

    expect(result.status).toBe("skipped");
    expect(sendStrategyCallsMock).not.toHaveBeenCalled();
    expect(adapter.setHighWaterMark).not.toHaveBeenCalled();
  });
});

describe("applyPaperProfitFee (paper parity)", () => {
  beforeEach(() => {
    adapter.getById.mockReset();
    adapter.getHighWaterMark.mockReset();
    adapter.setHighWaterMark.mockReset().mockResolvedValue(undefined);
    adapter.setRealizedPnl.mockReset().mockResolvedValue(undefined);
  });

  it("rewrites realized PnL net-of-fee across the worked example, ending at 108 / HWM 120", async () => {
    // Simulate the StrategyRunner loop: recompute sets gross, then we apply the fee.
    const grossSequence = [100, 20, 80, 120];
    const expectedNet = [90, 10, 70, 108];
    let hwm = 0;

    for (let i = 0; i < grossSequence.length; i++) {
      adapter.getById.mockResolvedValue(baseStrategy({ realized_pnl_usd: grossSequence[i] }));
      adapter.getHighWaterMark.mockResolvedValue(hwm);
      adapter.setHighWaterMark.mockImplementation(async (_id: string, v: number) => {
        hwm = v;
      });

      await applyPaperProfitFee("s");

      const wrote = adapter.setRealizedPnl.mock.calls.at(-1)?.[1] as number;
      expect(wrote).toBeCloseTo(expectedNet[i], 6);
    }
    expect(hwm).toBe(120);
  });

  it("does nothing for a strategy that has never been in profit", async () => {
    adapter.getById.mockResolvedValue(baseStrategy({ realized_pnl_usd: -40 }));
    adapter.getHighWaterMark.mockResolvedValue(0);

    await applyPaperProfitFee("s");

    expect(adapter.setRealizedPnl).not.toHaveBeenCalled();
    expect(adapter.setHighWaterMark).not.toHaveBeenCalled();
  });
});
