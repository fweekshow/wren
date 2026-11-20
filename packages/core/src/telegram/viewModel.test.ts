import { describe, expect, it } from "vitest";
import { clampToRails } from "@basemate/shared";

import type { StrategyRow } from "@/discovery/adapters/strategy.adapter.js";
import type { StrategyPnlSnapshot } from "@/discovery/strategy/pnlSync.js";

import { isVisibleStrategy, strategyMode, toCardVM, toListItemVM } from "./viewModel.js";

function row(overrides: Partial<StrategyRow> = {}): StrategyRow {
  return {
    id: "s1",
    name: "Momentum ETH",
    creator_inbox_id: "a".repeat(64),
    creator_wallet: null,
    creator_basename: null,
    prompt: "",
    config: clampToRails({ pairs: ["ETH-USD"], maxLeverage: 5, tradeDirection: "long" }),
    status: "paper",
    execution_wallet_name: null,
    execution_wallet_address: null,
    default_collateral_usdc: 30,
    featured: false,
    realized_pnl_usd: 0,
    high_water_mark_usd: 0,
    trade_count: 0,
    max_drawdown_pct: 0,
    days_live: 0,
    deployed_at: null,
    last_eval_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function snap(overrides: Partial<StrategyPnlSnapshot> = {}): StrategyPnlSnapshot {
  return { realized: 0, unrealized: 0, openCount: 0, closedCount: 0, wins: 0, losses: 0, total: 0, ...overrides };
}

describe("viewModel", () => {
  it("maps paper strategy to paper mode + paper pnl state", () => {
    const vm = toListItemVM(row({ status: "paper" }), snap({ unrealized: 4.5 }));
    expect(vm.mode).toBe("paper");
    expect(vm.pnlState).toBe("paper");
    expect(vm.pnlUsd).toBeCloseTo(4.5, 9);
  });

  it("maps a live open strategy to live_open", () => {
    const vm = toListItemVM(row({ status: "published" }), snap({ openCount: 1, unrealized: 2 }));
    expect(vm.mode).toBe("live");
    expect(vm.pnlState).toBe("live_open");
  });

  it("maps a live strategy with only closed trades to live_closed_final", () => {
    const vm = toListItemVM(row({ status: "testing" }), snap({ closedCount: 3, realized: 12 }));
    expect(vm.pnlState).toBe("live_closed_final");
  });

  it("card carries direction, size, tp/sl and wallet", () => {
    const r = row({ status: "testing", execution_wallet_address: "0x" + "a".repeat(40) });
    const vm = toCardVM(r, snap({ realized: 1 }));
    expect(vm.direction).toBe("long");
    expect(vm.marginUsdc).toBe(30);
    expect(vm.leverage).toBe(5);
    expect(vm.walletAddress).toBeTruthy();
  });

  it("hides draft/archived from lists", () => {
    expect(isVisibleStrategy(row({ status: "draft" }))).toBe(false);
    expect(isVisibleStrategy(row({ status: "archived" }))).toBe(false);
    expect(isVisibleStrategy(row({ status: "paper" }))).toBe(true);
    expect(strategyMode(row({ status: "published" }))).toBe("live");
  });
});
