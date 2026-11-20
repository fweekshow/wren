/**
 * Live single-thread conversation runner for DiscoveryAI.
 *
 * Unlike the flat routing eval (run-routing-eval.ts), which sends every test
 * question through a FRESH conversationId so the agent never holds context,
 * this harness drives ONE continuous conversation: a single DiscoveryAI
 * instance + a single conversationId, so history, prefix cache, and the
 * per-user memory snapshot all accumulate exactly as they do for a real user.
 *
 * It replays the same question bank used by the flat test (ROUTING_EVAL_CASES)
 * so you still get expected-vs-actual signal, but now you can confirm the agent
 * behaves coherently across a real, context-carrying session — and spot where
 * shared context changes routing (which the isolated test can never reveal).
 *
 * Usage:
 *   bun packages/core/src/discovery/eval/live-conversation.ts
 *   bun packages/core/src/discovery/eval/live-conversation.ts --model gpt-5.4-mini
 *   bun packages/core/src/discovery/eval/live-conversation.ts --category earn
 *   bun packages/core/src/discovery/eval/live-conversation.ts --quiet   # summary only
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../../../../");
loadEnv({ path: resolve(repoRoot, "apps/basemate-tba/.env") });
loadEnv({ path: resolve(repoRoot, "packages/core/.env") });

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

import { AVANTIS_ENABLED } from "@basemate/avantis-client";
import { WORLD_CUP_ENABLED } from "@/worldcup/constants.js";
import { DEFAULT_CHAT_MODEL } from "@/llm/config.js";
import { ROUTING_EVAL_CASES, type RoutingEvalCase } from "@/discovery/eval/cases.js";

function parseArgs() {
  const args = process.argv.slice(2);
  let modelFlag: string | undefined;
  let category: string | undefined;
  let quiet = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) modelFlag = args[++i];
    else if (args[i] === "--category" && args[i + 1]) category = args[++i];
    else if (args[i] === "--quiet") quiet = true;
  }
  if (modelFlag) process.env.DEFAULT_MODEL = modelFlag;
  return { model: modelFlag ?? DEFAULT_CHAT_MODEL, category, quiet };
}

function expectedLabel(c: RoutingEvalCase): string {
  if (c.expectNoTool) return "text-only";
  if (c.expectToolArgs) return `${c.expectTool}(${JSON.stringify(c.expectToolArgs)})`;
  return c.expectTool ?? "any";
}

function actualLabel(
  toolName: string | undefined,
  toolArgs: Record<string, unknown> | undefined,
  gotText: boolean,
): string {
  if (toolName) {
    return toolArgs && Object.keys(toolArgs).length
      ? `${toolName}(${JSON.stringify(toolArgs)})`
      : toolName;
  }
  return gotText ? "text-only" : "empty";
}

function matchesCase(
  c: RoutingEvalCase,
  toolName: string | undefined,
  toolArgs: Record<string, unknown> | undefined,
  gotText: boolean,
): boolean {
  if (c.expectNoTool) return !toolName && gotText;
  if (c.acceptTextOnly && !toolName && gotText) return true;
  if (!c.expectTool || toolName !== c.expectTool) return false;
  if (!c.expectToolArgs) return true;
  for (const [k, v] of Object.entries(c.expectToolArgs)) {
    if (toolArgs?.[k] !== v) return false;
  }
  return true;
}

function caseRequiresAvantis(c: RoutingEvalCase): boolean {
  return Boolean(c.expectTool?.startsWith("avantis_"));
}

function caseRequiresWorldCup(c: RoutingEvalCase): boolean {
  if (c.expectTool?.startsWith("worldcup_")) return true;
  return c.id.startsWith("wc-");
}

/** Best-effort category from the case id prefix (pnl-…, earn-…, wc-…). */
function categoryOf(c: RoutingEvalCase): string {
  const prefix = c.id.split("-")[0];
  if (prefix === "wc") return "worldcup";
  return prefix;
}

function previewResponse(response: { type: string; [k: string]: unknown }): string {
  if ("text" in response && typeof response.text === "string") {
    return response.text.slice(0, 100).replace(/\n/g, " ");
  }
  if ("description" in response && typeof response.description === "string") {
    return `[menu] ${String(response.description).slice(0, 80)}`;
  }
  return `[${response.type}]`;
}

const EVAL_WALLET =
  process.env.ROUTING_EVAL_WALLET?.trim() || "0x22209cfc1397832f32160239c902b10a624cab1a";

const { DiscoveryAI } = await import("@/discovery/ai.js");
const { UserMemoryAdapter } = await import("@/discovery/adapters/userMemory.adapter.js");
const { ConversationMemoryAdapter } = await import("@/discovery/adapters/conversationMemory.adapter.js");

interface TurnOutcome {
  case: RoutingEvalCase;
  skipped: boolean;
  pass: boolean;
  expected: string;
  actual: string;
  responseType: string;
  preview: string;
  latencyMs: number;
}

async function main() {
  const { model, category, quiet } = parseArgs();

  if (!process.env.BANKR_LLM_API_KEY?.trim()) {
    console.error("BANKR_LLM_API_KEY not set");
    process.exit(1);
  }

  // Make sure the memory snapshot table exists so the continuous session
  // exercises the real read/write path (instead of swallowing missing-table
  // errors). Best-effort — a missing DATABASE_URL just means no memory.
  await UserMemoryAdapter.createTable().catch(() => {});
  await ConversationMemoryAdapter.createTable().catch(() => {});

  let cases = ROUTING_EVAL_CASES;
  if (category) cases = cases.filter((c) => categoryOf(c) === category);

  console.log(`\n${"═".repeat(64)}`);
  console.log(`LIVE CONVERSATION — single thread, Bankr ${model}`);
  console.log(
    `turns=${cases.length} wallet=${EVAL_WALLET.slice(0, 10)}… avantis=${AVANTIS_ENABLED}`,
  );
  console.log("one conversationId — context carries across every message");
  console.log("═".repeat(64));

  const ai = new DiscoveryAI({ model });
  // Single, stable conversation + inbox so history + memory accumulate.
  const convId = `live-convo-${Date.now()}`;

  const outcomes: TurnOutcome[] = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];

    if (!AVANTIS_ENABLED && caseRequiresAvantis(c)) {
      outcomes.push({
        case: c,
        skipped: true,
        pass: true,
        expected: expectedLabel(c),
        actual: "skipped (avantis disabled)",
        responseType: "skipped",
        preview: "",
        latencyMs: 0,
      });
      if (!quiet) console.log(`\n⏭️  turn ${i + 1} "${c.message}" — skipped (avantis disabled)`);
      continue;
    }

    if (!WORLD_CUP_ENABLED && caseRequiresWorldCup(c)) {
      outcomes.push({
        case: c,
        skipped: true,
        pass: true,
        expected: expectedLabel(c),
        actual: "skipped (world cup disabled)",
        responseType: "skipped",
        preview: "",
        latencyMs: 0,
      });
      if (!quiet) console.log(`\n⏭️  turn ${i + 1} "${c.message}" — skipped (world cup disabled)`);
      continue;
    }

    const recorder = {
      invocations: [] as Array<{ tool: string; args: Record<string, unknown> }>,
    };
    const ctx = {
      inboxId: convId,
      conversationId: convId,
      walletAddress: EVAL_WALLET,
      userMessage: c.message,
      routingEvalRecorder: recorder,
    };

    const t0 = Date.now();
    let response: { type: string; [k: string]: unknown };
    try {
      response = (await ai.respond(c.message, ctx)) as typeof response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outcomes.push({
        case: c,
        skipped: false,
        pass: false,
        expected: expectedLabel(c),
        actual: `error: ${msg}`,
        responseType: "error",
        preview: msg,
        latencyMs: Date.now() - t0,
      });
      if (!quiet) console.log(`\n💥 turn ${i + 1} "${c.message}" — ERROR: ${msg}`);
      continue;
    }
    const latencyMs = Date.now() - t0;

    const first = recorder.invocations[0];
    const gotText = "text" in response && Boolean((response as { text?: string }).text?.trim());
    const pass = matchesCase(c, first?.tool, first?.args, gotText);

    const outcome: TurnOutcome = {
      case: c,
      skipped: false,
      pass,
      expected: expectedLabel(c),
      actual: actualLabel(first?.tool, first?.args, gotText),
      responseType: response.type,
      preview: previewResponse(response),
      latencyMs,
    };
    outcomes.push(outcome);

    if (!quiet) {
      const badge = pass ? "✅" : "⚠️ ";
      console.log(`\n${badge} turn ${i + 1}  👤 "${c.message}"`);
      console.log(`        expected ${outcome.expected}  →  got ${outcome.actual} [${outcome.responseType}] (${latencyMs}ms)`);
      console.log(`        🤖 ${outcome.preview}`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const scored = outcomes.filter((o) => !o.skipped);
  const held = scored.filter((o) => o.pass).length;
  const diverged = scored.filter((o) => !o.pass);
  const skipped = outcomes.filter((o) => o.skipped).length;
  const avgMs = scored.length
    ? Math.round(scored.reduce((s, o) => s + o.latencyMs, 0) / scored.length)
    : 0;

  console.log(`\n${"═".repeat(64)}`);
  console.log("LIVE CONVERSATION SUMMARY");
  console.log("═".repeat(64));
  console.log(
    `${held}/${scored.length} turns matched the isolated expectation` +
      (skipped ? `, ${skipped} skipped` : "") +
      `, avg ${avgMs}ms/turn`,
  );

  if (diverged.length) {
    console.log(
      `\n⚠️  ${diverged.length} turn(s) routed differently than the flat test expects.`,
    );
    console.log(
      "   In a shared-context conversation this can be correct (the agent is using prior turns).",
    );
    console.log("   Review each to confirm it's intentional, not context bleed:\n");
    for (const o of diverged) {
      console.log(`   • "${o.case.message}"  expected ${o.expected}  got ${o.actual}`);
      if (o.case.note) console.log(`       note: ${o.case.note}`);
    }
  } else {
    console.log("\n✅ Every turn held its expected routing even with full context carried.");
  }
  console.log("═".repeat(64));

  // Exit non-zero only on hard errors — divergences are informational because
  // shared context legitimately changes routing.
  const hadError = outcomes.some((o) => o.responseType === "error");
  process.exit(hadError ? 1 : 0);
}

main();
