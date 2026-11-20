import { beforeEach, describe, expect, it, vi } from "vitest";

const adapter = {
  getById: vi.fn(),
  countByCreatorStatuses: vi.fn(),
  countTodayEntries: vi.fn(() => Promise.resolve(0)),
  listOpenPaperTrades: vi.fn(() => Promise.resolve([])),
  updateStatus: vi.fn(),
  markDeployed: vi.fn(),
};

vi.mock("@/discovery/adapters/strategy.adapter.js", () => ({
  StrategyAdapter: adapter,
}));

vi.mock("@/discovery/adapters/strategySubscription.adapter.js", () => ({
  StrategySubscriptionAdapter: { listByStrategy: vi.fn() },
}));

vi.mock("@basemate/avantis-client", () => ({
  fetchAvantisMarkPrice: vi.fn(),
  fetchAvantisUserData: vi.fn(),
  isAvantisLive: vi.fn(() => true),
}));

vi.mock("@basemate/shared", () => ({
  hasOrderbookOnlyModes: vi.fn(() => false),
  minStrategyCollateralUsdc: vi.fn(() => 25),
  oracleExecutableModes: vi.fn(() => []),
}));

vi.mock("@/infra/queues/base.js", () => ({
  startPollerJob: vi.fn(),
}));

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./allowlist.js", () => ({
  isMultiStrategyAllowed: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("./executor.js", () => ({
  executeStrategySignal: vi.fn(),
}));

vi.mock("./paperExecutor.js", () => ({
  closeAllPaperTrades: vi.fn(),
  runPaperStrategyTick: vi.fn(),
}));

vi.mock("./priceHistory.js", () => ({
  pushMarkSample: vi.fn(),
}));

vi.mock("./publishGate.js", () => ({
  checkPublishGate: vi.fn(),
}));

vi.mock("./signals.js", () => ({
  ORACLE_MIN_SAMPLES: 12,
  evaluateOracleSignals: vi.fn(),
  smokeTestEntrySignal: vi.fn(),
  directionAllows: vi.fn(() => true),
}));

vi.mock("./wallet.js", () => ({
  resolveCreatorExecutionWallet: vi.fn(),
}));

vi.mock("./pnlSync.js", () => ({
  syncStrategyWalletPnl: vi.fn(),
}));

vi.mock("./strategyExecNotify.js", () => ({
  clearExecFailureNotice: vi.fn(),
  maybeNotifyExecFailure: vi.fn(),
}));

const { deployPaperStrategy, deployStrategy, promotePaperToLive } = await import("./runner.js");
const { LIVE_TRADING_PAUSED_MESSAGE } = await import("./liveTrading.js");

function strategyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    creator_inbox_id: "inbox1",
    creator_wallet: "0x1111111111111111111111111111111111111111",
    creator_basename: null,
    status: "draft",
    deployed_at: null,
    config: {
      maxLeverage: 5,
      defaultCollateralUsdc: 25,
      pairs: ["ETH-USD"],
    },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.STRATEGY_LIVE_TRADING_ENABLED;
});

describe("live trading pause", () => {
  it("blocks live strategy deployment by default", async () => {
    const result = await deployStrategy("s1", "inbox1");

    expect(result).toEqual({ ok: false, error: LIVE_TRADING_PAUSED_MESSAGE });
    expect(adapter.getById).not.toHaveBeenCalled();
  });

  it("blocks paper promotion before settling paper trades", async () => {
    const result = await promotePaperToLive("s1", "inbox1");

    expect(result).toEqual({ ok: false, error: LIVE_TRADING_PAUSED_MESSAGE });
    expect(adapter.getById).not.toHaveBeenCalled();
  });

  it("refuses paper deployment", async () => {
    const result = await deployPaperStrategy("s1", "inbox1");

    expect(result.ok).toBe(false);
    expect(adapter.updateStatus).not.toHaveBeenCalled();
    expect(adapter.markDeployed).not.toHaveBeenCalled();
  });
});
