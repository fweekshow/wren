import { describe, expect, it } from "vitest";

import { patchStrategyFromPrompt } from "./strategyPatch.js";
import type { StrategyRow } from "@/discovery/adapters/strategy.adapter.js";
import { clampToRails } from "@basemate/shared";

function mockRow(configOverrides = {}): StrategyRow {
  const config = clampToRails(configOverrides);
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "test",
    status: "paper",
    creator_inbox_id: "tg:1",
    creator_wallet: null,
    creator_basename: null,
    config,
    execution_wallet_name: null,
    execution_wallet_address: null,
    default_collateral_usdc: config.defaultCollateralUsdc,
    trade_count: 0,
    realized_pnl_usd: 0,
    featured: false,
    deployed_at: null,
    last_eval_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

describe("patchStrategyFromPrompt", () => {
  it("merges TP/SL from user text with 0 trades", async () => {
    const row = mockRow({ tpPercent: 1, slPercent: 0.5 });
    const result = await patchStrategyFromPrompt(row, "2% tp 1% sl");
    expect(result.ok).toBe(true);
    expect(result.config?.tpPercent).toBe(2);
    expect(result.config?.slPercent).toBe(1);
  });

  it("rejects empty parse", async () => {
    const row = mockRow();
    const result = await patchStrategyFromPrompt(row, "hello there");
    expect(result.ok).toBe(false);
  });

  it("tightens SL from natural language", async () => {
    const row = mockRow({ tpPercent: 1.2, slPercent: 0.6, maxLeverage: 50 });
    const result = await patchStrategyFromPrompt(row, "tighten SL");
    expect(result.ok).toBe(true);
    expect(result.config?.slPercent).toBeCloseTo(0.45, 4);
    expect(result.config?.tpPercent).toBeCloseTo(1.2, 4);
    expect(result.summary).toMatch(/SL:/);
  });

  it("widens TP from natural language", async () => {
    const row = mockRow({ tpPercent: 1, slPercent: 0.5 });
    const result = await patchStrategyFromPrompt(row, "widen TP");
    expect(result.ok).toBe(true);
    expect(result.config?.tpPercent).toBeCloseTo(1.25, 4);
  });

  it("explicit percent beats relative hint when both present", async () => {
    const row = mockRow({ tpPercent: 1, slPercent: 0.5 });
    const result = await patchStrategyFromPrompt(row, "tighten SL to 0.8% stop");
    expect(result.ok).toBe(true);
    expect(result.config?.slPercent).toBe(0.8);
  });
});
