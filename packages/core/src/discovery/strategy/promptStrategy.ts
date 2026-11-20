import {
  clampToRails,
  enforceRR,
  minStrategyCollateralUsdc,
  normalizeStrategyNotional,
  STRATEGY_RAILS,
  type StrategyConfig,
} from "@basemate/shared";
import { getAvantisPairMeta } from "@basemate/avantis-client";

import {
  createBankrLlmClient,
  logLlmTurn,
  openAiChatParams,
  providerForModel,
} from "@/llm/config.js";
import { buildStrategyAuthorSystemPromptV2 } from "@/discovery/strategy/brain.js";
import { sanitizeXmptMarkdown } from "@/xmtp/core/markdownSanitize.js";

/**
 * Clamp leverage to each market's REAL Avantis max (the actual cap users can
 * reach), using the min across the config's pairs so it's valid for all of them.
 * Best-effort: if pair meta is unavailable the config stays within the sanity
 * rails. This is what makes "500x or whatever the max is" possible while still
 * respecting the venue's true limit.
 */
async function clampLeverageToPairMax(config: StrategyConfig): Promise<{
  config: StrategyConfig;
  pairMaxLeverage: number;
}> {
  try {
    const bases = config.pairs.map((p) => p.replace(/-USD$/i, ""));
    const metas = await Promise.all(bases.map((b) => getAvantisPairMeta(b).catch(() => null)));
    const maxes = metas
      .map((m) => m?.maxLeverage)
      .filter((n): n is number => typeof n === "number" && n > 0);
    if (maxes.length) {
      const pairMax = Math.min(...maxes);
      if (config.maxLeverage > pairMax) {
        return { config: { ...config, maxLeverage: pairMax }, pairMaxLeverage: pairMax };
      }
      return { config, pairMaxLeverage: pairMax };
    }
  } catch {
    // leave as-is — already inside the sanity rails
  }
  return { config, pairMaxLeverage: config.maxLeverage };
}

/**
 * Authoring model for Prompt-a-Strategy. Opus 4.8 via the Bankr gateway
 * (dot-slug). The general agent stays on gpt-5.4-mini; only this flow goes
 * "smarter". Overridable via STRATEGY_AUTHOR_MODEL.
 */
export const STRATEGY_AUTHOR_MODEL =
  process.env.STRATEGY_AUTHOR_MODEL?.trim() || "claude-opus-4.8";

export interface StrategyNotionalChoice {
  /** The collateral the user asked for (or the config default), before any fix. */
  originalCollateral: number;
  /** The leverage the user asked for (or the config default), before any fix. */
  originalLeverage: number;
  /** Margin (USDC) needed to clear the min notional while keeping the stated leverage. */
  keepLeverageMargin: number;
  /** Leverage needed to clear the min notional while keeping the stated margin. */
  keepMarginLeverage: number;
}

/**
 * Surfaced when the user explicitly stated TP/SL that the leverage-safe band
 * would tighten. The exit change is a RECOMMENDATION, not mandatory — the user
 * chooses to keep their numbers (honored within absolute rails) or take ours.
 */
export interface StrategyExitChoice {
  /** The TP % the user asked for. */
  originalTp: number;
  /** The SL % the user asked for. */
  originalSl: number;
  /** Our recommended TP % (leverage-safe band). */
  recommendedTp: number;
  /** Our recommended SL % (leverage-safe band). */
  recommendedSl: number;
}

/** Clamp user-stated exits to the ABSOLUTE rails only (skip the leverage band), keeping the 1.5:1 R:R floor. */
function clampExitsRailsOnly(tp: number, sl: number): { tp: number; sl: number } {
  const t = Math.min(STRATEGY_RAILS.tpPercent.max, Math.max(STRATEGY_RAILS.tpPercent.min, tp));
  const s = Math.min(STRATEGY_RAILS.slPercent.max, Math.max(STRATEGY_RAILS.slPercent.min, sl));
  const rr = enforceRR({ tpPercent: t, slPercent: s });
  return { tp: rr.tpPercent, sl: rr.slPercent };
}

function approxEq(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.001;
}

function fmtPct(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, "");
}

export interface AuthoredStrategy {
  name: string;
  config: StrategyConfig;
  explanation: string;
  assumptions: string[];
  /**
   * When set, the position is below the ~$100 min notional and the user gave
   * explicit sizing — the caller must pause and let the user pick a fix rather
   * than the system silently adjusting leverage/margin.
   */
  needsChoice?: StrategyNotionalChoice;
  /** Note when the user's explicit TP/SL was resolved (kept or recommended). */
  tpslNote?: string;
  /** Surfaced when the user's stated exits differ from the safe band — a keep/recommend choice. */
  exitChoice?: StrategyExitChoice;
  /** User-requested conditions that can't be read in v1 (model-reported, plain words). */
  unsupported?: string[];
  /** Short note when the model changed the meaning of the request (e.g. long+short → adaptive). */
  reinterpreted?: string;
}

export type StrategyFollowupRoute = "strategy" | "global";

const STRATEGY_FOLLOWUP_ROUTER_MODEL =
  process.env.STRATEGY_FOLLOWUP_ROUTER_MODEL?.trim() || process.env.DEFAULT_MODEL?.trim();

function stripJsonFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function fallbackName(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 5).join(" ");
  return (words || "Custom Strategy").slice(0, 40);
}

/** Pull leverage, margin, market, and scalp intent straight from the user's words. */
export function parseStrategyPromptHints(prompt: string): Partial<StrategyConfig> {
  const raw = prompt.trim();
  if (!raw) return {};

  const hints: Partial<StrategyConfig> = {};

  const levMatch = /\b(\d+(?:\.\d+)?)\s*x\b/i.exec(raw);
  if (levMatch) {
    const lev = Number(levMatch[1]);
    if (Number.isFinite(lev) && lev > 0) hints.maxLeverage = lev;
  }

  // Strip leverage tokens AND percentage tokens before collateral detection so
  // an exit like "exit at 2% profit" can't be misread as "$2 margin".
  const withoutLev = raw
    .replace(/\b\d+(?:\.\d+)?\s*x\b/gi, " ")
    .replace(/\d+(?:\.\d+)?\s*%/g, " ");
  let coll: number | undefined;
  const dollarMatch = /(?:\$|usd\s*)\s*([0-9][\d,]*(?:\.\d+)?)/i.exec(withoutLev);
  if (dollarMatch) {
    coll = parseFloat(dollarMatch[1]!.replace(/,/g, ""));
  } else {
    const forMatch = /\bfor\s+\$?\s*([0-9][\d,]*(?:\.\d+)?)\b/i.exec(withoutLev);
    if (forMatch) coll = parseFloat(forMatch[1]!.replace(/,/g, ""));
    else {
      const atMatch = /\bat\s+\$?\s*([0-9][\d,]*(?:\.\d+)?)\b/i.exec(withoutLev);
      if (atMatch) coll = parseFloat(atMatch[1]!.replace(/,/g, ""));
    }
  }
  if (coll != null && Number.isFinite(coll) && coll > 0) {
    hints.defaultCollateralUsdc = coll;
  } else if (hints.maxLeverage) {
    // "75x eth" with no dollar amount → default to $25 collateral (meaningful notional),
    // but never below the min needed to clear ~$100 notional at the stated leverage.
    const DEFAULT_COLLATERAL = 25;
    hints.defaultCollateralUsdc = Math.max(DEFAULT_COLLATERAL, minStrategyCollateralUsdc(hints.maxLeverage));
  }

  const pairs: string[] = [];
  if (/\beth\b/i.test(raw)) pairs.push("ETH-USD");
  if (/\bbtc\b/i.test(raw)) pairs.push("BTC-USD");
  if (/\bsol\b/i.test(raw)) pairs.push("SOL-USD");
  if (pairs.length) hints.pairs = pairs;

  if (/\bscalp/i.test(raw)) {
    hints.enabledStrategies = ["superburst", "breakout_continuation"];
  }

  // Explicit take-profit / stop-loss % from the prompt (e.g. "exit at 2% profit
  // or 1% loss", "2% tp", "tighter 1% stop"). Surfaced so finalizeStrategyConfig
  // can tell the user when their values were clamped to the leverage-safe bands.
  const tp = extractTpPercent(raw);
  if (tp != null) hints.tpPercent = tp;
  const sl = extractSlPercent(raw);
  if (sl != null) hints.slPercent = sl;

  return hints;
}

/** Pull an explicit take-profit % from the prompt, if stated. */
function extractTpPercent(raw: string): number | undefined {
  const patterns = [
    /(\d+(?:\.\d+)?)\s*%\s*(?:tp\b|take[-\s]?profit|profit|gain)/i,
    /(?:tp\b|take[-\s]?profit)\s*(?:at|of|=|:|around)?\s*(\d+(?:\.\d+)?)\s*%/i,
  ];
  for (const re of patterns) {
    const m = re.exec(raw);
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v) && v > 0) return v;
    }
  }
  return undefined;
}

/** Pull an explicit stop-loss % from the prompt, if stated. */
function extractSlPercent(raw: string): number | undefined {
  const patterns = [
    /(\d+(?:\.\d+)?)\s*%\s*(?:sl\b|stop[-\s]?loss|stop|loss)/i,
    /(?:sl\b|stop[-\s]?loss|stop)\s*(?:at|of|=|:|around)?\s*(\d+(?:\.\d+)?)\s*%/i,
  ];
  for (const re of patterns) {
    const m = re.exec(raw);
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v) && v > 0) return v;
    }
  }
  return undefined;
}

export function tryParseAuthorJson(raw: string): Partial<AuthoredStrategy> & { config?: Partial<StrategyConfig> } {
  const stripped = stripJsonFences(raw);
  try {
    return JSON.parse(stripped) as Partial<AuthoredStrategy> & { config?: Partial<StrategyConfig> };
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(stripped.slice(start, end + 1)) as Partial<AuthoredStrategy> & {
        config?: Partial<StrategyConfig>;
      };
    }
    throw new Error("no JSON object in model response");
  }
}

/** User-stated leverage/margin/markets win over model output when present in the prompt. */
function mergeModelWithPromptHints(
  prompt: string,
  modelConfig: Partial<StrategyConfig> | null | undefined,
): Partial<StrategyConfig> {
  const hints = parseStrategyPromptHints(prompt);
  const merged: Partial<StrategyConfig> = { ...modelConfig, ...hints };
  if (hints.maxLeverage != null) merged.maxLeverage = hints.maxLeverage;
  if (hints.defaultCollateralUsdc != null) merged.defaultCollateralUsdc = hints.defaultCollateralUsdc;
  if (hints.pairs?.length) merged.pairs = hints.pairs;
  if (hints.enabledStrategies?.length) merged.enabledStrategies = hints.enabledStrategies;
  // If the model didn't set a direction, recover the user's stated lean from the prompt.
  if (!merged.tradeDirection) {
    const inferred = inferTradeDirectionFromText(prompt);
    if (inferred) merged.tradeDirection = inferred;
  }
  return merged;
}

/**
 * For refinement prompts ("prior\n\nuser refinement: …"), return only the
 * latest user message for sizing-hint detection. Prevents the original "20x"
 * from re-locking leverage when the user says "use higher leverage instead".
 */
function extractLatestHintSource(prompt: string): string {
  const marker = "\n\nuser refinement: ";
  const lastIdx = prompt.lastIndexOf(marker);
  return lastIdx >= 0 ? prompt.slice(lastIdx + marker.length).trim() : prompt;
}

export async function finalizeStrategyConfig(
  prompt: string,
  modelConfig: Partial<StrategyConfig> | null | undefined,
  opts: {
    resolveChoice?: "keepLeverage" | "keepMargin";
    resolveExits?: "keep" | "recommend";
    /** Refinement base: carry the already-resolved sizing forward (see runPromptStrategy). */
    baseConfig?: StrategyConfig;
  } = {},
): Promise<{
  config: StrategyConfig;
  notionalNote?: string;
  tpslNote?: string;
  needsChoice?: StrategyNotionalChoice;
  exitChoice?: StrategyExitChoice;
}> {
  // Sizing locks come from the LATEST user message only — not the full history —
  // so refinements like "use higher leverage instead" correctly unlock leverage
  // even when the original prompt contained an explicit "20x".
  const hintSource = extractLatestHintSource(prompt);
  const sizingHints = parseStrategyPromptHints(hintSource);
  const merged = mergeModelWithPromptHints(prompt, modelConfig);
  // Refinement: seed sizing from the already-resolved config so the ORIGINAL
  // prompt's stale "$3 / 30x" and "2% / 1%" hints can't re-fire the min-notional
  // or exit forks. The LLM's fresh tp/sl still drive tweaks like "tighter stop";
  // the latest message's explicit hints (below) still win.
  if (opts.baseConfig) {
    merged.maxLeverage = opts.baseConfig.maxLeverage;
    merged.defaultCollateralUsdc = opts.baseConfig.defaultCollateralUsdc;
    merged.tpPercent = modelConfig?.tpPercent ?? opts.baseConfig.tpPercent;
    merged.slPercent = modelConfig?.slPercent ?? opts.baseConfig.slPercent;
  }
  // Re-apply only the sizing fields from the latest message so they win over
  // both the model output and any stale hints from the prior prompt.
  if (sizingHints.maxLeverage != null) merged.maxLeverage = sizingHints.maxLeverage;
  if (sizingHints.defaultCollateralUsdc != null) merged.defaultCollateralUsdc = sizingHints.defaultCollateralUsdc;
  if (sizingHints.tpPercent != null) merged.tpPercent = sizingHints.tpPercent;
  if (sizingHints.slPercent != null) merged.slPercent = sizingHints.slPercent;
  const clamped = clampToRails(merged);
  const { config: pairClamped, pairMaxLeverage } = await clampLeverageToPairMax(clamped);

  // ── Step 1: resolve the min-notional (mandatory) ──────────────────────────
  const norm = normalizeStrategyNotional(pairClamped, pairMaxLeverage, {
    leverageLocked: sizingHints.maxLeverage != null,
    collateralLocked: sizingHints.defaultCollateralUsdc != null,
  });

  let config: StrategyConfig;
  let notionalNote: string | undefined;
  let needsChoiceOut: StrategyNotionalChoice | undefined;

  if (norm.needsChoice && opts.resolveChoice) {
    // Re-run clampToRails so the TP/SL bands track the (possibly higher) resolved leverage.
    config =
      opts.resolveChoice === "keepLeverage"
        ? clampToRails({ ...pairClamped, defaultCollateralUsdc: norm.needsChoice.keepLeverageMargin })
        : clampToRails({ ...pairClamped, maxLeverage: norm.needsChoice.keepMarginLeverage });
  } else if (norm.needsChoice) {
    config = norm.config;
    needsChoiceOut = {
      originalCollateral: pairClamped.defaultCollateralUsdc,
      originalLeverage: pairClamped.maxLeverage,
      keepLeverageMargin: norm.needsChoice.keepLeverageMargin,
      keepMarginLeverage: norm.needsChoice.keepMarginLeverage,
    };
  } else {
    config = norm.config;
    notionalNote = norm.note;
  }

  // ── Step 2: resolve the exits (a recommendation, not mandatory) ───────────
  // Compared against the band for the RESOLVED leverage so the numbers are honest.
  const bandTp = config.tpPercent;
  const bandSl = config.slPercent;
  const userStatedExits = sizingHints.tpPercent != null || sizingHints.slPercent != null;
  const wantTp = sizingHints.tpPercent ?? bandTp;
  const wantSl = sizingHints.slPercent ?? bandSl;
  const railsExits = clampExitsRailsOnly(wantTp, wantSl);
  const exitsDiffer =
    userStatedExits && (!approxEq(railsExits.tp, bandTp) || !approxEq(railsExits.sl, bandSl));

  let tpslNote: string | undefined;
  let exitChoiceOut: StrategyExitChoice | undefined;

  if (exitsDiffer) {
    if (opts.resolveExits === "keep") {
      config = { ...config, tpPercent: railsExits.tp, slPercent: railsExits.sl };
      tpslNote = `keeping your exits at TP +${fmtPct(railsExits.tp)}% / SL -${fmtPct(railsExits.sl)}% as asked 💙`;
    } else if (opts.resolveExits === "recommend") {
      tpslNote = `using the safe TP +${fmtPct(bandTp)}% / SL -${fmtPct(bandSl)}% for ${config.maxLeverage}x (your +${fmtPct(wantTp)}% / -${fmtPct(wantSl)}% widens risk on fast signals)`;
    } else {
      exitChoiceOut = {
        originalTp: railsExits.tp,
        originalSl: railsExits.sl,
        recommendedTp: bandTp,
        recommendedSl: bandSl,
      };
    }
  }

  return {
    config,
    notionalNote,
    tpslNote,
    needsChoice: needsChoiceOut,
    exitChoice: exitChoiceOut,
  };
}

function promptHintsLookRecovered(prompt: string): boolean {
  const hints = parseStrategyPromptHints(prompt);
  return (
    hints.maxLeverage != null ||
    hints.defaultCollateralUsdc != null ||
    (hints.pairs?.length ?? 0) > 0 ||
    (hints.enabledStrategies?.length ?? 0) > 0
  );
}

/**
 * Decide whether a message belongs to the active Prompt-a-Strategy authoring
 * state or should escape back to the normal agent brain. This keeps group chat
 * and global intents from being swallowed by a stale strategy pending state.
 */
export async function classifyStrategyFollowup(
  message: string,
  opts: { priorPrompt?: string | null; isGroup?: boolean } = {},
): Promise<StrategyFollowupRoute> {
  const clean = message.trim();
  if (!clean) return "global";

  const params = openAiChatParams({
    model: STRATEGY_FOLLOWUP_ROUTER_MODEL || undefined,
    temperature: 0,
    maxCompletionTokens: 80,
  });
  const t0 = Date.now();

  try {
    const client = createBankrLlmClient();
    const completion = await client.chat.completions.create(
      {
        ...params,
        messages: [
          {
            role: "system",
            content:
              "You route messages while a user is inside a New Strategy wizard for perps trading.\n" +
              "Return JSON only: {\"route\":\"strategy\"} or {\"route\":\"global\"}.\n\n" +
              "route=strategy when the user is clearly giving, refining, accepting, cancelling, or restarting a trading strategy prompt. Examples: 'make it riskier', 'eth only', 'tighter stop', 'looks good', 'cancel', 'build a btc breakout bot'.\n" +
              "route=global when the user is asking for app navigation, menu/help, wallet/positions/balance, closing trades, unrelated chat, or a group conversation message that is not clearly addressed to the strategy wizard.\n" +
              "In group chats, be conservative: only choose strategy if the message clearly continues the strategy authoring flow.",
          },
          {
            role: "user",
            content: JSON.stringify({
              message: clean,
              priorPrompt: opts.priorPrompt ?? null,
              isGroup: Boolean(opts.isGroup),
            }),
          },
        ],
      },
      { timeout: 10_000 },
    );

    logLlmTurn({
      model: params.model,
      provider: providerForModel(params.model),
      latencyMs: Date.now() - t0,
      promptTokens: completion.usage?.prompt_tokens,
      completionTokens: completion.usage?.completion_tokens,
      cachedTokens: completion.usage?.prompt_tokens_details?.cached_tokens,
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(stripJsonFences(raw)) as { route?: unknown };
    return parsed.route === "strategy" ? "strategy" : "global";
  } catch (err) {
    console.warn("⚠️ strategy follow-up router failed:", (err as Error)?.message || err);
    // In groups, avoid hijacking normal conversation on router failures.
    return opts.isGroup ? "global" : "strategy";
  }
}

/**
 * Elevate a free-form user prompt into a sophisticated, rails-clamped
 * StrategyConfig and a plain-language explanation. Never throws — on any model
 * or parse failure it falls back to the proven Tactical Alpha baseline so the
 * flow can never get stuck.
 */
export async function buildStrategyFromPrompt(
  prompt: string,
  opts: { baseConfig?: StrategyConfig } = {},
): Promise<AuthoredStrategy> {
  const clean = prompt.trim();
  const client = createBankrLlmClient();
  const t0 = Date.now();

  try {
    const completion = await client.chat.completions.create(
      {
        model: STRATEGY_AUTHOR_MODEL,
        max_completion_tokens: 3000,
        temperature: 0.5,
        messages: [
          { role: "system", content: await buildStrategyAuthorSystemPromptV2() },
          { role: "user", content: clean || "build me a solid starter perps strategy" },
        ],
      },
      { timeout: 60_000 },
    );
    logLlmTurn({
      model: STRATEGY_AUTHOR_MODEL,
      provider: "anthropic",
      latencyMs: Date.now() - t0,
      promptTokens: completion.usage?.prompt_tokens,
      completionTokens: completion.usage?.completion_tokens,
      cachedTokens: completion.usage?.prompt_tokens_details?.cached_tokens,
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = tryParseAuthorJson(raw);

    const { config, notionalNote, tpslNote, needsChoice, exitChoice } = await finalizeStrategyConfig(
      clean,
      parsed.config,
      opts.baseConfig ? { baseConfig: opts.baseConfig } : {},
    );
    const name = reconcileNameLeverage(
      (typeof parsed.name === "string" && parsed.name.trim()
        ? parsed.name.trim()
        : fallbackName(clean)
      ).slice(0, 40),
      config.maxLeverage,
    );
    const rawExplanation =
      typeof parsed.explanation === "string" && parsed.explanation.trim()
        ? parsed.explanation.trim()
        : "";
    const explanation = alignExplanationToConfig(config, rawExplanation);
    const assumptions = Array.isArray(parsed.assumptions)
      ? dropSizingAssumptions(
          parsed.assumptions.filter((a): a is string => typeof a === "string"),
        ).slice(0, 6)
      : [];
    // The silent-adjust note (only when leverage-locked, never with needsChoice)
    // is a behavior assumption; the TP/SL clamp note is surfaced separately so
    // the capability-check flow can render and detect it cleanly.
    if (notionalNote) assumptions.push(notionalNote);

    const unsupported = Array.isArray((parsed as { unsupported?: unknown }).unsupported)
      ? ((parsed as { unsupported?: unknown }).unsupported as unknown[])
          .filter((u): u is string => typeof u === "string" && u.trim().length > 0)
          .map((u) => u.trim())
          .slice(0, 6)
      : [];
    const reinterpreted =
      typeof (parsed as { reinterpreted?: unknown }).reinterpreted === "string" &&
      (parsed as { reinterpreted: string }).reinterpreted.trim()
        ? (parsed as { reinterpreted: string }).reinterpreted.trim()
        : undefined;

    return {
      name,
      config,
      explanation: sanitizeXmptMarkdown(explanation),
      assumptions: assumptions.map(sanitizeXmptMarkdown),
      ...(tpslNote ? { tpslNote: sanitizeXmptMarkdown(tpslNote) } : {}),
      ...(needsChoice ? { needsChoice } : {}),
      ...(exitChoice ? { exitChoice } : {}),
      ...(unsupported.length ? { unsupported: unsupported.map(sanitizeXmptMarkdown) } : {}),
      ...(reinterpreted ? { reinterpreted: sanitizeXmptMarkdown(reinterpreted) } : {}),
    };
  } catch (err) {
    console.warn("⚠️ buildStrategyFromPrompt failed, using baseline:", (err as Error)?.message || err);
    const { config, notionalNote, tpslNote, needsChoice, exitChoice } = await finalizeStrategyConfig(
      clean,
      null,
      opts.baseConfig ? { baseConfig: opts.baseConfig } : {},
    );
    const recovered = promptHintsLookRecovered(clean);
    const assumptions: string[] = [];
    if (notionalNote) assumptions.push(notionalNote);
    if (!recovered) {
      assumptions.push("fell back to the Tactical Alpha baseline after a model error");
    }

    return {
      name: fallbackName(clean),
      config,
      explanation: sanitizeXmptMarkdown(
        recovered
          ? alignExplanationToConfig(config, "got your ask — tap Remix to refine 💙")
          : alignExplanationToConfig(
              config,
              "i had a hiccup designing that, so i started you on a proven baseline 💙 — tap Remix or tell me how to reshape it (riskier, eth-only, etc.).",
            ),
      ),
      assumptions: assumptions.map(sanitizeXmptMarkdown),
      ...(tpslNote ? { tpslNote: sanitizeXmptMarkdown(tpslNote) } : {}),
      ...(needsChoice ? { needsChoice } : {}),
      ...(exitChoice ? { exitChoice } : {}),
    };
  }
}

/** Keyword heuristic to recover trade direction from a free-text prompt. */
export function inferTradeDirectionFromText(
  text: string,
): "long" | "short" | "adaptive" | undefined {
  const m = (text ?? "").toLowerCase();
  const short = /\b(short|shorts|shorting|fade|fading|dump|dumps|crash|crashes|sell|bear|bearish|downside|puts?)\b/.test(m);
  const long = /\b(long|longs|longing|breakout|breakouts|ride|moon|pump|pumps|buy|bull|bullish|upside|calls?)\b/.test(m);
  if (short && long) return "adaptive";
  if (short) return "short";
  if (long) return "long";
  return undefined;
}

/**
 * Direction word for display. Prefers the stored config field; for older
 * strategies saved before tradeDirection existed, recovers it from the original
 * prompt; falls back to "adaptive" when no clear lean is expressed.
 */
export function resolveStrategyDirection(c: StrategyConfig, prompt?: string | null): string {
  return c.tradeDirection ?? (prompt ? inferTradeDirectionFromText(prompt) : undefined) ?? "adaptive";
}

/** Short direction word for the authoring spec line (long | short | adaptive). */
export function formatStrategyDirection(c: StrategyConfig): string {
  return c.tradeDirection ?? "adaptive";
}

/** Compact strategy card — margin, leverage, direction, markets, modes, TP/SL, daily stop. */
export function formatStrategySpec(c: StrategyConfig): string {
  const margin = c.defaultCollateralUsdc != null ? `$${c.defaultCollateralUsdc}` : "$25 (default)";
  const modes = c.enabledStrategies.map((m) => m.replace(/_/g, " ")).join(", ");
  const direction = formatStrategyDirection(c);
  return [
    `${margin} · ${c.maxLeverage}x · ${direction} · ${c.pairs.join(" · ")}`,
    `modes: ${modes}`,
    `TP +${c.tpPercent}% · SL -${c.slPercent}% · stop day at -${c.dailyDrawdownStopPct}% (Basemate wallet)`,
  ].join("\n");
}

/** Plain-language summary (no margin math — that lives in formatStrategySpec). */
export function describeConfig(c: StrategyConfig): string {
  const modes = c.enabledStrategies.join(", ").replace(/_/g, " ");
  return `trades ${c.pairs.join(" + ")} using ${modes}; ${c.riskPerTradePct}% risk per trade, up to ${c.maxLeverage}x leverage, pausing new entries at -${c.dailyDrawdownStopPct}% daily on your Basemate wallet.`;
}

/** Strip margin/leverage/notional/exit figures from model prose so they can't drift from clamped config. */
function stripSizingFromExplanation(text: string): string {
  return text
    // Drop any model liquidation estimate — we inject a deterministic one from final leverage.
    .replace(/[^.!?]*\bliquidat\w*[^.!?]*(?:[.!?]|$)/gi, "")
    // Drop any sentence that asserts kept/changed exits (e.g. "i kept your exit at 2% profit / 1% loss")
    // — the exit decision is shown in the spec line + the deterministic note, never in prose.
    .replace(/[^.!?]*\b(?:kept|keeping|set|using|nudge\w*)\b[^.!?]*\b(?:exit|tp|sl|take[-\s]?profit|stop[-\s]?loss)\b[^.!?]*(?:[.!?]|$)/gi, "")
    .replace(/(?:about\s+)?\$[\d,]+(?:\.\d+)?(?:\s*(?:margin|notional|per\s+trade|each\s+trade|collateral))?/gi, "")
    .replace(/\b(?:about\s+)?[\d,]+(?:\.\d+)?\s*(?:usd|usdc)\b/gi, "")
    .replace(/\b(?:at|with|using)\s+[\d.]+\s*x(?:\s+leverage)?\b/gi, "")
    .replace(/\b[\d.]+\s*x(?:\s+leverage)?\b/gi, "")
    .replace(/\b(?:at|with)\s+(?:margin|leverage|notional)\b/gi, "")
    // Drop any lingering exit-percentage tokens ("TP 1.3%", "2% profit", "1% loss").
    .replace(/\b(?:tp|sl)\s*[+\-]?\s*\d+(?:\.\d+)?\s*%/gi, "")
    .replace(/[+\-]?\d+(?:\.\d+)?\s*%\s*(?:profit|loss|tp|sl|take[-\s]?profit|stop[-\s]?loss)/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\b(?:at|with)\s+(?=on\b|for\b|in\b)/gi, "")
    .replace(/\b(?:at|with)\s*[,.!?]?\s*$/i, "")
    .trim();
}

/** Deterministic liquidation-distance line from the final clamped leverage.
 * The spec line already shows "$X · Yx" so we don't repeat margin/leverage here. */
function formatStrategySizingSentence(c: StrategyConfig): string {
  const liqMovePct = Math.max(1, Math.round(100 / c.maxLeverage));
  if (c.maxLeverage >= 20) {
    return `about a ${liqMovePct}% move against you would liquidate, so stops stay tight 💙`;
  }
  return `about a ${liqMovePct}% adverse move would liquidate`;
}

/** Replace any leverage token in a model-authored name with the final clamped leverage. */
export function reconcileNameLeverage(name: string, finalLeverage: number): string {
  return name.replace(/\b\d+(?:\.\d+)?\s*x\b/gi, `${finalLeverage}x`);
}

/**
 * Drop model-authored assumptions that assert sizing (leverage / margin / notional).
 * The deterministic notional note is the single source of truth, so stale model
 * claims like "kept your 20x leverage" can't contradict an auto-adjusted config.
 */
export function dropSizingAssumptions(assumptions: string[]): string[] {
  return assumptions.filter(
    (a) =>
      !/\b\d+(?:\.\d+)?\s*x\b|\bleverage\b|\bmargin\b|\bnotional\b|\bcollateral\b|\$\s*\d/i.test(a),
  );
}

/** Merge model entry-logic prose with exact sizing from finalized config. */
export function alignExplanationToConfig(config: StrategyConfig, modelExplanation: string): string {
  const behavior = stripSizingFromExplanation(modelExplanation);
  const sizing = formatStrategySizingSentence(config);
  if (!behavior) return `${sizing}.`;
  return `${behavior.replace(/[.\s]+$/, "")}.\n\n${sizing}.`;
}
