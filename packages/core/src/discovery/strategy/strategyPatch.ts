import type { StrategyConfig } from "@basemate/shared";

import type { StrategyRow } from "@/discovery/adapters/strategy.adapter.js";

import {
  finalizeStrategyConfig,
  inferTradeDirectionFromText,
  parseStrategyPromptHints,
} from "./promptStrategy.js";

export interface StrategyPatchResult {
  ok: boolean;
  config?: StrategyConfig;
  summary?: string;
  error?: string;
}

function diffField(label: string, before: unknown, after: unknown): string | null {
  if (before === after) return null;
  return `${label}: ${String(before)} → ${String(after)}`;
}

function buildPatchSummary(before: StrategyConfig, after: StrategyConfig): string {
  const lines = [
    diffField("TP", before.tpPercent, after.tpPercent),
    diffField("SL", before.slPercent, after.slPercent),
    diffField("margin", before.defaultCollateralUsdc, after.defaultCollateralUsdc),
    diffField("leverage", before.maxLeverage, after.maxLeverage),
    diffField("direction", before.tradeDirection ?? "adaptive", after.tradeDirection ?? "adaptive"),
    before.pairs.join(",") !== after.pairs.join(",")
      ? `pairs: ${before.pairs.join(", ")} → ${after.pairs.join(", ")}`
      : null,
    before.regimeFilters.antiChop !== after.regimeFilters.antiChop
      ? `antiChop: ${before.regimeFilters.antiChop} → ${after.regimeFilters.antiChop}`
      : null,
  ].filter((l): l is string => l != null);
  return lines.length ? lines.join("\n") : "config updated (minor tweaks)";
}

const TIGHTEN_TPSL_FACTOR = 0.75;
const WIDEN_TPSL_FACTOR = 1.25;

function roundTpslPct(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function mentionsSl(text: string): boolean {
  return /\b(sl|stop[-\s]?loss)\b/i.test(text) || /\bstop\b(?!\s+day)/i.test(text);
}

function mentionsTp(text: string): boolean {
  return /\b(tp|take[-\s]?profit)\b/i.test(text) || /\bprofit target\b/i.test(text);
}

function wantsTighten(text: string): boolean {
  return /\b(tighten|tighter|narrow|reduce|decrease|lower|cut)\b/i.test(text);
}

function wantsWiden(text: string): boolean {
  return /\b(widen|wider|loosen|increase|raise|bump)\b/i.test(text);
}

/** Relative TP/SL tweaks for Modify — "tighten SL", "widen TP", etc. */
export function parseRelativeTpslAdjustments(
  text: string,
  current: Pick<StrategyConfig, "tpPercent" | "slPercent">,
): Partial<StrategyConfig> {
  const hints: Partial<StrategyConfig> = {};

  if (mentionsSl(text)) {
    if (wantsTighten(text) && !wantsWiden(text)) {
      hints.slPercent = roundTpslPct(current.slPercent * TIGHTEN_TPSL_FACTOR);
    } else if (wantsWiden(text) && !wantsTighten(text)) {
      hints.slPercent = roundTpslPct(current.slPercent * WIDEN_TPSL_FACTOR);
    }
  }

  if (mentionsTp(text)) {
    if (wantsTighten(text) && !wantsWiden(text)) {
      hints.tpPercent = roundTpslPct(current.tpPercent * TIGHTEN_TPSL_FACTOR);
    } else if (wantsWiden(text) && !wantsTighten(text)) {
      hints.tpPercent = roundTpslPct(current.tpPercent * WIDEN_TPSL_FACTOR);
    }
  }

  return hints;
}

/** Fast conversational patch — hints-only v1, no wiki required. */
export async function patchStrategyFromPrompt(
  row: StrategyRow,
  userText: string,
): Promise<StrategyPatchResult> {
  const text = userText.trim();
  if (!text) return { ok: false, error: "Tell me what to change — TP/SL, margin, leverage, pairs…" };

  const explicitHints = parseStrategyPromptHints(text);
  const relativeHints = parseRelativeTpslAdjustments(text, row.config);
  const hints: Partial<StrategyConfig> = { ...relativeHints, ...explicitHints };
  const inferredDir = inferTradeDirectionFromText(text);
  const antiChopOff = /\b(no anti[-\s]?chop|turn off anti[-\s]?chop|disable anti[-\s]?chop)\b/i.test(text);
  const antiChopOn = /\b(anti[-\s]?chop on|enable anti[-\s]?chop)\b/i.test(text);

  if (
    !Object.keys(hints).length &&
    !inferredDir &&
    !antiChopOff &&
    !antiChopOn
  ) {
    return {
      ok: false,
      error:
        "Couldn't parse that — try e.g. \"tighten SL\", \"1% TP, 0.5% SL\", \"$25 at 20x\", or \"add BTC\".",
    };
  }

  const modelOverrides: Partial<StrategyConfig> = { ...hints };
  if (inferredDir) modelOverrides.tradeDirection = inferredDir;
  if (antiChopOff || antiChopOn) {
    modelOverrides.regimeFilters = {
      ...row.config.regimeFilters,
      antiChop: antiChopOn ? true : antiChopOff ? false : row.config.regimeFilters.antiChop,
    };
  }

  const { config } = await finalizeStrategyConfig(text, modelOverrides, {
    baseConfig: row.config,
    resolveExits: "keep",
  });

  const bumped: StrategyConfig = {
    ...config,
    version: ((row.config.version ?? 0) + 1) as StrategyConfig["version"],
  };

  return {
    ok: true,
    config: bumped,
    summary: buildPatchSummary(row.config, bumped),
  };
}
