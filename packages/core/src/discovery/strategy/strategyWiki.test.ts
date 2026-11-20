import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();
const { finalizeMock } = vi.hoisted(() => ({ finalizeMock: vi.fn() }));

const adapter = {
  getById: vi.fn(),
  listClosedTrades: vi.fn(),
  getLatestWiki: vi.fn(),
  appendWiki: vi.fn(),
  listWikiDirtyStrategyIds: vi.fn(),
  setWikiDirty: vi.fn(),
};

vi.mock("@/discovery/adapters/strategy.adapter.js", () => ({
  StrategyAdapter: adapter,
}));

vi.mock("@/llm/config.js", () => ({
  createBankrLlmClient: () => ({ chat: { completions: { create: createMock } } }),
  logLlmTurn: vi.fn(),
  providerForModel: () => "bankr",
}));

vi.mock("@/discovery/strategy/brain.js", () => ({
  buildStrategyAuthorSystemPromptV2: async () => "SYSTEM",
}));

vi.mock("@/discovery/strategy/promptStrategy.js", () => ({
  STRATEGY_AUTHOR_MODEL: "claude-test",
  formatStrategySpec: () => "SPEC",
  alignExplanationToConfig: (_c: unknown, e: string) => e || "aligned",
  tryParseAuthorJson: (raw: string) => JSON.parse(raw),
  finalizeStrategyConfig: (prompt: string, cfg: unknown) => finalizeMock(prompt, cfg),
  // Minimal stand-in: extract an explicit "$N" margin / "Nx" leverage from feedback.
  parseStrategyPromptHints: (text: string) => {
    const out: { defaultCollateralUsdc?: number; maxLeverage?: number } = {};
    const dollar = /\$([0-9]+(?:\.[0-9]+)?)/.exec(text);
    if (dollar) out.defaultCollateralUsdc = Number(dollar[1]);
    const lev = /\b([0-9]+(?:\.[0-9]+)?)\s*x\b/i.exec(text);
    if (lev) out.maxLeverage = Number(lev[1]);
    return out;
  },
}));

vi.mock("@/xmtp/core/markdownSanitize.js", () => ({
  sanitizeXmptMarkdown: (s: string) => s,
}));

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  detectLossStreak,
  buildTradeAnalysis,
  compileTradeToWiki,
  improveStrategyFromWiki,
  maybeNotifyLossStreak,
  setLossStreakNotifier,
  StrategyWikiWorker,
} = await import("./strategyWiki.js");

function strategy(overrides: Record<string, unknown> = {}) {
  return {
    id: "11de7fac-0000-0000-0000-000000000000",
    name: "Test Strat",
    prompt: "scalp eth",
    creator_inbox_id: "inbox1",
    creator_wallet: "0xabc",
    config: { maxLeverage: 10, pairs: ["ETH-USD"], enabledStrategies: ["superburst"] },
    trade_count: 4,
  };
}

function trade(pnl: number, overrides: Record<string, unknown> = {}) {
  return {
    pair: "ETH-USD",
    side: "long",
    mode: "superburst",
    pnl_usd: pnl,
    collateral_usdc: 100,
    open_price: 3000,
    close_price: 2990,
    exit_reason: pnl >= 0 ? "tp" : "sl",
    entry_regime: "TREND_UP",
    duration_s: 120,
    max_favorable_move_pct: 0.3,
    max_adverse_move_pct: 0.5,
    is_paper: true,
    created_at: new Date(),
    closed_at: new Date(),
    ...overrides,
  };
}

function modelResponse(obj: unknown) {
  return { choices: [{ message: { content: JSON.stringify(obj) } }], usage: {} };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: finalize echoes whatever config it's handed (lets us assert merge args).
  finalizeMock.mockImplementation(async (_prompt: string, cfg: unknown) => ({ config: cfg }));
});

describe("detectLossStreak", () => {
  it("returns false below threshold", () => {
    expect(detectLossStreak([trade(-1), trade(-1)], 3)).toBe(false);
  });

  it("returns true on N consecutive losses", () => {
    expect(detectLossStreak([trade(-1), trade(-2), trade(-3)], 3)).toBe(true);
  });

  it("returns false when a win breaks the streak", () => {
    expect(detectLossStreak([trade(-1), trade(2), trade(-3)], 3)).toBe(false);
  });
});

describe("buildTradeAnalysis", () => {
  it("returns the compiled wiki when present", async () => {
    adapter.getLatestWiki.mockResolvedValue("## Performance Summary\nlooking good");
    const out = await buildTradeAnalysis("s1");
    expect(out).toContain("Performance Summary");
    expect(adapter.listClosedTrades).not.toHaveBeenCalled();
  });

  it("falls back to raw aggregation when no wiki exists", async () => {
    adapter.getLatestWiki.mockResolvedValue(null);
    adapter.listClosedTrades.mockResolvedValue([trade(-1), trade(2), trade(-3)]);
    const out = await buildTradeAnalysis("s1");
    expect(out).toContain("wiki not yet compiled");
    expect(out).toContain("superburst");
  });

  it("handles no closed trades", async () => {
    adapter.getLatestWiki.mockResolvedValue(null);
    adapter.listClosedTrades.mockResolvedValue([]);
    const out = await buildTradeAnalysis("s1");
    expect(out).toContain("nothing to analyze");
  });
});

describe("compileTradeToWiki", () => {
  it("appends compiled wiki on success", async () => {
    adapter.getById.mockResolvedValue(strategy());
    adapter.listClosedTrades.mockResolvedValue([trade(-1), trade(2)]);
    adapter.getLatestWiki.mockResolvedValue(null);
    createMock.mockResolvedValue({ choices: [{ message: { content: "## Performance Summary\nok" } }], usage: {} });

    const ok = await compileTradeToWiki("s1");
    expect(ok).toBe(true);
    expect(adapter.appendWiki).toHaveBeenCalledWith("s1", "## Performance Summary\nok");
  });

  it("returns false (no append) when there are no closed trades", async () => {
    adapter.getById.mockResolvedValue(strategy());
    adapter.listClosedTrades.mockResolvedValue([]);
    const ok = await compileTradeToWiki("s1");
    expect(ok).toBe(false);
    expect(adapter.appendWiki).not.toHaveBeenCalled();
  });

  it("returns false on LLM failure without throwing", async () => {
    adapter.getById.mockResolvedValue(strategy());
    adapter.listClosedTrades.mockResolvedValue([trade(-1)]);
    adapter.getLatestWiki.mockResolvedValue(null);
    createMock.mockRejectedValue(new Error("rate limit"));
    const ok = await compileTradeToWiki("s1");
    expect(ok).toBe(false);
    expect(adapter.appendWiki).not.toHaveBeenCalled();
  });
});

describe("improveStrategyFromWiki", () => {
  it("returns a diagnosis but KEEPS the original name (Improve never renames)", async () => {
    createMock.mockResolvedValue(
      modelResponse({
        name: "Tighter Eth",
        config: { maxLeverage: 8, pairs: ["ETH-USD"], enabledStrategies: ["breakout_continuation"] },
        explanation: "tightened up",
        diagnosis: "superburst lost 3x in TREND — removed it",
      }),
    );
    const { authored, diagnosis } = await improveStrategyFromWiki(
      strategy() as never,
      "## Failure Patterns\nsuperburst losing",
    );
    expect(diagnosis).toContain("superburst");
    // Improve tunes the SAME strategy — the model's proposed rename is ignored.
    expect(authored.name).toBe("Test Strat");
  });

  it("preserves the user's leverage even when the model proposes a different one", async () => {
    createMock.mockResolvedValue(
      modelResponse({
        config: { maxLeverage: 8, enabledStrategies: ["breakout_continuation"] },
        diagnosis: "dropped a dead mode",
      }),
    );
    await improveStrategyFromWiki(strategy() as never, "wiki");
    // strategy()'s leverage is 10 — the model's 8 must NOT override it.
    expect(finalizeMock).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ maxLeverage: 10 }),
    );
  });

  it("HONORS explicit sizing in the user's Remix direction (e.g. 'increase the margin to $10')", async () => {
    createMock.mockResolvedValue(
      modelResponse({ config: { tpPercent: 1.2 }, diagnosis: "widened tp" }),
    );
    await improveStrategyFromWiki(strategy() as never, "wiki", "increase the margin to $10");
    expect(finalizeMock).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ defaultCollateralUsdc: 10 }),
    );
  });

  it("falls back gracefully on LLM failure", async () => {
    createMock.mockRejectedValue(new Error("boom"));
    const { authored, diagnosis } = await improveStrategyFromWiki(strategy() as never, "wiki");
    expect(authored.name).toBe("Test Strat");
    expect(diagnosis).toContain("hiccup");
  });

  it("base-merges a PARTIAL model config onto the existing config (P1-1)", async () => {
    // Model returns only a TP tweak — must NOT drop the strategy's modes/pairs.
    createMock.mockResolvedValue(
      modelResponse({ name: "Tweaked", config: { tpPercent: 1.5 }, diagnosis: "tightened tp" }),
    );
    await improveStrategyFromWiki(strategy() as never, "wiki");
    // finalize must be called with existing config fields preserved + the tweak applied,
    // and with an EMPTY prompt so the original prompt's "scalp" hint can't clobber the
    // improved modes (which would make the applied config contradict the diagnosis).
    expect(finalizeMock).toHaveBeenCalledWith(
      "",
      expect.objectContaining({
        maxLeverage: 10,
        pairs: ["ETH-USD"],
        enabledStrategies: ["superburst"],
        tpPercent: 1.5,
      }),
    );
  });
});

describe("maybeNotifyLossStreak (dedupe — P1-2)", () => {
  const notifier = vi.fn();

  beforeEach(() => {
    notifier.mockReset();
    setLossStreakNotifier(notifier);
  });

  it("notifies once when a streak is entered, with the REAL streak length", async () => {
    adapter.getById.mockResolvedValue(strategy());
    adapter.listClosedTrades.mockResolvedValue([trade(-1), trade(-2), trade(-3), trade(5)]);
    await maybeNotifyLossStreak("s1");
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier.mock.calls[0][0].losses).toBe(3);
  });

  it("does NOT re-fire as the same streak grows (4th, 5th loss)", async () => {
    adapter.getById.mockResolvedValue(strategy());
    adapter.listClosedTrades.mockResolvedValue([trade(-1), trade(-2), trade(-3)]);
    await maybeNotifyLossStreak("s2");
    adapter.listClosedTrades.mockResolvedValue([trade(-1), trade(-2), trade(-3), trade(-4)]);
    await maybeNotifyLossStreak("s2");
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  it("re-arms after a win breaks the streak, then notifies on a fresh streak", async () => {
    adapter.getById.mockResolvedValue(strategy());
    adapter.listClosedTrades.mockResolvedValue([trade(-1), trade(-2), trade(-3)]);
    await maybeNotifyLossStreak("s3"); // notify #1
    adapter.listClosedTrades.mockResolvedValue([trade(9), trade(-2), trade(-3)]); // win on top → streak broken
    await maybeNotifyLossStreak("s3"); // re-arm, no notify
    adapter.listClosedTrades.mockResolvedValue([trade(-7), trade(-8), trade(-9), trade(9)]); // fresh streak
    await maybeNotifyLossStreak("s3"); // notify #2
    expect(notifier).toHaveBeenCalledTimes(2);
  });

  it("does not notify below threshold", async () => {
    adapter.getById.mockResolvedValue(strategy());
    adapter.listClosedTrades.mockResolvedValue([trade(-1), trade(-2), trade(5)]);
    await maybeNotifyLossStreak("s4");
    expect(notifier).not.toHaveBeenCalled();
  });
});

describe("StrategyWikiWorker", () => {
  it("compiles dirty strategies and clears the flag on success", async () => {
    adapter.listWikiDirtyStrategyIds.mockResolvedValue(["s1"]);
    adapter.getById.mockResolvedValue(strategy());
    adapter.listClosedTrades.mockResolvedValue([trade(-1)]);
    adapter.getLatestWiki.mockResolvedValue(null);
    createMock.mockResolvedValue({ choices: [{ message: { content: "## wiki" } }], usage: {} });

    const worker = new StrategyWikiWorker();
    await (worker as unknown as { tick: () => Promise<void> }).tick();

    expect(adapter.setWikiDirty).toHaveBeenCalledWith("s1", false);
  });

  it("restores the dirty flag when compile fails", async () => {
    adapter.listWikiDirtyStrategyIds.mockResolvedValue(["s1"]);
    adapter.getById.mockResolvedValue(strategy());
    adapter.listClosedTrades.mockResolvedValue([trade(-1)]);
    adapter.getLatestWiki.mockResolvedValue(null);
    createMock.mockRejectedValue(new Error("llm down"));

    const worker = new StrategyWikiWorker();
    await (worker as unknown as { tick: () => Promise<void> }).tick();

    // clear-before-compile then restore-on-failure
    expect(adapter.setWikiDirty).toHaveBeenCalledWith("s1", true);
  });

  it("does nothing when no strategies are dirty", async () => {
    adapter.listWikiDirtyStrategyIds.mockResolvedValue([]);
    const worker = new StrategyWikiWorker();
    await (worker as unknown as { tick: () => Promise<void> }).tick();
    expect(adapter.getById).not.toHaveBeenCalled();
  });
});
