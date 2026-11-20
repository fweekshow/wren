import type { StrategyConfig } from "@basemate/shared";

import {
  StrategyAdapter,
  type StrategyClosedTradeRow,
  type StrategyRow,
} from "@/discovery/adapters/strategy.adapter.js";
import { buildStrategyAuthorSystemPromptV2 } from "@/discovery/strategy/brain.js";
import {
  alignExplanationToConfig,
  finalizeStrategyConfig,
  formatStrategySpec,
  parseStrategyPromptHints,
  tryParseAuthorJson,
  STRATEGY_AUTHOR_MODEL,
  type AuthoredStrategy,
} from "@/discovery/strategy/promptStrategy.js";
import { createBankrLlmClient, logLlmTurn, providerForModel } from "@/llm/config.js";
import { sanitizeXmptMarkdown } from "@/xmtp/core/markdownSanitize.js";
import { logger } from "@/utils/logger.js";

/**
 * Per-strategy wiki — the Karpathy LLM-wiki pattern applied to trading.
 *
 * Each strategy keeps a small, evolving markdown document (stored append-only in
 * `strategy_wiki_history`) that the agent compiles from closed trades. The wiki
 * is the memory layer the Improve flow reads to give REAL diagnoses ("superburst
 * fired in TREND regime 6/8 times") instead of guessing from a text prompt.
 *
 * Inner loop:  closeTrade -> wiki_dirty=true -> StrategyWikiWorker compiles here.
 * Outer loop:  user taps Improve -> buildTradeAnalysis reads the wiki -> Opus tweaks.
 */

/** Bookkeeping model for wiki compilation — fast + cheap, NOT the Opus author. */
export const WIKI_COMPILE_MODEL =
  process.env.WIKI_COMPILE_MODEL?.trim() || "gpt-5.4-mini";

/** Max trades fed into a single compile pass. */
const WIKI_COMPILE_TRADE_LIMIT = 20;

/** Consecutive losses that trigger an Improve nudge to the creator. */
const LOSS_STREAK_THRESHOLD = 3;

/** Pure: do the most recent `threshold` closed trades form an all-loss streak? */
export function detectLossStreak(
  trades: Array<{ pnl_usd: number }>,
  threshold = LOSS_STREAK_THRESHOLD,
): boolean {
  if (trades.length < threshold) return false;
  return trades.slice(0, threshold).every((t) => t.pnl_usd < 0);
}

export interface LossStreakNotice {
  strategyId: string;
  strategyName: string;
  creatorInboxId: string;
  creatorWallet: string | null;
  losses: number;
}

type LossStreakNotifier = (notice: LossStreakNotice) => Promise<void>;

let lossStreakNotifier: LossStreakNotifier | null = null;

/** Wire up creator delivery (XMTP DM). Registered by DiscoveryPlugin.onInit. */
export function setLossStreakNotifier(fn: LossStreakNotifier): void {
  lossStreakNotifier = fn;
}

// Count the current run of consecutive losses from the most recent close.
function currentLossStreak(trades: Array<{ pnl_usd: number }>): number {
  let streak = 0;
  for (const t of trades) {
    if (t.pnl_usd < 0) streak += 1;
    else break;
  }
  return streak;
}

// Strategies we've already DM'd about their CURRENT streak. Cleared when a win
// breaks the streak, so the next fresh streak notifies again (once).
const notifiedStreak = new Set<string>();

/**
 * Best-effort: if a strategy just ENTERED a loss streak, nudge the creator once
 * to tap Improve. Re-arms only after a win breaks the streak — it does not
 * re-fire on each additional loss. Message only, never auto-applies. Called by
 * the StrategyWikiWorker, off the trade-close hot path.
 */
export async function maybeNotifyLossStreak(strategyId: string): Promise<void> {
  if (!lossStreakNotifier) return;
  try {
    // Fetch enough history to measure the true streak length (not just the
    // threshold window) so the message reports the real number.
    const trades = await StrategyAdapter.listClosedTrades(strategyId, 50);
    const streak = currentLossStreak(trades);

    if (streak < LOSS_STREAK_THRESHOLD) {
      notifiedStreak.delete(strategyId); // streak broken (or never started) → re-arm
      return;
    }
    if (notifiedStreak.has(strategyId)) return; // already nudged for this streak

    const strategy = await StrategyAdapter.getById(strategyId);
    if (!strategy || strategy.status === "archived") return;

    await lossStreakNotifier({
      strategyId,
      strategyName: strategy.name,
      creatorInboxId: strategy.creator_inbox_id,
      creatorWallet: strategy.creator_wallet,
      losses: streak,
    });
    notifiedStreak.add(strategyId);
  } catch {
    // notification is best-effort; never throws into the worker
  }
}

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function usd(n: number): string {
  return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}

function fmtDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "n/a";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

interface ModeStat {
  wins: number;
  losses: number;
  flat: number;
  pnl: number;
}

/** Deterministic per-mode + overall aggregation. The LLM must NOT recount these. */
function aggregateTradeStats(trades: StrategyClosedTradeRow[]): {
  overall: ModeStat;
  byMode: Map<string, ModeStat>;
} {
  const overall: ModeStat = { wins: 0, losses: 0, flat: 0, pnl: 0 };
  const byMode = new Map<string, ModeStat>();
  for (const t of trades) {
    const m = byMode.get(t.mode) ?? { wins: 0, losses: 0, flat: 0, pnl: 0 };
    if (t.pnl_usd > 0) {
      m.wins += 1;
      overall.wins += 1;
    } else if (t.pnl_usd < 0) {
      m.losses += 1;
      overall.losses += 1;
    } else {
      m.flat += 1;
      overall.flat += 1;
    }
    m.pnl += t.pnl_usd;
    overall.pnl += t.pnl_usd;
    byMode.set(t.mode, m);
  }
  return { overall, byMode };
}

/** Authoritative, code-computed stats block — fed to the LLM so it never miscounts W/L or pnl. */
function formatStatsBlock(trades: StrategyClosedTradeRow[]): string {
  const { overall, byMode } = aggregateTradeStats(trades);
  const line = (m: ModeStat) => `${m.wins}W / ${m.losses}L${m.flat ? ` / ${m.flat} flat` : ""} · pnl ${usd(m.pnl)}`;
  const modeLines = [...byMode.entries()].map(([mode, m]) => `  ${mode}: ${line(m)}`);
  return [
    `OVERALL (${trades.length} closed): ${line(overall)}`,
    "PER MODE:",
    ...(modeLines.length ? modeLines : ["  (none)"]),
  ].join("\n");
}

/** Render closed trades as a compact diagnostic table for the LLM (and the raw fallback). */
function formatTradesTable(trades: StrategyClosedTradeRow[]): string {
  if (!trades.length) return "(no closed trades yet)";
  const lines = trades.map((t) => {
    const result = t.pnl_usd > 0 ? "WIN" : t.pnl_usd < 0 ? "LOSS" : "FLAT";
    const open = t.open_price != null ? `$${t.open_price}` : "?";
    const close = t.close_price != null ? `$${t.close_price}` : "?";
    return [
      `${result} ${usd(t.pnl_usd)}`,
      `${t.mode} ${t.side} ${t.pair}`,
      `regime=${t.entry_regime ?? "?"}`,
      `exit=${t.exit_reason ?? "?"}`,
      `open=${open} close=${close}`,
      `peakFavor=${pct(t.max_favorable_move_pct)} peakAdverse=${pct(t.max_adverse_move_pct)}`,
      `held=${fmtDuration(t.duration_s)}`,
    ].join(" · ");
  });
  return lines.join("\n");
}

const WIKI_COMPILE_SYSTEM = `You are a quantitative trading analyst maintaining a living "wiki" for ONE perps trading strategy. You receive the strategy's current config, its existing wiki (may be empty), and its most recent closed trades with full diagnostics. Update the wiki so it captures WHAT WORKS and WHAT DOESN'T for this specific strategy.

You are given a COMPUTED STATS block with exact, authoritative win/loss counts and pnl (calculated in code). USE THOSE NUMBERS VERBATIM — never recount, estimate, or derive win/loss counts or pnl from the trade rows. The trade rows are ONLY for qualitative patterns (regime, SL/TP move sizes, duration, clustering).

Run these five diagnostic passes and fold the findings into the wiki:
1. MODE WIN-RATE: quote the COMPUTED STATS per-mode counts exactly. Which mode is carrying the strategy and which is dragging it. (If a mode has 0 trades, it never fired — say so; do not claim it lost.)
2. REGIME MISMATCH: did a mode fire in a regime it isn't built for? (e.g. superburst firing in TREND/CHOP). Flag modes that mostly fire outside their intended regime.
3. SL TIGHTNESS: for losses, compare peakAdverse move vs the configured SL. If losses hit SL with tiny adverse moves, the entries are bad (noise), not the stop. If adverse moves are large, the stop may be too wide.
4. TP EFFICIENCY: for winners, compare peakFavor move vs the configured TP. If peakFavor regularly exceeds TP, winners are being cut short (raise TP / trail). If peakFavor rarely reaches TP, TP is too ambitious.
5. DURATION / CLUSTERING: fast losses = bad entries; slow losses = held too long through reversal. Note any time-of-day or consecutive-loss clusters.

Output ONLY the updated wiki as concise markdown with these sections (omit a section if there's no data for it):
## Performance Summary
## What Works
## Failure Patterns
## Contradictions
## Trade Log (most recent first, max 20 lines)

Keep it under ~500 words. Be specific and quantitative — cite the COMPUTED STATS counts, regimes, and move sizes. This wiki is read later to propose concrete config changes, so every line should help a future analyst decide what to tweak. Do not invent data not present in the trades, and never contradict the COMPUTED STATS. No preamble, no code fences.`;

/**
 * Recompile a strategy's wiki from its latest closed trades. Called by the
 * StrategyWikiWorker, never on the trade-close hot path. Never throws.
 */
export async function compileTradeToWiki(strategyId: string): Promise<boolean> {
  const strategy = await StrategyAdapter.getById(strategyId);
  if (!strategy) return false;

  const trades = await StrategyAdapter.listClosedTrades(strategyId, WIKI_COMPILE_TRADE_LIMIT);
  if (!trades.length) return false;

  // Stats are computed over ALL closed trades (deterministic, authoritative) so the
  // model never has to count; the trade table below is the recent window for patterns.
  const allClosed = await StrategyAdapter.listClosedTrades(strategyId, 500);

  const currentWiki = (await StrategyAdapter.getLatestWiki(strategyId)) ?? "(empty — first compile)";
  const userContent = [
    `STRATEGY: ${strategy.name}`,
    `CONFIG: ${formatStrategySpec(strategy.config)}`,
    "",
    "COMPUTED STATS (authoritative — use these exact counts, do NOT recompute):",
    formatStatsBlock(allClosed),
    "",
    "CURRENT WIKI:",
    currentWiki,
    "",
    `RECENT CLOSED TRADES for pattern analysis (most recent first, ${trades.length} of ${allClosed.length}):`,
    formatTradesTable(trades),
  ].join("\n");

  const client = createBankrLlmClient();
  const t0 = Date.now();
  try {
    const completion = await client.chat.completions.create(
      {
        model: WIKI_COMPILE_MODEL,
        max_completion_tokens: 1200,
        temperature: 0.2,
        messages: [
          { role: "system", content: WIKI_COMPILE_SYSTEM },
          { role: "user", content: userContent },
        ],
      },
      { timeout: 45_000 },
    );
    logLlmTurn({
      model: WIKI_COMPILE_MODEL,
      provider: providerForModel(WIKI_COMPILE_MODEL),
      latencyMs: Date.now() - t0,
      promptTokens: completion.usage?.prompt_tokens,
      completionTokens: completion.usage?.completion_tokens,
    });

    const content = completion.choices[0]?.message?.content?.trim();
    if (!content) {
      logger.warn(`wiki compile ${strategyId.slice(0, 8)}: empty model response`);
      return false;
    }
    await StrategyAdapter.appendWiki(strategyId, content);
    logger.info(`wiki compiled ${strategyId.slice(0, 8)} (${trades.length} trades)`);
    return true;
  } catch (err) {
    logger.warn(`wiki compile failed ${strategyId.slice(0, 8)}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Diagnostic context for the Improve flow. Prefers the compiled wiki; falls back
 * to a raw aggregation of closed trades if the wiki hasn't been compiled yet.
 */
export async function buildTradeAnalysis(strategyId: string): Promise<string> {
  const wiki = await StrategyAdapter.getLatestWiki(strategyId);
  if (wiki && wiki.trim()) return wiki;

  // Fallback: deterministic aggregation so Improve still works before the first compile.
  const allClosed = await StrategyAdapter.listClosedTrades(strategyId, 500);
  if (!allClosed.length) return "(no closed trades yet — nothing to analyze)";
  const recent = allClosed.slice(0, WIKI_COMPILE_TRADE_LIMIT);
  return [
    "## Raw Trade Analysis (wiki not yet compiled)",
    "COMPUTED STATS (authoritative):",
    formatStatsBlock(allClosed),
    "",
    "Recent trades:",
    formatTradesTable(recent),
  ].join("\n");
}

/**
 * Background worker that drains the `wiki_dirty` queue and recompiles strategy
 * wikis. Mirrors PortfolioReviewWorker: setInterval + re-entrancy guard, one
 * strategy at a time so we never spike the LLM gateway. A failed compile leaves
 * `wiki_dirty=true` so it retries on the next tick.
 */
export class StrategyWikiWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(intervalMs = 5 * 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    logger.info(`🧠 StrategyWikiWorker started (every ${Math.round(intervalMs / 60_000)}m)`);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const ids = await StrategyAdapter.listWikiDirtyStrategyIds();
      for (const id of ids) {
        // Clear BEFORE compiling: if a trade closes mid-compile it re-sets the
        // flag and we recompile next tick (no lost update). Restore the flag on
        // failure so a transient error (rate limit, LLM down) still retries.
        await StrategyAdapter.setWikiDirty(id, false);
        const ok = await compileTradeToWiki(id);
        if (ok) {
          await maybeNotifyLossStreak(id);
        } else {
          await StrategyAdapter.setWikiDirty(id, true);
        }
      }
    } catch (err) {
      logger.error(`StrategyWikiWorker tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

export interface ImproveResult {
  authored: AuthoredStrategy;
  diagnosis: string;
}

const IMPROVE_INSTRUCTION = `=== IMPROVE MODE (override) ===
You are improving an EXISTING strategy that has already traded — NOT authoring a fresh idea, NOT a new strategy. You are given the current config and a performance wiki compiled from its real trades. Diagnose what is hurting performance and propose a TARGETED tweak to the LOGIC ONLY: tighten/loosen TP or SL, drop or add an executable mode, or change direction. Keep what is working. Do not redesign from scratch.

HARD CONSTRAINTS:
- KEEP the strategy's name, leverage, and margin EXACTLY as they are — you tune HOW it trades, you do not rename it or resize the user's position. Do not return a "name" field, a "maxLeverage", or a "defaultCollateralUsdc" (they are preserved by the system).
- A mode that NEVER traded did not lose money — never claim it did. If a mode shows 0 trades in the computed stats, it simply never fired (and orderbook_impulse / tactical_to_trend can't run in v1 at all), so dropping it is fine but don't blame losses on it.

In addition to the normal JSON contract, include a top-level "diagnosis" string field: ONE plain-language sentence naming the specific problem you found in the computed stats and the specific change you made to fix it (e.g. "trend_pullback hit SL on tiny adverse moves 6/8 times — tightened entries and dropped it"). Lowercase is fine, Basemate voice, no markdown. NEVER use the word "wiki" — say "your trades" or "the Basemate Brain" if you need to reference the data source.`;

/**
 * Propose an improved StrategyConfig from a strategy's wiki. Uses the Opus author
 * model with a "tweak, don't redesign" framing on top of the standard author
 * system prompt (so the JSON contract + executable-mode rails still hold).
 */
export async function improveStrategyFromWiki(
  strategy: StrategyRow,
  wikiContent: string,
  userObservation?: string,
): Promise<ImproveResult> {
  const client = createBankrLlmClient();
  const t0 = Date.now();
  const userContent = [
    `CURRENT CONFIG: ${formatStrategySpec(strategy.config)}`,
    `ORIGINAL PROMPT: ${strategy.prompt}`,
    "",
    "PERFORMANCE WIKI (compiled from real trades):",
    wikiContent,
    "",
    `USER OBSERVATION: ${userObservation?.trim() || "analyze the wiki and improve the strategy"}`,
  ].join("\n");

  try {
    const completion = await client.chat.completions.create(
      {
        model: STRATEGY_AUTHOR_MODEL,
        max_completion_tokens: 3000,
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content: `${await buildStrategyAuthorSystemPromptV2()}\n\n${IMPROVE_INSTRUCTION}`,
          },
          { role: "user", content: userContent },
        ],
      },
      { timeout: 60_000 },
    );
    logLlmTurn({
      model: STRATEGY_AUTHOR_MODEL,
      provider: providerForModel(STRATEGY_AUTHOR_MODEL),
      latencyMs: Date.now() - t0,
      promptTokens: completion.usage?.prompt_tokens,
      completionTokens: completion.usage?.completion_tokens,
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = tryParseAuthorJson(raw) as ReturnType<typeof tryParseAuthorJson> & {
      diagnosis?: unknown;
    };
    // Base-merge on the EXISTING config so a partial model response only tweaks
    // the fields it returns — it must never silently reset modes/pairs/leverage
    // to platform defaults (that would throw away the strategy the user validated).
    // Improve tunes the LOGIC by default and preserves the user's capital/identity
    // — UNLESS the user's own direction explicitly asks to resize (e.g. "increase
    // the margin to $10", "use 25x"). In that case we honor their stated sizing.
    const userSizing = userObservation ? parseStrategyPromptHints(userObservation) : {};
    const preservedMargin =
      strategy.default_collateral_usdc ?? strategy.config.defaultCollateralUsdc;
    const mergedConfig = {
      ...strategy.config,
      ...(parsed.config ?? {}),
      maxLeverage: userSizing.maxLeverage ?? strategy.config.maxLeverage,
      defaultCollateralUsdc: userSizing.defaultCollateralUsdc ?? preservedMargin,
    };
    // Finalize WITHOUT the original prompt — re-parsing it would let stale hints
    // (e.g. "scalp" → superburst/breakout) clobber the modes the Improve model just
    // chose, making the applied config contradict the diagnosis. The merged config
    // is already the source of truth here.
    const { config, notionalNote } = await finalizeStrategyConfig("", mergedConfig);
    const name = strategy.name; // Improve never renames — it's the SAME strategy.
    const explanation = alignExplanationToConfig(
      config,
      typeof parsed.explanation === "string" ? parsed.explanation : "",
    );
    const diagnosis =
      typeof parsed.diagnosis === "string" && parsed.diagnosis.trim()
        ? parsed.diagnosis.trim()
        : "tuned this based on what your trades have been doing";
    const assumptions = notionalNote ? [notionalNote] : [];

    return {
      authored: {
        name,
        config,
        explanation: sanitizeXmptMarkdown(explanation),
        assumptions: assumptions.map(sanitizeXmptMarkdown),
      },
      diagnosis: sanitizeXmptMarkdown(diagnosis),
    };
  } catch (err) {
    logger.warn(`improveStrategyFromWiki failed ${strategy.id.slice(0, 8)}: ${(err as Error).message}`);
    // Fallback: keep the existing config (empty prompt so stale hints don't alter it).
    const { config } = await finalizeStrategyConfig("", strategy.config);
    return {
      authored: {
        name: strategy.name,
        config,
        explanation: sanitizeXmptMarkdown(alignExplanationToConfig(config, "kept your current setup")),
        assumptions: [],
      },
      diagnosis: sanitizeXmptMarkdown("i had a hiccup analyzing the trades — tap Remix to refine manually"),
    };
  }
}
