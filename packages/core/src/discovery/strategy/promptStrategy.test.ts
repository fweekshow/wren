import { describe, expect, it } from "vitest";
import type { StrategyConfig } from "@basemate/shared";

import {
  alignExplanationToConfig,
  dropSizingAssumptions,
  finalizeStrategyConfig,
  parseStrategyPromptHints,
  reconcileNameLeverage,
} from "./promptStrategy.js";

function cfg(over: Partial<StrategyConfig>): StrategyConfig {
  return { maxLeverage: 25, defaultCollateralUsdc: 5, pairs: ["ETH-USD"], ...over } as StrategyConfig;
}

describe("reconcileNameLeverage", () => {
  it("rewrites a stale leverage token in the model title to the final leverage", () => {
    expect(reconcileNameLeverage("ETH 20x Breakout", 25)).toBe("ETH 25x Breakout");
    expect(reconcileNameLeverage("20X Crash Catcher", 25)).toBe("25x Crash Catcher");
  });

  it("leaves a title without a leverage token unchanged", () => {
    expect(reconcileNameLeverage("Crash Catcher", 25)).toBe("Crash Catcher");
  });
});

describe("dropSizingAssumptions", () => {
  it("drops model assumptions that assert leverage / margin / notional", () => {
    const kept = dropSizingAssumptions([
      "kept your 20x leverage as asked",
      "$4 margin per trade",
      "clears the $100 notional",
      "trades ETH on confirmed breakouts",
    ]);
    expect(kept).toEqual(["trades ETH on confirmed breakouts"]);
  });
});

describe("parseStrategyPromptHints — TP/SL extraction", () => {
  it("pulls explicit take-profit and stop-loss from a fully specified prompt", () => {
    const hints = parseStrategyPromptHints(
      "eth scalp, 30x, $3, exit at 2% profit or 1% loss",
    );
    expect(hints.tpPercent).toBe(2);
    expect(hints.slPercent).toBe(1);
    // The "2%" must NOT be misread as $2 margin — explicit $3 wins.
    expect(hints.defaultCollateralUsdc).toBe(3);
    expect(hints.maxLeverage).toBe(30);
  });

  it("reads 'tp'/'sl' shorthand", () => {
    const hints = parseStrategyPromptHints("btc 1.5% tp 0.5% sl");
    expect(hints.tpPercent).toBe(1.5);
    expect(hints.slPercent).toBe(0.5);
  });

  it("does not invent TP/SL when none stated", () => {
    const hints = parseStrategyPromptHints("scalp eth when it pumps");
    expect(hints.tpPercent).toBeUndefined();
    expect(hints.slPercent).toBeUndefined();
  });

  it("does not misread a percentage as collateral when no dollar amount given", () => {
    const hints = parseStrategyPromptHints("eth at 2% profit, 1% loss, 20x");
    expect(hints.defaultCollateralUsdc).toBe(minStrategyCollateralFromLev(20));
    expect(hints.tpPercent).toBe(2);
    expect(hints.slPercent).toBe(1);
  });
});

// 20x with no stated margin → smallest margin that clears ~$100 notional = ceil(100/20)=5
function minStrategyCollateralFromLev(lev: number): number {
  return Math.ceil(100 / lev);
}

describe("finalizeStrategyConfig — exit recommendation choice", () => {
  // modelConfig null → sizing comes purely from the prompt hints.
  it("surfaces an exit choice (not a silent change) when stated exits exceed the safe band at high leverage", async () => {
    const { exitChoice, config } = await finalizeStrategyConfig(
      "eth scalp 30x $3, exit at 2% profit or 1% loss",
      null,
    );
    expect(exitChoice).toBeDefined();
    expect(exitChoice?.originalTp).toBe(2);
    expect(exitChoice?.originalSl).toBe(1);
    // recommended values are the tighter band for the leverage
    expect(exitChoice!.recommendedTp).toBeLessThan(2);
    expect(exitChoice!.recommendedSl).toBeLessThan(1);
    // unresolved → config still holds the (band) placeholder, exits NOT yet applied
    expect(config.tpPercent).toBe(exitChoice!.recommendedTp);
  });

  it("honors the user's exact exits when they choose to keep them (within absolute rails)", async () => {
    const { config, exitChoice, tpslNote } = await finalizeStrategyConfig(
      "eth scalp 30x $3, exit at 2% profit or 1% loss",
      null,
      { resolveExits: "keep" },
    );
    expect(exitChoice).toBeUndefined();
    expect(config.tpPercent).toBe(2);
    expect(config.slPercent).toBe(1);
    expect(tpslNote).toMatch(/keeping your exits/i);
  });

  it("uses the safe band when they choose the recommendation", async () => {
    const { config, exitChoice, tpslNote } = await finalizeStrategyConfig(
      "eth scalp 30x $3, exit at 2% profit or 1% loss",
      null,
      { resolveExits: "recommend" },
    );
    expect(exitChoice).toBeUndefined();
    expect(config.tpPercent).toBeLessThan(2);
    expect(config.slPercent).toBeLessThan(1);
    expect(tpslNote).toMatch(/safe/i);
  });

  it("does not raise an exit choice when stated exits already fit the band", async () => {
    const { exitChoice } = await finalizeStrategyConfig(
      "eth steady 3x $50, exit at 2% profit or 1% loss",
      null,
    );
    // at 3x the band allows 2% / 1%, so no choice needed
    expect(exitChoice).toBeUndefined();
  });

  it("refinement carries the resolved sizing forward, so the original $3/30x can't re-fire the min-notional fork", async () => {
    // Original ask was "$3 30x" (a $90 position needing a fix); the user already
    // resolved it to $4 margin. A "tighter stop" refinement must NOT re-ask.
    const resolved = cfg({ maxLeverage: 30, defaultCollateralUsdc: 4, tpPercent: 1.3, slPercent: 0.7 });
    const { needsChoice, exitChoice, config } = await finalizeStrategyConfig(
      "eth scalp 30x $3, exit at 2% profit or 1% loss\n\nuser refinement: tighter stop",
      null,
      { baseConfig: resolved },
    );
    expect(needsChoice).toBeUndefined(); // $4 x 30 = $120 carried forward, clears $100
    expect(exitChoice).toBeUndefined(); // original 2%/1% no longer re-surfaces
    expect(config.defaultCollateralUsdc).toBe(4);
    expect(config.maxLeverage).toBe(30);
  });
});

describe("alignExplanationToConfig", () => {
  it("strips the model's liquidation prose and injects a deterministic line from final leverage", () => {
    const out = alignExplanationToConfig(
      cfg({ maxLeverage: 25 }),
      "longs eth on confirmed breakouts. you'd be liquidated around a 5% move against you.",
    );
    // deterministic liq line for 25x is ~4% (100/25), the model's stale 5% is gone
    expect(out).toMatch(/about a 4% move against you would liquidate/);
    expect(out).not.toMatch(/5%/);
    expect(out).toMatch(/longs eth on confirmed breakouts/);
  });

  it("computes the liq distance from the real leverage (20x -> ~5%)", () => {
    const out = alignExplanationToConfig(cfg({ maxLeverage: 20, defaultCollateralUsdc: 5 }), "longs eth.");
    expect(out).toMatch(/about a 5% move against you would liquidate/);
    expect(out).not.toMatch(/\$5 margin at 20x/);
  });

  it("strips a contradictory 'kept your exit at X% / Y% loss' claim from model prose", () => {
    const out = alignExplanationToConfig(
      cfg({ maxLeverage: 30, tpPercent: 1.3, slPercent: 0.7 }),
      "scalps eth adaptively on breakouts. i kept your exit at 2% profit / 1% loss (the system may nudge those).",
    );
    expect(out).toMatch(/scalps eth adaptively on breakouts/);
    // the false "2% / 1%" exit claim must be gone
    expect(out).not.toMatch(/2%\s*profit/i);
    expect(out).not.toMatch(/1%\s*loss/i);
    expect(out).not.toMatch(/kept your exit/i);
  });
});
