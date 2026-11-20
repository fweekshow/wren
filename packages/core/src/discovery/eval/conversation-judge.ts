/**
 * Graded conversational eval for DiscoveryAI — the "does the agent hold up in a
 * real conversation" gate.
 *
 * Three independent layers over ONE continuous context per persona:
 *   1. User Simulator  — an LLM role-plays a persona and drives a realistic
 *      multi-turn conversation (single conversationId, like a real user).
 *   2. LLM-as-Judge    — a SEPARATE model (Claude, since the agent runs on gpt)
 *      grades each agent turn against a rubric it can't game: did it actually
 *      answer the question, route correctly, stay in persona, keep emojis blue,
 *      avoid repetition/loops, avoid the generic fallback.
 *   3. Objective checks — deterministic, model-free: never emit DEFAULT_REPLY,
 *      never repeat the identical reply twice in a row, never go empty.
 *
 * Why this exists: flat single-prompt probes (run-routing-eval) and the
 * self-flagging user probe (ai-probe) both MISS conversational failures — e.g.
 * the agent dumping a positions card instead of answering "what's the
 * liquidation price?". An independent judge catches those.
 *
 * Usage:
 *   bun packages/core/src/discovery/eval/conversation-judge.ts
 *   bun packages/core/src/discovery/eval/conversation-judge.ts --turns 8
 *   bun packages/core/src/discovery/eval/conversation-judge.ts --persona degen
 *   bun packages/core/src/discovery/eval/conversation-judge.ts --runs 2   # repeat each persona (flakiness)
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import OpenAI from "openai";

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

import {
  DEFAULT_CHAT_MODEL,
  getAnthropicApiKey,
  getAnthropicDefaultModel,
} from "@/llm/config.js";

// ── Personas (each has a GOAL so the judge knows what the user wanted) ─────────

interface Persona {
  name: string;
  goal: string;
  systemPrompt: string;
  scriptedMessages?: string[];
}

const PERSONAS: Persona[] = [
  {
    name: "curious-normie",
    goal: "Understand basic DeFi and eventually try one small action. Asks lots of 'what is X' / 'is it safe' questions and expects real answers, not menus.",
    systemPrompt: `You are a regular person, new to crypto, texting Basemate on Base App. You're curious and a little unsure. Ask genuine questions ("what is avantis?", "what's a perp?", "is morpho safe?", "what's liquidation?") and EXPECT a real answer before you act. React naturally, ask follow-ups, occasionally go off-topic. Keep messages short, lowercase, real texting style.`,
  },
  {
    name: "defi-degen",
    goal: "Get specific factual answers (max leverage, liquidation price, fees) AND execute trades. Gets annoyed if the agent dodges a direct question by dumping a card.",
    systemPrompt: `You are a DeFi power user testing Basemate. Ask sharp, SPECIFIC questions you expect direct answers to: "what's the max leverage on BTC?", "what's the liquidation price for trade #0?", "does adding $1 collateral move my liq?". Mix in trades and position checks. If the agent dodges your actual question (e.g. dumps a positions list instead of answering), push back. Short, natural messages.`,
  },
  {
    name: "impatient",
    goal: "Do things fast with terse messages; should not get stuck in loops or repeated identical replies.",
    systemPrompt: `You are an impatient user firing terse messages: "gm", "long eth", "how much", "close it", "ok", "nice", "what's up", "do it", "wait what". Stress-test conversational context and repetition. If the agent repeats itself or seems confused, get more terse. Very short messages.`,
  },
  {
    name: "memory-recall",
    goal: "Establish durable preferences early, move beyond the short history window, then verify Basemate recalls the preferences without being reminded.",
    systemPrompt: `You are testing Basemate's long-term memory. Start by stating durable preferences, then ask unrelated DeFi questions for several turns. Near the end, ask what Basemate remembers about your risk and earn preferences. Keep messages short and natural.`,
    scriptedMessages: [
      "remember i prefer low-risk ETH stuff and morpho for earn",
      "what is a perp?",
      "what makes liquidation happen?",
      "what's morpho in simple terms?",
      "is aave different from morpho?",
      "what's trending on base?",
      "ok cool",
      "what do you remember about my risk and earn preferences?",
    ],
  },
];

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let turns = 8;
  let runs = 1;
  let personaFilter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--turns" && args[i + 1]) turns = Number(args[++i]);
    else if (args[i] === "--runs" && args[i + 1]) runs = Number(args[++i]);
    else if (args[i] === "--persona" && args[i + 1]) personaFilter = args[++i];
  }
  return { turns, runs, personaFilter };
}

// ── Types ───────────────────────────────────────────────────────────────────

interface Turn {
  index: number;
  user: string;
  agentText: string;
  responseType: string;
  tool?: string;
  latencyMs: number;
}

interface ObjectiveIssue {
  turn: number;
  kind: "fallback" | "repeat" | "empty";
  detail: string;
}

interface JudgeTurn {
  turn: number;
  pass: boolean;
  failed: string[];
  note: string;
}

interface JudgeVerdict {
  overall_pass: boolean;
  summary: string;
  turns: JudgeTurn[];
}

const EVAL_WALLET =
  process.env.ROUTING_EVAL_WALLET?.trim() || "0x22209cfc1397832f32160239c902b10a624cab1a";

const DEFAULT_REPLY_SIGNATURE = "didn't quite catch that";

const { DiscoveryAI } = await import("@/discovery/ai.js");
const { UserMemoryAdapter } = await import("@/discovery/adapters/userMemory.adapter.js");
const { ConversationMemoryAdapter } = await import("@/discovery/adapters/conversationMemory.adapter.js");

// ── Agent reply formatting (for the user-sim + the judge transcript) ──────────

function agentReplyText(response: { type: string; [k: string]: unknown }): string {
  if ("text" in response && typeof response.text === "string") return response.text;
  if (response.type === "menu") return "[showed capabilities menu]";
  const t = (response as { text?: string }).text;
  return t ? `[${response.type}] ${t}` : `[${response.type}]`;
}

// ── User Simulator ────────────────────────────────────────────────────────────

async function runSession(
  ai: InstanceType<typeof DiscoveryAI>,
  userLlm: OpenAI,
  userModel: string,
  persona: Persona,
  maxTurns: number,
): Promise<Turn[]> {
  const convId = `judge-${persona.name}-${Date.now()}`;
  const ctx = { inboxId: convId, conversationId: convId, walletAddress: EVAL_WALLET };
  const simHistory: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: persona.systemPrompt },
  ];
  const turns: Turn[] = [];

  for (let i = 0; i < maxTurns; i++) {
    const scriptedText = persona.scriptedMessages?.[i];
    let userText = scriptedText;
    if (!userText) {
      const userCompletion = await userLlm.chat.completions.create({
        model: userModel,
        messages: [
          ...simHistory,
          {
            role: "user",
            content:
              i === 0
                ? "Start the conversation with your first message to Basemate."
                : "What do you say next? Reply with ONLY the message text.",
          },
        ],
        max_completion_tokens: 80,
        temperature: 0.9,
      });
      userText = userCompletion.choices[0]?.message?.content?.trim() || "hey";
    }

    const recorder = {
      invocations: [] as Array<{ tool: string; args: Record<string, unknown> }>,
    };
    const t0 = Date.now();
    const response = (await ai.respond(userText, {
      ...ctx,
      userMessage: userText,
      routingEvalRecorder: recorder,
    })) as { type: string; [k: string]: unknown };
    const latencyMs = Date.now() - t0;
    const agentText = agentReplyText(response);

    turns.push({
      index: i + 1,
      user: userText,
      agentText,
      responseType: response.type,
      tool: recorder.invocations[0]?.tool,
      latencyMs,
    });

    simHistory.push(
      { role: "assistant", content: `You sent: "${userText}"` },
      { role: "user", content: `Basemate replied: "${agentText}"` },
    );
  }
  return turns;
}

// ── Objective checks (deterministic, no model) ────────────────────────────────

function objectiveChecks(turns: Turn[]): ObjectiveIssue[] {
  const issues: ObjectiveIssue[] = [];
  let prev: string | undefined;
  for (const t of turns) {
    const text = t.agentText.trim();
    if (text.toLowerCase().includes(DEFAULT_REPLY_SIGNATURE)) {
      issues.push({ turn: t.index, kind: "fallback", detail: "emitted the generic DEFAULT_REPLY" });
    }
    if (!text || text === "[text]") {
      issues.push({ turn: t.index, kind: "empty", detail: "empty agent reply" });
    }
    if (prev && text === prev && t.responseType === "text") {
      issues.push({ turn: t.index, kind: "repeat", detail: "identical to the previous reply" });
    }
    prev = text;
  }
  return issues;
}

// ── LLM-as-Judge (independent model: Claude via Anthropic) ────────────────────

function buildJudgePrompt(persona: Persona, turns: Turn[]): string {
  const transcript = turns
    .map(
      (t) =>
        `Turn ${t.index}\n  user: ${t.user}\n  agent [${t.responseType}${t.tool ? `, tool:${t.tool}` : ""}]: ${t.agentText}`,
    )
    .join("\n\n");
  return `PERSONA: ${persona.name}\nUSER GOAL: ${persona.goal}\n\nTRANSCRIPT:\n${transcript}`;
}

const JUDGE_SYSTEM = `You are a strict QA judge for "Basemate", a warm, bubbly, kind onchain agent on Base App. You grade a multi-turn conversation transcript between a simulated user and Basemate.

Grade EACH agent turn against these criteria (a turn fails if it clearly violates any that apply):
- answered: if the user asked a question (e.g. "what's the liquidation price?", "max leverage?", "is it safe?"), the agent must actually ANSWER it in words. Dumping a tool card / positions list instead of answering = FAIL.
- memory: if the user asks what Basemate remembers about preferences stated earlier, the agent must recall the relevant preference accurately instead of claiming it has no memory.
- routing: the agent took a sensible action/tool for the user's intent (or correctly answered in text with no tool).
- persona: warm, friendly, bubbly, kind — not robotic, cold, or terse. Tool-card-only replies with no warmth when the user expected conversation = weak.
- brand_emoji: any emoji used MUST be blue (💙 🔵 🔷 🔹 🌊). ANY non-blue/multicolor emoji (☀️ 🔥 🎉 😄 👀 ✨ 🚀 🙌 etc.) = FAIL. (👇 is allowed — it's a UI pointer, not a colored emoji.)
- no_loop: the agent must not robotically repeat the same reply or re-prepare the same action when it should acknowledge the prior card.
- no_fallback: never a generic "didn't catch that" style non-answer.

Respond with ONLY valid JSON, no prose, no code fences:
{"overall_pass": boolean, "summary": "one sentence", "turns": [{"turn": number, "pass": boolean, "failed": ["criterion", ...], "note": "short reason if failed"}]}`;

async function judgeSession(persona: Persona, turns: Turn[]): Promise<JudgeVerdict> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set — judge needs an independent model");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: getAnthropicDefaultModel(),
      max_tokens: 1500,
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: buildJudgePrompt(persona, turns) }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content?: Array<{ text?: string }> };
  const raw = data.content?.[0]?.text ?? "";
  const jsonStr = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  return JSON.parse(jsonStr) as JudgeVerdict;
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function main() {
  const { turns, runs, personaFilter } = parseArgs();
  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.error("OPENAI_API_KEY not set (user simulator)");
    process.exit(1);
  }
  if (!getAnthropicApiKey()) {
    console.error("ANTHROPIC_API_KEY not set (judge)");
    process.exit(1);
  }

  await UserMemoryAdapter.createTable().catch(() => {});
  await ConversationMemoryAdapter.createTable().catch(() => {});

  let personas = PERSONAS;
  if (personaFilter) personas = personas.filter((p) => p.name.includes(personaFilter));
  if (!personas.length) {
    console.error(`No persona matching "${personaFilter}"`);
    process.exit(1);
  }

  const userModel = process.env.DEFAULT_MODEL ?? DEFAULT_CHAT_MODEL;
  const userLlm = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  console.log(`\n${"═".repeat(64)}`);
  console.log("GRADED CONVERSATION EVAL");
  console.log(`agent=bankr/${userModel}  user-sim=openai/${userModel}  judge=anthropic/${getAnthropicDefaultModel()}`);
  console.log(`personas=${personas.length} turns=${turns} runs=${runs}`);
  console.log("═".repeat(64));

  let sessionsRun = 0;
  let sessionsPassed = 0;
  const allFailures: string[] = [];

  for (let r = 0; r < runs; r++) {
    for (const persona of personas) {
      const ai = new DiscoveryAI({});
      const convTurns = await runSession(ai, userLlm, userModel, persona, turns);
      const objIssues = objectiveChecks(convTurns);

      let verdict: JudgeVerdict | null = null;
      let judgeErr: string | undefined;
      try {
        verdict = await judgeSession(persona, convTurns);
      } catch (e) {
        judgeErr = e instanceof Error ? e.message : String(e);
      }

      sessionsRun++;
      const objFail = objIssues.length > 0;
      const judgeFail = verdict ? !verdict.overall_pass : true;
      const passed = !objFail && !judgeFail && !judgeErr;
      if (passed) sessionsPassed++;

      const badge = passed ? "✅" : "❌";
      console.log(`\n${badge} [${persona.name}]${runs > 1 ? ` run ${r + 1}` : ""}`);
      if (verdict) console.log(`   judge: ${verdict.summary}`);
      if (judgeErr) console.log(`   ⚠️  judge error: ${judgeErr}`);

      for (const t of convTurns) {
        const v = verdict?.turns.find((x) => x.turn === t.index);
        const turnBad =
          (v && !v.pass) || objIssues.some((o) => o.turn === t.index);
        const mark = turnBad ? "✗" : "·";
        console.log(
          `   ${mark} ${t.index}. 👤 ${t.user.slice(0, 60)}`,
        );
        console.log(
          `        🤖 [${t.responseType}${t.tool ? ` ${t.tool}` : ""}] ${t.agentText.slice(0, 80).replace(/\n/g, " ")}`,
        );
        if (v && !v.pass) {
          console.log(`        ✗ judge: ${v.failed.join(", ")} — ${v.note}`);
          allFailures.push(`[${persona.name}] turn ${t.index}: ${v.failed.join(",")} — ${v.note}`);
        }
        for (const o of objIssues.filter((x) => x.turn === t.index)) {
          console.log(`        ✗ check: ${o.kind} — ${o.detail}`);
          allFailures.push(`[${persona.name}] turn ${t.index}: ${o.kind} — ${o.detail}`);
        }
      }
    }
  }

  console.log(`\n${"═".repeat(64)}`);
  console.log(`SCORE: ${sessionsPassed}/${sessionsRun} sessions passed`);
  if (allFailures.length) {
    console.log(`\n⚠️  ${allFailures.length} failing turns:`);
    for (const f of allFailures) console.log(`  • ${f}`);
  }
  console.log("═".repeat(64));
  process.exit(sessionsPassed < sessionsRun ? 1 : 0);
}

main();
