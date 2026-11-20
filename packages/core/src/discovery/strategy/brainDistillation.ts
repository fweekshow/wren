import { StrategyAdapter } from "@/discovery/adapters/strategy.adapter.js";
import { STRATEGY_AUTHOR_MODEL } from "@/discovery/strategy/promptStrategy.js";
import { createBankrLlmClient, logLlmTurn, providerForModel } from "@/llm/config.js";
import { logger } from "@/utils/logger.js";

/**
 * Platform meta-brain — the nightly "daydream" (v2).
 *
 * Once a day the worker reads every strategy's latest wiki, asks Opus to
 * synthesize what works and what fails ACROSS strategies, and writes the result
 * to `platform_brain_history`. `brain.ts` injects the latest entry into every
 * authoring/Improve call (gated on PLATFORM_BRAIN_ENABLED), so the whole
 * platform's authoring brain wakes up smarter each morning.
 *
 * Gated + capped so it stays cheap and safe:
 * - PLATFORM_BRAIN_ENABLED must be "true" (off by default).
 * - Only runs if total closed trades >= PLATFORM_BRAIN_MIN_TRADES (default 100).
 * - Output truncated to PLATFORM_BRAIN_MAX_TOKENS (default 2000, ~4 chars/token)
 *   because it is injected into every authoring system prompt.
 */

function platformBrainEnabled(): boolean {
  return process.env.PLATFORM_BRAIN_ENABLED?.trim() === "true";
}

function minTrades(): number {
  const n = Number(process.env.PLATFORM_BRAIN_MIN_TRADES);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

function maxChars(): number {
  const tokens = Number(process.env.PLATFORM_BRAIN_MAX_TOKENS);
  const t = Number.isFinite(tokens) && tokens > 0 ? tokens : 2000;
  return t * 4; // rough chars-per-token budget
}

/** UTC hour at which the daily distillation is allowed to run (default 2am). */
function distillHour(): number {
  const h = Number(process.env.BRAIN_DISTILLATION_HOUR);
  return Number.isFinite(h) && h >= 0 && h <= 23 ? h : 2;
}

const DISTILL_SYSTEM = `You are the head quant of a trading-strategy platform. You receive per-strategy "wikis" (compiled from each strategy's real closed trades) plus yesterday's platform-learnings doc. Synthesize CROSS-STRATEGY patterns: what modes/regimes/configs actually work and which consistently fail, with confidence grounded in how many strategies confirm each pattern.

Output ONLY markdown with these sections:
## Mode Performance (platform-wide)
## Key Patterns (high confidence — note how many strategies confirm)
## Contradiction Flags (where live data contradicts the house defaults)
## Changes vs Yesterday (what shifted since the prior doc; omit if no prior doc)

Be specific and quantitative. Do not invent data. This doc is injected into the strategy-authoring brain, so every line must help author or tune a strategy. Keep it tight — under ~500 words. No preamble, no code fences.`;

export async function runBrainDistillation(): Promise<boolean> {
  if (!platformBrainEnabled()) return false;

  const totalClosed = await StrategyAdapter.countClosedTrades();
  if (totalClosed < minTrades()) {
    await StrategyAdapter.appendPlatformBrain(
      `(insufficient data — platform learnings available after ${minTrades()}+ closed trades across the platform; currently ${totalClosed})`,
      { strategyCount: 0, tradeCount: totalClosed },
    );
    logger.info(`brain distillation: below threshold (${totalClosed}/${minTrades()}) — wrote stub`);
    return false;
  }

  const strategyIds = await StrategyAdapter.listStrategiesWithClosedTrades();
  const wikis: string[] = [];
  for (const id of strategyIds) {
    const wiki = await StrategyAdapter.getLatestWiki(id);
    const strategy = await StrategyAdapter.getById(id);
    if (wiki && strategy) {
      wikis.push(`### ${strategy.name} (${strategy.config.pairs.join(",")} · ${strategy.config.maxLeverage}x)\n${wiki}`);
    }
  }
  if (!wikis.length) return false;

  const prior = (await StrategyAdapter.getLatestPlatformBrain()) ?? "(no prior platform-learnings doc)";
  const userContent = [
    `YESTERDAY'S PLATFORM LEARNINGS:\n${prior}`,
    "",
    `STRATEGY WIKIS (${wikis.length}):`,
    wikis.join("\n\n"),
  ].join("\n");

  const client = createBankrLlmClient();
  const t0 = Date.now();
  try {
    const completion = await client.chat.completions.create(
      {
        model: STRATEGY_AUTHOR_MODEL,
        max_completion_tokens: 2500,
        temperature: 0.3,
        messages: [
          { role: "system", content: DISTILL_SYSTEM },
          { role: "user", content: userContent },
        ],
      },
      { timeout: 90_000 },
    );
    logLlmTurn({
      model: STRATEGY_AUTHOR_MODEL,
      provider: providerForModel(STRATEGY_AUTHOR_MODEL),
      latencyMs: Date.now() - t0,
      promptTokens: completion.usage?.prompt_tokens,
      completionTokens: completion.usage?.completion_tokens,
    });

    let content = completion.choices[0]?.message?.content?.trim();
    if (!content) {
      logger.warn("brain distillation: empty model response");
      return false;
    }
    if (content.length > maxChars()) {
      content = `${content.slice(0, maxChars())}\n\n(truncated)`;
    }
    await StrategyAdapter.appendPlatformBrain(content, {
      strategyCount: wikis.length,
      tradeCount: totalClosed,
    });
    logger.info(`brain distillation: synthesized ${wikis.length} wikis / ${totalClosed} trades`);
    return true;
  } catch (err) {
    logger.warn(`brain distillation failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Schedules the daily distillation. Ticks hourly; fires once per UTC day at or
 * after the configured hour. Cheap and idempotent — re-entrancy guarded.
 */
export class BrainDistillationWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastRunDay: string | null = null;

  start(intervalMs = 60 * 60_000): void {
    if (this.timer) return;
    if (!platformBrainEnabled()) {
      logger.info("🌙 BrainDistillationWorker disabled (PLATFORM_BRAIN_ENABLED!=true)");
      return;
    }
    this.timer = setInterval(() => void this.tick(), intervalMs);
    logger.info(`🌙 BrainDistillationWorker started (daily at ${distillHour()}:00 UTC)`);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (this.lastRunDay === day) return;
    if (now.getUTCHours() < distillHour()) return;
    this.running = true;
    try {
      await runBrainDistillation();
      this.lastRunDay = day;
    } catch (err) {
      logger.error(`BrainDistillationWorker tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
