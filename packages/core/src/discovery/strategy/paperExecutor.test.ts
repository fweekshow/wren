import { beforeEach, describe, expect, it, vi } from "vitest";

const adapter = {
  listOpenPaperTrades: vi.fn(),
  closeTrade: vi.fn(),
  setWikiDirty: vi.fn(),
  recomputeRealizedPnl: vi.fn(),
  updateTradeUnrealized: vi.fn(),
  recordPaperTrade: vi.fn(),
};

vi.mock("@/discovery/adapters/strategy.adapter.js", () => ({
  StrategyAdapter: adapter,
}));

vi.mock("@/discovery/strategy/strategyFee.js", () => ({
  applyPaperProfitFee: vi.fn(),
}));

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { runPaperStrategyTick } = await import("./paperExecutor.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runPaperStrategyTick", () => {
  it("does not open or manage paper trades", async () => {
    adapter.listOpenPaperTrades.mockResolvedValue([
      { id: "t1", pair: "ETH-USD", side: "long", collateral_usdc: 100, leverage: 5, open_price: 3000 },
    ]);

    await runPaperStrategyTick({
      row: { id: "d1d5e725", config: { maxLeverage: 10, pairs: ["ETH-USD"] } } as never,
      pair: "ETH-USD",
      mark: 2009.93037943,
      signal: {
        pair: "ETH-USD",
        side: "long",
        mode: "superburst",
        reason: "burst",
        confidence: 0.7,
        regime: "SUPERBURST",
      },
    });

    expect(adapter.recordPaperTrade).not.toHaveBeenCalled();
    expect(adapter.closeTrade).not.toHaveBeenCalled();
    expect(adapter.updateTradeUnrealized).not.toHaveBeenCalled();
  });
});
