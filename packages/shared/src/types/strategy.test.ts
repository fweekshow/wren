import { describe, expect, it } from "vitest";

import { normalizeStrategyNotional, type StrategyConfig } from "./strategy.js";

// normalizeStrategyNotional only reads maxLeverage + defaultCollateralUsdc and
// spreads the rest, so a minimal cast config is sufficient for these unit tests.
function cfg(over: Partial<StrategyConfig>): StrategyConfig {
  return { maxLeverage: 20, defaultCollateralUsdc: 4, ...over } as StrategyConfig;
}

describe("normalizeStrategyNotional", () => {
  it("leaves a config that already clears the $100 minimum untouched", () => {
    const { config, note, needsChoice } = normalizeStrategyNotional(
      cfg({ maxLeverage: 25, defaultCollateralUsdc: 5 }),
      75,
    );
    expect(config.maxLeverage).toBe(25);
    expect(config.defaultCollateralUsdc).toBe(5);
    expect(note).toBeUndefined();
    expect(needsChoice).toBeUndefined();
  });

  it("returns a choice when both leverage and margin are user-stated (20x $4)", () => {
    const { config, note, needsChoice } = normalizeStrategyNotional(
      cfg({ maxLeverage: 20, defaultCollateralUsdc: 4 }),
      75,
      { leverageLocked: true, collateralLocked: true },
    );
    // Nothing silently mutated — caller must ask.
    expect(config.maxLeverage).toBe(20);
    expect(config.defaultCollateralUsdc).toBe(4);
    expect(note).toBeUndefined();
    expect(needsChoice).toBeDefined();
    expect(needsChoice?.keepLeverageMargin).toBe(5); // ceil(100/20)
    expect(needsChoice?.keepMarginLeverage).toBe(25); // ceil(100/4)
  });

  it("returns a choice when only margin is user-stated, never silently bumping leverage ($4)", () => {
    const { config, note, needsChoice } = normalizeStrategyNotional(
      cfg({ maxLeverage: 3, defaultCollateralUsdc: 4 }),
      75,
      { collateralLocked: true },
    );
    expect(config.maxLeverage).toBe(3);
    expect(config.defaultCollateralUsdc).toBe(4);
    expect(note).toBeUndefined();
    expect(needsChoice).toBeDefined();
    expect(needsChoice?.keepLeverageMargin).toBe(34); // ceil(100/3)
    expect(needsChoice?.keepMarginLeverage).toBe(25); // ceil(100/4)
  });

  it("caps keepMarginLeverage at the pair max when the math would exceed it", () => {
    const { needsChoice } = normalizeStrategyNotional(
      cfg({ maxLeverage: 10, defaultCollateralUsdc: 1 }),
      20, // pair max
      { collateralLocked: true },
    );
    expect(needsChoice?.keepMarginLeverage).toBe(20); // ceil(100/1)=100 capped to 20
  });

  it("honors explicit leverage only (no margin stated) by raising margin silently (3x -> $34)", () => {
    const { config, note, needsChoice } = normalizeStrategyNotional(
      cfg({ maxLeverage: 3, defaultCollateralUsdc: 4 }),
      75,
      { leverageLocked: true },
    );
    expect(config.maxLeverage).toBe(3); // leverage untouched
    expect(config.defaultCollateralUsdc).toBe(34); // ceil(100/3)
    expect(needsChoice).toBeUndefined();
    expect(note).toMatch(/\$34/);
  });

  it("with nothing locked, raises leverage but caps the silent bump at 10x", () => {
    // LLM picked 3x for a beginner; nothing locked → may raise leverage, but never past 10x.
    const { config, needsChoice } = normalizeStrategyNotional(
      cfg({ maxLeverage: 3, defaultCollateralUsdc: 10 }),
      75,
    );
    expect(needsChoice).toBeUndefined();
    expect(config.maxLeverage).toBe(10); // ceil(100/10)=10, within the 10x cap
    expect(config.defaultCollateralUsdc).toBe(10); // margin untouched
  });

  it("with nothing locked and tiny margin, caps leverage at 10x then raises margin instead of going to 25x", () => {
    const { config, needsChoice } = normalizeStrategyNotional(
      cfg({ maxLeverage: 5, defaultCollateralUsdc: 4 }),
      75,
    );
    expect(needsChoice).toBeUndefined();
    expect(config.maxLeverage).toBe(10); // capped at safe 10x, not 25x
    expect(config.defaultCollateralUsdc).toBe(10); // ceil(100/10) — margin raised instead
  });
});
