/**
 * Production routing eval — runs each case through DiscoveryAI.respond()
 * (deterministic harness + fat tool skills + full LLM loop + real tool handlers).
 *
 * Usage:
 *   bun packages/core/src/discovery/eval/run-routing-eval.ts
 *   bun packages/core/src/discovery/eval/run-routing-eval.ts --model gpt-5.4-mini
 *   bun packages/core/src/discovery/eval/run-routing-eval.ts --concurrency 1
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
  let concurrency = 3;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) {
      modelFlag = args[++i];
    } else if (args[i] === "--concurrency" && args[i + 1]) {
      concurrency = Math.max(1, Number(args[++i]) || 3);
    }
  }
  if (modelFlag) process.env.DEFAULT_MODEL = modelFlag;
  return { model: modelFlag ?? DEFAULT_CHAT_MODEL, concurrency };
}

interface EvalResult {
  caseId: string;
  pass: boolean;
  skipped?: boolean;
  expected: string;
  actual: string;
  latencyMs: number;
  responseType?: string;
}

function expectedLabel(c: RoutingEvalCase): string {
  if (c.expectNoTool) return "text-only";
  if (c.expectToolArgs) return `${c.expectTool}(${JSON.stringify(c.expectToolArgs)})`;
  return c.expectTool ?? "?";
}

function toolArgMatches(key: string, expected: unknown, actual: unknown): boolean {
  if (key === "amount" && typeof expected === "string" && typeof actual === "string") {
    const a = Number(expected);
    const b = Number(actual);
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  }
  if (
    (key === "asset" || key === "to" || key === "memo") &&
    typeof expected === "string" &&
    typeof actual === "string"
  ) {
    return expected.toLowerCase() === actual.toLowerCase();
  }
  return actual === expected;
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
    if (!toolArgMatches(k, v, toolArgs?.[k])) return false;
  }
  return true;
}

function caseRequiresAvantis(c: RoutingEvalCase): boolean {
  if (c.expectTool?.startsWith("avantis_")) return true;
  return false;
}

function caseRequiresWorldCup(c: RoutingEvalCase): boolean {
  if (c.expectTool?.startsWith("worldcup_")) return true;
  return c.id.startsWith("wc-");
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

async function evalProductionCase(model: string, testCase: RoutingEvalCase): Promise<EvalResult> {
  if (!AVANTIS_ENABLED && caseRequiresAvantis(testCase)) {
    return {
      caseId: testCase.id,
      pass: true,
      skipped: true,
      expected: expectedLabel(testCase),
      actual: "skipped (AVANTIS_ENABLED=false)",
      latencyMs: 0,
    };
  }

  if (!WORLD_CUP_ENABLED && caseRequiresWorldCup(testCase)) {
    return {
      caseId: testCase.id,
      pass: true,
      skipped: true,
      expected: expectedLabel(testCase),
      actual: "skipped (WORLD_CUP_ENABLED=false)",
      latencyMs: 0,
    };
  }

  const recorder = { invocations: [] as Array<{ tool: string; args: Record<string, unknown> }> };
  const convId = `routing-eval-${testCase.id}`;
  const ctx = {
    inboxId: convId,
    conversationId: convId,
    walletAddress: EVAL_WALLET,
    userMessage: testCase.message,
    routingEvalRecorder: recorder,
  };

  const ai = new DiscoveryAI({ model });
  const t0 = Date.now();
  const response = await ai.respond(testCase.message, ctx);
  const latencyMs = Date.now() - t0;

  const first = recorder.invocations[0];
  const toolName = first?.tool;
  const toolArgs = first?.args;
  const gotText = "text" in response && Boolean(response.text?.trim());

  return {
    caseId: testCase.id,
    pass: matchesCase(testCase, toolName, toolArgs, gotText),
    expected: expectedLabel(testCase),
    actual: actualLabel(toolName, toolArgs, gotText),
    latencyMs,
    responseType: response.type,
  };
}

async function runSuite(label: string, concurrency: number, model: string) {
  console.log(`\n=== ${label} (concurrency ${concurrency}) ===`);
  console.log(
    `path=DiscoveryAI.respond() wallet=${EVAL_WALLET.slice(0, 10)}… avantis=${AVANTIS_ENABLED}`,
  );

  const results = await mapPool(ROUTING_EVAL_CASES, concurrency, async (c) => {
    try {
      return await evalProductionCase(model, c);
    } catch (e) {
      return {
        caseId: c.id,
        pass: false,
        expected: expectedLabel(c),
        actual: `error: ${(e as Error).message}`,
        latencyMs: 0,
      };
    }
  });

  for (const r of results) {
    if (r.skipped) {
      console.log(`⏭️  ${r.caseId}: skipped (${r.expected}) — avantis disabled`);
      continue;
    }
    const typeNote = r.responseType ? ` [${r.responseType}]` : "";
    console.log(
      `${r.pass ? "✅" : "❌"} ${r.caseId}: expected ${r.expected}, got ${r.actual}${typeNote} (${r.latencyMs}ms)`,
    );
  }

  const scored = results.filter((r) => !r.skipped);
  const passed = scored.filter((r) => r.pass).length;
  const skipped = results.filter((r) => r.skipped).length;
  const avgMs = scored.length
    ? Math.round(scored.reduce((s, r) => s + r.latencyMs, 0) / scored.length)
    : 0;
  console.log(
    `\n${label}: ${passed}/${scored.length} passed` +
      (skipped ? `, ${skipped} skipped` : "") +
      `, avg ${avgMs}ms`,
  );
  return { passed, total: scored.length };
}

const { model, concurrency } = parseArgs();

if (!process.env.BANKR_LLM_API_KEY?.trim()) {
  console.error("BANKR_LLM_API_KEY not set");
  process.exit(1);
}

const r = await runSuite(`Production routing — Bankr ${model}`, concurrency, model);
process.exit(r.passed < r.total ? 1 : 0);
