import { describe, expect, it } from "vitest";
import { clampToRails, type StrategyConfig } from "@basemate/shared";

import {
  evaluateEntryFrequencyGate,
  evaluateEntryRiskGate,
  ENTRY_COOLDOWN_MS,
  LOSS_STREAK_COOLDOWN_MS,
  LOSS_STREAK_LIMIT,
  MAX_ENTRIES_PER_DAY,
  type RiskGateInputs,
} from "./riskGate.js";

function cfg(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return clampToRails({
    pairs: ["ETH-USD"],
    maxLeverage: 5,
    maxNotionalPctEquity: 40,
    dailyDrawdownStopPct: 5,
    defaultCollateralUsdc: 30,
    ...overrides,
  });
}

function inputs(overrides: Partial<RiskGateInputs> = {}): RiskGateInputs {
  return {
    config: cfg(),
    signal: { pair: "ETH-USD", side: "long" },
    collateralUsdc: 30,
    equityUsd: 1000,
    todayRealizedPnlUsd: 0,
    recentClosedTrades: [],
    openPairs: [],
    now: 1_000_000_000_000,
    ...overrides,
  };
}

describe("evaluateEntryRiskGate", () => {
  it("passes a normal entry", () => {
    expect(evaluateEntryRiskGate(inputs())).toEqual({ ok: true, code: "ok" });
  });

  it("blocks the opposite side for a directional strategy", () => {
    const config = cfg({ tradeDirection: "long" });
    const d = evaluateEntryRiskGate(inputs({ config, signal: { pair: "ETH-USD", side: "short" } }));
    expect(d).toMatchObject({ ok: false, code: "direction_mismatch" });
  });

  it("blocks a pair not configured for the strategy", () => {
    const d = evaluateEntryRiskGate(inputs({ signal: { pair: "SOL-USD", side: "long" } }));
    expect(d).toMatchObject({ ok: false, code: "pair_not_configured" });
  });

  it("blocks a duplicate live position on the same pair", () => {
    const d = evaluateEntryRiskGate(inputs({ openPairs: ["ETH-USD"] }));
    expect(d).toMatchObject({ ok: false, code: "duplicate_exposure" });
  });

  it("blocks sub-$100 notional", () => {
    const config = cfg({ maxLeverage: 2 });
    const d = evaluateEntryRiskGate(inputs({ config, collateralUsdc: 10 }));
    expect(d).toMatchObject({ ok: false, code: "min_notional" });
  });

  it("blocks notional over the max-notional-pct-equity cap", () => {
    // 30 collateral * 5x = 150 notional; 40% of 200 equity = 80 → blocked.
    const d = evaluateEntryRiskGate(inputs({ equityUsd: 200 }));
    expect(d).toMatchObject({ ok: false, code: "max_notional_pct_equity" });
  });

  it("blocks when the daily drawdown stop is breached", () => {
    // lost 60 today, current equity 940 → dayStart ~1000 → 6% ≥ 5% stop.
    const d = evaluateEntryRiskGate(inputs({ equityUsd: 940, todayRealizedPnlUsd: -60 }));
    expect(d).toMatchObject({ ok: false, code: "daily_drawdown_stop" });
  });

  it("blocks during a loss-streak cooldown", () => {
    const now = 1_000_000_000_000;
    const recentClosedTrades = Array.from({ length: LOSS_STREAK_LIMIT }, (_, i) => ({
      pnlUsd: -5,
      closedAt: new Date(now - i * 60_000),
    }));
    const d = evaluateEntryRiskGate(inputs({ now, recentClosedTrades }));
    expect(d).toMatchObject({ ok: false, code: "loss_streak_cooldown" });
  });

  it("allows entry once the cooldown has elapsed", () => {
    const now = 1_000_000_000_000;
    const recentClosedTrades = Array.from({ length: LOSS_STREAK_LIMIT }, () => ({
      pnlUsd: -5,
      closedAt: new Date(now - LOSS_STREAK_COOLDOWN_MS - 1),
    }));
    expect(evaluateEntryRiskGate(inputs({ now, recentClosedTrades })).ok).toBe(true);
  });

  it("does not trip the streak when a recent win breaks it", () => {
    const now = 1_000_000_000_000;
    const recentClosedTrades = [
      { pnlUsd: 8, closedAt: new Date(now - 30_000) },
      { pnlUsd: -5, closedAt: new Date(now - 60_000) },
      { pnlUsd: -5, closedAt: new Date(now - 90_000) },
      { pnlUsd: -5, closedAt: new Date(now - 120_000) },
    ];
    expect(evaluateEntryRiskGate(inputs({ now, recentClosedTrades })).ok).toBe(true);
  });

  it("skips equity-relative checks when equity is unknown", () => {
    const d = evaluateEntryRiskGate(inputs({ equityUsd: null, todayRealizedPnlUsd: -500 }));
    expect(d.ok).toBe(true);
  });

  it("blocks during entry cooldown on the same pair", () => {
    const now = 1_000_000_000_000;
    const d = evaluateEntryRiskGate(
      inputs({ now, lastEntryAtMs: now - ENTRY_COOLDOWN_MS + 60_000 }),
    );
    expect(d).toMatchObject({ ok: false, code: "entry_cooldown" });
  });

  it("blocks when max entries per day reached", () => {
    const d = evaluateEntryRiskGate(inputs({ entriesToday: MAX_ENTRIES_PER_DAY }));
    expect(d).toMatchObject({ ok: false, code: "max_entries_per_day" });
  });
});

describe("evaluateEntryFrequencyGate", () => {
  it("blocks duplicate open pair for paper", () => {
    const d = evaluateEntryFrequencyGate({ pair: "ETH-USD", openPairs: ["ETH-USD"] });
    expect(d).toMatchObject({ ok: false, code: "duplicate_exposure" });
  });
});
