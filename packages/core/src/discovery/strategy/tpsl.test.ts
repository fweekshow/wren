import { describe, expect, it } from "vitest";
import { clampToRails } from "@basemate/shared";

import { effectiveSlPercent, resolveEffectiveTpslPercents, marginRoiFromPriceMovePct, formatTpslOnMarginShort, buildTpslMarginDisplay } from "./tpsl.js";

describe("effectiveSlPercent (liquidation buffer)", () => {
  it("leaves a conservative SL untouched", () => {
    expect(effectiveSlPercent(0.5, 10)).toBeCloseTo(0.5, 9);
  });

  it("caps a too-wide SL at 80% of the liquidation distance", () => {
    // 75x → liquidation at 1.333%, cap at 80% → ~1.0667%
    expect(effectiveSlPercent(80, 75)).toBeCloseTo((1 / 75) * 100 * 0.8, 9);
  });

  it("returns the config SL when leverage is non-positive", () => {
    expect(effectiveSlPercent(2, 0)).toBe(2);
  });
});

describe("resolveEffectiveTpslPercents (paper/live parity)", () => {
  it("returns config TP and the capped SL", () => {
    const cfg = clampToRails({ maxLeverage: 75, tpPercent: 1.0, slPercent: 0.5, pairs: ["ETH-USD"] });
    const eff = resolveEffectiveTpslPercents(cfg);
    expect(eff.tpPercent).toBe(cfg.tpPercent);
    expect(eff.slPercent).toBeLessThanOrEqual(cfg.slPercent);
    expect(eff.configSlPercent).toBe(cfg.slPercent);
  });

  it("honors a smoke-test one-shot override", () => {
    const cfg = clampToRails({
      maxLeverage: 5,
      tpPercent: 1.0,
      slPercent: 0.5,
      pairs: ["ETH-USD"],
      smokeTest: { side: "long", tpPercent: 2.5, slPercent: 1.2 },
    });
    const eff = resolveEffectiveTpslPercents(cfg);
    expect(eff.tpPercent).toBe(2.5);
    // 5x → liq 20%, cap 16% → 1.2 stays
    expect(eff.slPercent).toBeCloseTo(1.2, 9);
  });
});

describe("margin ROI display (P5a)", () => {
  it("converts price move to margin ROI", () => {
    expect(marginRoiFromPriceMovePct(0.5, 4)).toBe(2);
    expect(marginRoiFromPriceMovePct(1, 75)).toBe(75);
  });

  it("formats a short on-margin line", () => {
    const line = formatTpslOnMarginShort(
      buildTpslMarginDisplay({ tpPricePct: 1, slPricePct: 0.5, leverage: 4 }),
    );
    expect(line).toBe("TP +4% · SL -2% on margin · 4x");
  });

  it("notes when SL is capped", () => {
    const line = formatTpslOnMarginShort(
      buildTpslMarginDisplay({ tpPricePct: 1, slPricePct: 1.067, leverage: 75, slCapped: true }),
    );
    expect(line).toContain("SL capped");
  });
});
