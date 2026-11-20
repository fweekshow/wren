/**
 * Multi-turn conversation test harness for DiscoveryAI.
 *
 * Tests that multi-turn flows work end-to-end — greetings followed by intents,
 * support flows, perp flows, and vague/edge cases.
 *
 * Each scenario runs 2–4 turns with the same conversationId so history
 * accumulates naturally, exactly as it does in production.
 *
 * Usage:
 *   bun packages/core/src/discovery/eval/conversation-test.ts
 *   bun packages/core/src/discovery/eval/conversation-test.ts --concurrency 1
 *   bun packages/core/src/discovery/eval/conversation-test.ts --concurrency 1 --scenario greeting
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../../../../");
loadEnv({ path: resolve(repoRoot, "apps/basemate-tba/.env") });
loadEnv({ path: resolve(repoRoot, "packages/core/.env") });

// Redirect to an isolated eval database when EVAL_DATABASE_URL is provided.
// Without this, the harness writes conversation memory and analytics to the prod DB.
if (process.env.EVAL_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.EVAL_DATABASE_URL;
} else if (!process.argv.includes("--i-know-what-im-doing")) {
  console.error(
    "ERROR: EVAL_DATABASE_URL is not set.\n" +
    "This harness writes to the database (conversation memory, analytics).\n" +
    "Set EVAL_DATABASE_URL to an isolated database URL, or pass --i-know-what-im-doing to use the production database.\n",
  );
  process.exit(1);
}

import { DEFAULT_CHAT_MODEL } from "@/llm/config.js";

// ── Scenario definitions ──────────────────────────────────────────────────────

interface ConversationTurn {
  message: string;
  /**
   * What we expect: "text" | "menu" | "transaction" | "tool:<name>" | "any"
   * "any" means we just want to see it doesn't error.
   */
  expect?: string;
  note?: string;
}

interface ConversationScenario {
  id: string;
  category: string;
  turns: ConversationTurn[];
}

const SCENARIOS: ConversationScenario[] = [
  // ── GREETING FLOWS ────────────────────────────────────────────────────────
  {
    id: "greeting-then-long",
    category: "greeting",
    turns: [
      { message: "hey", expect: "text", note: "warm opener — should be text, not menu" },
      { message: "long eth", expect: "tool:avantis_prepare_trade", note: "should route to trade after greeting" },
      { message: "what's my position", expect: "tool:avantis_get_positions", note: "position check after trade context" },
    ],
  },
  {
    id: "greeting-gm",
    category: "greeting",
    turns: [
      { message: "gm", expect: "text", note: "gm greeting — text not menu" },
      { message: "what can you do?", expect: "any", note: "capabilities after greeting — should get useful info" },
    ],
  },
  {
    id: "greeting-whats-up",
    category: "greeting",
    turns: [
      { message: "What's up", expect: "text", note: "colloquial greeting — must NOT reach LLM with stale trade history" },
      { message: "swap $20 of eth", expect: "tool:uniswap_prepare_swap", note: "swap after casual opener" },
    ],
  },
  {
    id: "greeting-yo",
    category: "greeting",
    turns: [
      { message: "yo", expect: "text", note: "yo greeting — short but should be text" },
      { message: "swap $10 of eth", expect: "tool:uniswap_prepare_swap", note: "swap follows greeting" },
    ],
  },

  // ── SUPPORT FLOWS ─────────────────────────────────────────────────────────
  {
    id: "support-broken",
    category: "support",
    turns: [
      { message: "something is broken", expect: "any", note: "vague complaint — should troubleshoot first" },
      { message: "my swap failed", expect: "any", note: "more specific — should help" },
      { message: "can you help", expect: "any", note: "generic request — context says swap issue" },
    ],
  },
  {
    id: "support-direct",
    category: "support",
    turns: [
      { message: "i found a bug", expect: "any", note: "system prompt: troubleshoot first, don't call offer_support on first mention" },
      { message: "the transaction failed with an error", expect: "any" },
    ],
  },

  // ── PERP FLOWS ────────────────────────────────────────────────────────────
  {
    id: "perp-guided-flow",
    category: "perp",
    turns: [
      { message: "can you help me with perps?", expect: "any", note: "educational entry into perp wizard" },
      { message: "I want to go long", expect: "any", note: "user commits to direction" },
      { message: "long eth $50", expect: "tool:avantis_prepare_trade", note: "concrete trade" },
    ],
  },
  {
    id: "perp-direct",
    category: "perp",
    turns: [
      { message: "long eth $25", expect: "tool:avantis_prepare_trade" },
      { message: "what's my position now", expect: "tool:avantis_get_positions" },
    ],
  },
  {
    id: "perp-check-and-close",
    category: "perp",
    turns: [
      { message: "check my positions", expect: "tool:avantis_get_positions" },
      { message: "close my eth position", expect: "tool:avantis_close_position" },
    ],
  },
  // After trade prepared — user asks questions before signing, should NOT re-execute
  {
    id: "perp-post-trade-questions",
    category: "perp",
    turns: [
      { message: "long eth $30", expect: "tool:avantis_prepare_trade", note: "trade prepared" },
      { message: "what leverage is that?", expect: "text", note: "question about the trade — should answer, not re-execute" },
      { message: "what happens if eth drops 10%?", expect: "text", note: "risk question — explain liquidation, don't trade" },
      { message: "ok looks good", expect: "text", note: "casual confirmation — should NOT re-execute the trade" },
    ],
  },
  // After trade, user sends casual small talk — must not re-execute
  {
    id: "perp-post-trade-smalltalk",
    category: "perp",
    turns: [
      { message: "short btc $20", expect: "tool:avantis_prepare_trade", note: "trade set up" },
      { message: "nice", expect: "any", note: "small talk — LLM should reply briefly per system prompt, no re-execution" },
      { message: "what's up", expect: "text", note: "greeting pre-routed — must NOT re-trigger avantis_prepare_trade" },
    ],
  },
  // Perp question mid-session then real trade
  {
    id: "perp-question-then-trade",
    category: "perp",
    turns: [
      { message: "what is avantis?", expect: "text", note: "informational — should explain, no tool" },
      { message: "what leverage do you support?", expect: "text", note: "another info question" },
      { message: "ok long eth $40", expect: "tool:avantis_prepare_trade", note: "now a real trade" },
    ],
  },
  // Amount correction after trade prepared
  {
    id: "perp-amount-change",
    category: "perp",
    turns: [
      { message: "long eth $10", expect: "tool:avantis_prepare_trade", note: "initial trade" },
      { message: "actually make it $50", expect: "tool:avantis_prepare_trade", note: "user corrects amount — should re-prepare with $50" },
    ],
  },

  // ── CAPABILITIES FLOWS ────────────────────────────────────────────────────
  {
    id: "capabilities-what-can-you-do",
    category: "capabilities",
    turns: [
      { message: "what can you do", expect: "any", note: "capabilities question — text or menu both ok" },
      { message: "tell me more about earn", expect: "any", note: "follow-up on earn feature" },
    ],
  },
  {
    id: "capabilities-help-with-earn",
    category: "capabilities",
    turns: [
      { message: "can you help me with earn?", expect: "any", note: "help-with-X — should answer directly, not menu" },
      { message: "I have some USDC", expect: "any", note: "follow-up context" },
    ],
  },
  {
    id: "capabilities-menu-explicit",
    category: "capabilities",
    turns: [
      { message: "menu", expect: "menu", note: "explicit menu request — should return menu" },
    ],
  },
  {
    id: "capabilities-help-explicit",
    category: "capabilities",
    turns: [
      { message: "help", expect: "menu", note: "bare help — should return menu" },
    ],
  },

  // ── VAGUE / EDGE CASES ────────────────────────────────────────────────────
  {
    id: "vague-yo-then-trade",
    category: "vague",
    turns: [
      { message: "yo", expect: "text", note: "vague opener — should be text" },
      { message: "what can you do", expect: "any", note: "after greeting, capabilities question" },
      { message: "trade something", expect: "any", note: "vague trade intent" },
    ],
  },
  {
    id: "vague-test",
    category: "vague",
    turns: [
      { message: "test", expect: "any", note: "test message" },
      { message: "hello", expect: "text", note: "greeting follows" },
      { message: "show me options", expect: "menu", note: "explicit options request — menu" },
    ],
  },
  {
    id: "vague-smalltalk",
    category: "vague",
    turns: [
      { message: "thanks!", expect: "text", note: "thanks — brief text" },
      { message: "that was helpful", expect: "text", note: "smalltalk — text" },
    ],
  },

  // ── EARN / YIELD FLOWS ────────────────────────────────────────────────────
  {
    id: "earn-discovery",
    category: "earn",
    turns: [
      { message: "I want to earn on my USDC", expect: "tool:yield_compare", note: "earn intent → yield compare" },
      { message: "tell me more about Morpho", expect: "any", note: "follow-up on specific venue" },
    ],
  },
  {
    id: "earn-help-with-x",
    category: "earn",
    turns: [
      { message: "help me earn more on base", expect: "any", note: "help-with-X earn — should answer with earn info" },
      { message: "I have 500 USDC", expect: "any", note: "amount context" },
    ],
  },
  // Full earn journey: discover → ask question → deposit
  {
    id: "earn-full-journey",
    category: "earn",
    turns: [
      { message: "where can I earn yield on USDC?", expect: "tool:yield_compare", note: "rate discovery" },
      { message: "what's the difference between Moonwell and Morpho?", expect: "text", note: "comparison question — explain, no tool" },
      { message: "is Morpho safe?", expect: "text", note: "risk question — should answer in text" },
      { message: "ok deposit $200 on Morpho", expect: "tool:morpho_prepare_deposit", note: "user picks venue + amount — prepare deposit" },
    ],
  },
  // Earn then smalltalk then new intent — test context doesn't bleed
  {
    id: "earn-context-reset",
    category: "earn",
    turns: [
      { message: "earn on my USDC", expect: "tool:yield_compare", note: "earn flow starts" },
      { message: "nice thanks", expect: "text", note: "small talk — should be brief text, not another yield compare" },
      { message: "what's my ETH balance?", expect: "any", note: "totally different intent — should route to balance, not earn" },
    ],
  },

  // ── SWAP FLOWS ────────────────────────────────────────────────────────────
  {
    id: "swap-direct",
    category: "swap",
    turns: [
      { message: "buy $10 of DEGEN", expect: "tool:uniswap_prepare_swap", note: "direct swap" },
    ],
  },
  {
    id: "swap-after-greeting",
    category: "swap",
    turns: [
      { message: "hi", expect: "text", note: "greeting first" },
      { message: "swap $5 of ETH to USDC", expect: "tool:uniswap_prepare_swap", note: "swap after greeting" },
    ],
  },
  // Post-swap question — should NOT re-execute
  {
    id: "swap-post-tx-question",
    category: "swap",
    turns: [
      { message: "buy $15 of cbBTC", expect: "tool:uniswap_prepare_swap", note: "swap prepared" },
      { message: "what's the current price of cbBTC?", expect: "any", note: "price question — LLM should answer in text, not re-swap" },
      { message: "actually swap $30 instead", expect: "tool:uniswap_prepare_swap", note: "user corrects amount — re-prepare with $30" },
    ],
  },

  // ── SEND FLOWS (conversational / slang / multi-turn) ───────────────────────
  {
    id: "gift-stock-apple-mom",
    category: "gift",
    turns: [
      {
        message: "send mom 1 Apple stock",
        expect: "tool:gift_stock",
        note: "must NOT hit send_token or avantis_prepare_trade",
      },
    ],
  },
  {
    id: "gift-stock-usd-nvda",
    category: "gift",
    turns: [
      {
        message: "gift dad $25 of NVDA",
        expect: "tool:gift_stock",
        note: "dollar notional stock gift",
      },
    ],
  },
  {
    id: "gift-stock-not-avantis",
    category: "gift",
    turns: [
      {
        message: "send $10 of Apple to mom",
        expect: "tool:gift_stock",
        note: "B20 gift must not open a perp",
      },
    ],
  },

  {
    id: "send-after-greeting-slang",
    category: "send",
    turns: [
      { message: "hey", expect: "text", note: "greeting first" },
      {
        message: "shoot Degeneer .01 usdc",
        expect: "tool:send_token",
        note: "slang verb after greeting must still send",
      },
    ],
  },
  {
    id: "send-polite-tip-memo",
    category: "send",
    turns: [
      {
        message: "Can you tip Degeneer a penny in USDC for lunch?",
        expect: "tool:send_token",
        note: "polite + tip + word amount + memo in one turn",
      },
    ],
  },
  {
    id: "send-amount-followup",
    category: "send",
    turns: [
      {
        message: "send Degeneer usdc",
        expect: "any",
        note: "incomplete — should ask for amount (or still send if model invents — prefer ask)",
      },
      {
        message: ".01",
        expect: "tool:send_token",
        note: "amount follow-up completes the send",
      },
    ],
  },
  {
    id: "send-post-tx-no-refire",
    category: "send",
    turns: [
      {
        message: "send Degeneer .01 usdc for lunch",
        expect: "tool:send_token",
        note: "send prepared with memo",
      },
      {
        message: "nice",
        expect: "any",
        note: "small talk — must NOT re-fire send_token",
      },
      {
        message: "what's up",
        expect: "text",
        note: "greeting pre-routed — must NOT re-execute send",
      },
    ],
  },
  {
    id: "send-neg-informational",
    category: "send",
    turns: [
      {
        message: "what is USDC?",
        expect: "text",
        note: "informational — no send_token",
      },
    ],
  },

  // ── HISTORY POISONING REGRESSION ─────────────────────────────────────────
  // These directly test known regressions — casual messages after a trade action
  // must never cause the LLM to re-execute with stale context.
  // Bug: "confirm" was caught by isVagueOpener → returned "what do you need?" breaking confirmation
  {
    id: "history-confirm-flow",
    category: "history",
    turns: [
      { message: "long eth $30", expect: "tool:avantis_prepare_trade", note: "trade prepared" },
      { message: "confirm", expect: "any", note: "confirmation — must reach LLM, NOT return 'what do you need?'" },
    ],
  },
  {
    id: "history-yes-flow",
    category: "history",
    turns: [
      { message: "deposit $100 on Morpho", expect: "tool:morpho_prepare_deposit", note: "deposit prepared" },
      { message: "yes", expect: "any", note: "agreement — must reach LLM with context, not get vague fallback" },
    ],
  },
  // Bug: "hello??" not caught as greeting (trailing ? not allowed)
  {
    id: "greeting-with-punctuation",
    category: "greeting",
    turns: [
      { message: "hello??", expect: "text", note: "greeting with trailing ?? — must be caught as greeting" },
      { message: "hi!", expect: "text", note: "exclamation mark greeting" },
    ],
  },
  {
    id: "history-lets-do-it",
    category: "history",
    turns: [
      { message: "can you create a group for me?", expect: "any", note: "explains token launch flow" },
      { message: "let's do it", expect: "any", note: "confirmation — must reach LLM, not return 'what do you need?'" },
    ],
  },
  {
    id: "positions-see-phrasing",
    category: "perp",
    turns: [
      { message: "can I see positions?", expect: "tool:avantis_get_positions", note: "'see' wasn't in view keyword list" },
    ],
  },
  {
    id: "history-poison-whats-up",
    category: "history",
    turns: [
      { message: "long btc $20", expect: "tool:avantis_prepare_trade", note: "trade prepared — enters history" },
      { message: "What's up", expect: "text", note: "THE BUG: this was firing avantis_prepare_trade again" },
      { message: "yo", expect: "text", note: "another casual opener — still must not re-trigger trade" },
    ],
  },
  {
    id: "history-poison-swap",
    category: "history",
    turns: [
      { message: "buy $10 of DEGEN", expect: "tool:uniswap_prepare_swap", note: "swap prepared" },
      { message: "What's up", expect: "text", note: "casual message after swap — must NOT re-swap" },
      { message: "check my positions", expect: "tool:avantis_get_positions", note: "different intent should route correctly" },
    ],
  },
  {
    id: "history-new-intent-after-trade",
    category: "history",
    turns: [
      { message: "long eth $25", expect: "tool:avantis_prepare_trade", note: "perp trade" },
      { message: "actually buy some USDC instead", expect: "tool:uniswap_prepare_swap", note: "pivot to swap — history must not re-fire the perp" },
    ],
  },

  // ── DEFI Q&A (text-only flows) ────────────────────────────────────────────
  // The LLM must answer these as text without calling any tools.
  {
    id: "defi-qa-what-is-perp",
    category: "defi-qa",
    turns: [
      { message: "what is a perp?", expect: "text", note: "education question — explain in text, no tools" },
      { message: "what's liquidation?", expect: "text", note: "follow-up — still educational, no tools" },
      { message: "ok long eth $20", expect: "tool:avantis_prepare_trade", note: "now they're ready to trade" },
    ],
  },
  {
    id: "defi-qa-what-is-avantis",
    category: "defi-qa",
    turns: [
      { message: "what is avantis?", expect: "text", note: "protocol question — explain, no tool" },
      { message: "is it safe?", expect: "text", note: "trust question — answer in text" },
    ],
  },
  // Bug: "analyze [contract]" was misrouting to yield_compare
  {
    id: "analyze-no-yield",
    category: "defi-qa",
    turns: [
      { message: "analyze 0x4200000000000000000000000000000000000006", expect: "any", note: "analyze intent must not fire yield_compare" },
    ],
  },
  // Bug: world cup follow-ups ("who's the favorite?") caught by isVagueOpener
  {
    id: "worldcup-followup",
    category: "defi-qa",
    turns: [
      { message: "show me today's world cup matches", expect: "any", note: "match listing" },
      { message: "who's the favorite?", expect: "any", note: "3-word follow-up — must reach LLM, not return 'what do you need?'" },
      { message: "bet $20 on Brazil", expect: "any", note: "bet after context" },
    ],
  },
  {
    id: "defi-qa-what-is-morpho",
    category: "defi-qa",
    turns: [
      { message: "what is morpho?", expect: "text", note: "protocol question" },
      { message: "how does it compare to Aave?", expect: "text", note: "comparison question" },
      { message: "deposit $100 on Morpho", expect: "tool:morpho_prepare_deposit", note: "after learning, they act" },
    ],
  },
];

// ── Harness runner ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let modelFlag: string | undefined;
  let concurrency = 2;
  let filterCategory: string | undefined;
  let filterScenario: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) {
      modelFlag = args[++i];
    } else if (args[i] === "--concurrency" && args[i + 1]) {
      concurrency = Math.max(1, Number(args[++i]) || 2);
    } else if (args[i] === "--category" && args[i + 1]) {
      filterCategory = args[++i];
    } else if (args[i] === "--scenario" && args[i + 1]) {
      filterScenario = args[++i];
    }
  }
  if (modelFlag) process.env.DEFAULT_MODEL = modelFlag;
  return {
    model: modelFlag ?? DEFAULT_CHAT_MODEL,
    concurrency,
    filterCategory,
    filterScenario,
  };
}

interface TurnResult {
  turn: number;
  message: string;
  expected?: string;
  note?: string;
  responseType: string;
  firstTool?: string;
  firstToolArgs?: Record<string, unknown>;
  latencyMs: number;
  preview: string;
  pass: boolean | null; // null when expect is "any"
}

interface ScenarioResult {
  scenario: ConversationScenario;
  turns: TurnResult[];
  error?: string;
}

function checkExpectation(
  expected: string | undefined,
  responseType: string,
  firstTool: string | undefined,
): boolean | null {
  if (!expected || expected === "any") return null;
  if (expected === "text") return responseType === "text";
  if (expected === "menu") return responseType === "menu";
  if (expected === "transaction") return responseType === "transaction";
  if (expected.startsWith("tool:")) {
    const toolName = expected.slice(5);
    return firstTool === toolName;
  }
  return null;
}

function previewResponse(response: { type: string; [key: string]: unknown }): string {
  if ("text" in response && typeof response.text === "string") {
    return response.text.slice(0, 80).replace(/\n/g, " ");
  }
  if ("description" in response && typeof response.description === "string") {
    return `[menu] ${response.description.slice(0, 60)}`;
  }
  if (response.type === "menu") return "[menu]";
  return `[${response.type}]`;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

const EVAL_WALLET =
  process.env.ROUTING_EVAL_WALLET?.trim() || "0x22209cfc1397832f32160239c902b10a624cab1a";

const { DiscoveryAI } = await import("@/discovery/ai.js");

async function runScenario(
  ai: InstanceType<typeof DiscoveryAI>,
  scenario: ConversationScenario,
): Promise<ScenarioResult> {
  const convId = `conv-test-${scenario.id}`;
  const turnResults: TurnResult[] = [];

  for (let i = 0; i < scenario.turns.length; i++) {
    const turn = scenario.turns[i];
    const recorder = { invocations: [] as Array<{ tool: string; args: Record<string, unknown> }> };

    const ctx = {
      inboxId: convId,
      conversationId: convId,
      walletAddress: EVAL_WALLET,
      userMessage: turn.message,
      routingEvalRecorder: recorder,
    };

    const t0 = Date.now();
    let response: { type: string; [key: string]: unknown };
    try {
      response = await ai.respond(turn.message, ctx) as typeof response;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      turnResults.push({
        turn: i + 1,
        message: turn.message,
        expected: turn.expect,
        note: turn.note,
        responseType: "error",
        latencyMs: Date.now() - t0,
        preview: `ERROR: ${msg}`,
        pass: false,
      });
      continue;
    }

    const latencyMs = Date.now() - t0;
    const first = recorder.invocations[0];
    const firstTool = first?.tool;
    const firstToolArgs = first?.args;
    const pass = checkExpectation(turn.expect, response.type, firstTool);

    turnResults.push({
      turn: i + 1,
      message: turn.message,
      expected: turn.expect,
      note: turn.note,
      responseType: response.type,
      firstTool,
      firstToolArgs,
      latencyMs,
      preview: previewResponse(response),
      pass,
    });
  }

  return { scenario, turns: turnResults };
}

function passBadge(pass: boolean | null): string {
  if (pass === null) return "  ";
  return pass ? "✅" : "❌";
}

function printScenarioResult(result: ScenarioResult): void {
  const allAsserted = result.turns.filter((t) => t.pass !== null);
  const passing = allAsserted.filter((t) => t.pass === true).length;
  const failing = allAsserted.filter((t) => t.pass === false).length;
  const header = failing === 0 ? "✅" : "❌";

  console.log(`\n${header} [${result.scenario.category}] ${result.scenario.id}`);

  if (result.error) {
    console.log(`  💥 scenario error: ${result.error}`);
    return;
  }

  for (const t of result.turns) {
    const badge = passBadge(t.pass);
    const toolStr = t.firstTool
      ? ` → tool:${t.firstTool}`
      : "";
    const typeStr = `[${t.responseType}${toolStr}]`;
    const expectStr = t.expected && t.expected !== "any" ? ` (expected: ${t.expected})` : "";
    const noteStr = t.note ? ` — ${t.note}` : "";
    console.log(
      `  ${badge} turn ${t.turn} "${t.message}" → ${typeStr}${expectStr} (${t.latencyMs}ms)`,
    );
    console.log(`       preview: ${t.preview}`);
    if (noteStr) console.log(`       note: ${t.note}`);
  }

  if (allAsserted.length > 0) {
    console.log(`  ── ${passing}/${allAsserted.length} assertions pass`);
  }
}

function printSummary(
  results: ScenarioResult[],
  categories: Map<string, { pass: number; fail: number; skip: number }>,
): void {
  console.log("\n" + "═".repeat(60));
  console.log("MULTI-TURN CONVERSATION TEST SUMMARY");
  console.log("═".repeat(60));

  for (const [cat, stats] of categories) {
    const total = stats.pass + stats.fail;
    const skipStr = stats.skip > 0 ? ` (${stats.skip} unasserted)` : "";
    const badge = stats.fail === 0 ? "✅" : "❌";
    console.log(`${badge} ${cat.padEnd(15)} ${stats.pass}/${total} pass${skipStr}`);
  }

  const allTurns = results.flatMap((r) => r.turns);
  const asserted = allTurns.filter((t) => t.pass !== null);
  const totalPass = asserted.filter((t) => t.pass === true).length;
  const totalFail = asserted.filter((t) => t.pass === false).length;
  const totalSkip = allTurns.filter((t) => t.pass === null).length;
  const avgMs =
    allTurns.length > 0
      ? Math.round(allTurns.reduce((s, t) => s + t.latencyMs, 0) / allTurns.length)
      : 0;

  console.log("═".repeat(60));
  console.log(
    `TOTAL: ${totalPass}/${asserted.length} assertions pass` +
      (totalSkip > 0 ? `, ${totalSkip} unasserted turns` : "") +
      `, avg ${avgMs}ms/turn`,
  );
  console.log("═".repeat(60));

  // Print broken paths separately for easy scanning
  const broken = results.flatMap((r) =>
    r.turns
      .filter((t) => t.pass === false)
      .map((t) => ({ scenario: r.scenario.id, category: r.scenario.category, turn: t })),
  );

  if (broken.length > 0) {
    console.log("\n⚠️  BROKEN PATHS:");
    for (const b of broken) {
      console.log(
        `  [${b.category}] ${b.scenario} turn ${b.turn.turn}: "${b.turn.message}"`,
      );
      console.log(
        `    expected: ${b.turn.expected} | got: ${b.turn.responseType}${b.turn.firstTool ? ` → ${b.turn.firstTool}` : ""}`,
      );
      console.log(`    preview: ${b.turn.preview}`);
    }
  }
}

async function main() {
  const { model, concurrency, filterCategory, filterScenario } = parseArgs();

  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.error("OPENAI_API_KEY not set");
    process.exit(1);
  }

  let scenarios = SCENARIOS;
  if (filterCategory) {
    scenarios = scenarios.filter((s) => s.category === filterCategory);
  }
  if (filterScenario) {
    scenarios = scenarios.filter((s) => s.id.includes(filterScenario));
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(
    `MULTI-TURN CONVERSATION TEST — OpenAI ${model}`,
  );
  console.log(
    `scenarios=${scenarios.length} concurrency=${concurrency} wallet=${EVAL_WALLET.slice(0, 10)}…`,
  );
  console.log("═".repeat(60));

  const ai = new DiscoveryAI({ model });

  // Run scenarios with limited concurrency, but each scenario's turns are sequential
  const results = await mapPool(scenarios, concurrency, async (scenario) => {
    // Separate AI instance per scenario so conversation histories don't bleed
    const scenarioAi = new DiscoveryAI({ model });
    try {
      return await runScenario(scenarioAi, scenario);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { scenario, turns: [], error: msg };
    }
  });

  // Print results
  const categories = new Map<string, { pass: number; fail: number; skip: number }>();
  for (const result of results) {
    printScenarioResult(result);
    const cat = result.scenario.category;
    if (!categories.has(cat)) categories.set(cat, { pass: 0, fail: 0, skip: 0 });
    const stats = categories.get(cat)!;
    for (const t of result.turns) {
      if (t.pass === true) stats.pass++;
      else if (t.pass === false) stats.fail++;
      else stats.skip++;
    }
  }

  printSummary(results, categories);

  const anyFail = results.some((r) => r.turns.some((t) => t.pass === false));
  process.exit(anyFail ? 1 : 0);
}

main();
