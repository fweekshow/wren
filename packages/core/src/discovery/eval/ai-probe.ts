/**
 * AI-driven live probe for DiscoveryAI.
 *
 * An LLM plays the role of a real user — curious, casual, slightly DeFi-confused.
 * It sees each agent response and decides what to say next, just like a human would.
 * It runs several conversation sessions with different personas and tries to find
 * broken paths, weird responses, or anything that feels off.
 *
 * Usage:
 *   bun packages/core/src/discovery/eval/ai-probe.ts
 *   bun packages/core/src/discovery/eval/ai-probe.ts --turns 6 --sessions 5
 *   bun packages/core/src/discovery/eval/ai-probe.ts --persona curious
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import OpenAI from "openai";

const repoRoot = resolve(import.meta.dirname, "../../../../../");
loadEnv({ path: resolve(repoRoot, "apps/basemate-tba/.env") });
loadEnv({ path: resolve(repoRoot, "packages/core/.env") });

import { DEFAULT_CHAT_MODEL } from "@/llm/config.js";

// ── Personas ──────────────────────────────────────────────────────────────────

interface Persona {
  name: string;
  systemPrompt: string;
}

const PERSONAS: Persona[] = [
  {
    name: "crypto-curious",
    systemPrompt: `You are a 25-year-old who just got into crypto and found this Base App chatbot called Basemate.
You're genuinely curious, ask natural follow-up questions, and sometimes misunderstand DeFi concepts.
You want to trade, earn, and learn — but you're not sure how.
Start with a casual greeting, then explore naturally. Ask things like "what is avantis?", try to make a trade,
get confused and ask questions, try to fix amounts, ask about your positions.
Be conversational — short messages, real texting style.
After each bot reply, react naturally and decide what to do next.
Occasionally try edge cases: send something totally off-topic, send "What's up" mid-flow,
ask something confusing like "what leverage is that?" after a trade is prepared.`,
  },
  {
    name: "defi-degen",
    systemPrompt: `You are a DeFi power user who knows the space well. You're testing this new agent called Basemate.
You'll ask sharp questions, try to break it, and see if it gives you bad info.
Try: perp trades with specific leverage questions, asking about liquidation, comparing yield protocols,
checking positions, closing trades. Also try sending small talk mid-flow ("ok nice", "yo") and see
if the bot does something weird. If the bot says something wrong or weird, flag it with [BUG?].
Keep messages short and natural.`,
  },
  {
    name: "normie",
    systemPrompt: `You are a regular person who barely understands crypto but a friend told you to try Basemate.
You're confused, you ask basic questions, sometimes say totally random things.
Try: "how do I make money?", "what's eth?", "can I buy bitcoin here?", weird messages like "test",
"hello??", "what is this", then slowly explore what the bot can actually do.
If the bot seems to break or say something odd, note it as [WEIRD].`,
  },
  {
    name: "rapid-fire",
    systemPrompt: `You are an impatient user who sends rapid-fire messages to test this chatbot.
Send very short messages: "gm", "yo", "trade", "eth long", "how much", "ok", "nice",
"what happened", "close it", "wait what", "that's wrong", "do it again".
Basically stress-test the conversational context. Note anything that seems like the bot is confused
or repeating itself with [ISSUE].`,
  },
];

// ── Parser ────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let turns = 6;
  let sessions = PERSONAS.length;
  let personaFilter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--turns" && args[i + 1]) turns = Number(args[++i]);
    if (args[i] === "--sessions" && args[i + 1]) sessions = Number(args[++i]);
    if (args[i] === "--persona" && args[i + 1]) personaFilter = args[++i];
  }
  return { turns, sessions, personaFilter };
}

// ── The probe ─────────────────────────────────────────────────────────────────

interface Turn {
  role: "user" | "agent";
  content: string;
  responseType: string;
  toolCalled?: string;
  latencyMs: number;
  flags: string[];
}

const EVAL_WALLET = "0x22209cfc1397832f32160239c902b10a624cab1a";

/** Extract [BUG?], [WEIRD], [ISSUE] flags from user commentary */
function extractFlags(text: string): string[] {
  const flags: string[] = [];
  if (/\[BUG\??\]/i.test(text)) flags.push("BUG?");
  if (/\[WEIRD\]/i.test(text)) flags.push("WEIRD");
  if (/\[ISSUE\]/i.test(text)) flags.push("ISSUE");
  return flags;
}

/** Format agent response for the user LLM to see */
function agentReplyForLlm(response: { type: string; [k: string]: unknown }): string {
  if ("text" in response && typeof response.text === "string") return response.text;
  if (response.type === "menu") {
    const desc = (response as any).description;
    return desc ? `[showed capabilities menu: "${desc}"]` : "[showed capabilities menu]";
  }
  if (response.type === "transaction") return `[prepared transaction: "${(response as any).text}"]`;
  if (response.type === "launches") return `[showed trending tokens: "${(response as any).text}"]`;
  if (response.type === "communities") return `[showed communities: "${(response as any).text}"]`;
  if (response.type === "disambiguate") return `[showed earn options: "${(response as any).text}"]`;
  if (response.type === "perp_guide") return `[showed perp wizard: "${(response as any).text}"]`;
  if (response.type === "amount_select") return `[asked for amount: "${(response as any).text}"]`;
  return `[${response.type}: "${(response as any).text ?? ""}"]`;
}

async function runSession(
  ai: any,
  openai: OpenAI,
  persona: Persona,
  maxTurns: number,
  model: string,
): Promise<Turn[]> {
  const convId = `ai-probe-${persona.name}-${Date.now()}`;
  const ctx = { inboxId: convId, conversationId: convId, walletAddress: EVAL_WALLET };

  const userMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: persona.systemPrompt },
  ];

  const turns: Turn[] = [];

  for (let i = 0; i < maxTurns; i++) {
    // User LLM generates the next message
    const userCompletion = await openai.chat.completions.create({
      model,
      messages: [
        ...userMessages,
        {
          role: "user",
          content:
            i === 0
              ? "Start the conversation with your first message to the bot."
              : "What do you say next? (just the message itself, nothing else)",
        },
      ],
      max_completion_tokens: 80,
      temperature: 0.9,
    });

    const userText = userCompletion.choices[0]?.message?.content?.trim() ?? "hey";
    const userFlags = extractFlags(userText);
    const cleanUserText = userText.replace(/\[BUG\??\]|\[WEIRD\]|\[ISSUE\]/gi, "").trim();

    const agentT0 = Date.now();
    const recorder = { invocations: [] as Array<{ tool: string; args: Record<string, unknown> }> };
    const response = (await ai.respond(cleanUserText, { ...ctx, routingEvalRecorder: recorder })) as any;
    const agentLatency = Date.now() - agentT0;

    const firstTool = recorder.invocations[0]?.tool;
    const agentText = agentReplyForLlm(response);

    turns.push({
      role: "user",
      content: userText,
      responseType: "",
      latencyMs: 0,
      flags: userFlags,
    });
    turns.push({
      role: "agent",
      content: agentText,
      responseType: response.type,
      toolCalled: firstTool,
      latencyMs: agentLatency,
      flags: [],
    });

    // Feed the agent reply back to the user LLM as context
    userMessages.push(
      { role: "assistant", content: `You sent: "${cleanUserText}"` },
      { role: "user", content: `The bot replied: "${agentText}"` },
    );
  }

  return turns;
}

function printSession(persona: Persona, turns: Turn[]) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`PERSONA: ${persona.name}`);
  console.log("─".repeat(60));

  const allFlags: Array<{ turn: number; flags: string[]; content: string }> = [];

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role === "user") {
      const flagStr = t.flags.length ? ` 🚩 [${t.flags.join(", ")}]` : "";
      console.log(`\n👤 User: ${t.content}${flagStr}`);
      if (t.flags.length) allFlags.push({ turn: i + 1, flags: t.flags, content: t.content });
    } else {
      const toolStr = t.toolCalled ? ` → ${t.toolCalled}` : "";
      console.log(
        `🤖 Agent [${t.responseType}${toolStr}] (${t.latencyMs}ms): ${t.content.slice(0, 120)}${t.content.length > 120 ? "…" : ""}`,
      );
    }
  }

  if (allFlags.length) {
    console.log(`\n⚠️  Flags raised by user LLM in this session:`);
    for (const f of allFlags) {
      console.log(`  ${f.flags.join(", ")} — "${f.content.slice(0, 80)}"`);
    }
  }
}

function printSummary(
  allSessions: Array<{ persona: Persona; turns: Turn[] }>,
  totalMs: number,
) {
  console.log(`\n${"═".repeat(60)}`);
  console.log("AI PROBE SUMMARY");
  console.log("═".repeat(60));

  let totalTurns = 0;
  let totalFlags = 0;
  const allIssues: string[] = [];

  for (const { persona, turns } of allSessions) {
    const agentTurns = turns.filter((t) => t.role === "agent");
    const flagged = turns.filter((t) => t.role === "user" && t.flags.length);
    totalTurns += agentTurns.length;
    totalFlags += flagged.length;

    const responseTypes = new Map<string, number>();
    for (const t of agentTurns) {
      responseTypes.set(t.responseType, (responseTypes.get(t.responseType) ?? 0) + 1);
    }
    const typeSummary = [...responseTypes.entries()].map(([k, v]) => `${k}×${v}`).join(", ");
    const avgMs = agentTurns.length
      ? Math.round(agentTurns.reduce((s, t) => s + t.latencyMs, 0) / agentTurns.length)
      : 0;

    const badge = flagged.length ? "🚩" : "✅";
    console.log(`${badge} ${persona.name.padEnd(16)} ${agentTurns.length} turns | types: ${typeSummary} | avg ${avgMs}ms`);

    for (const f of flagged) {
      allIssues.push(`[${persona.name}] ${f.flags.join(", ")}: "${f.content.slice(0, 80)}"`);
    }
  }

  console.log("─".repeat(60));
  console.log(`Total: ${totalTurns} agent turns, ${totalFlags} flags, ${(totalMs / 1000).toFixed(1)}s`);

  if (allIssues.length) {
    console.log("\n🚩 ALL FLAGGED ISSUES:");
    for (const issue of allIssues) console.log(`  ${issue}`);
  } else {
    console.log("\n✅ No issues flagged by the user LLM.");
  }
  console.log("═".repeat(60));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { turns, sessions, personaFilter } = parseArgs();

  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.error("OPENAI_API_KEY not set");
    process.exit(1);
  }

  const model = process.env.DEFAULT_MODEL ?? DEFAULT_CHAT_MODEL;
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const { DiscoveryAI } = await import("@/discovery/ai.js");
  const ai = new DiscoveryAI({ model });

  let personas = PERSONAS;
  if (personaFilter) {
    personas = personas.filter((p) => p.name.includes(personaFilter));
    if (!personas.length) {
      console.error(`No persona matching "${personaFilter}". Available: ${PERSONAS.map((p) => p.name).join(", ")}`);
      process.exit(1);
    }
  }
  personas = personas.slice(0, sessions);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`AI PROBE — ${personas.length} personas × ${turns} turns each`);
  console.log(`model: ${model}  wallet: ${EVAL_WALLET.slice(0, 10)}…`);
  console.log("═".repeat(60));

  const t0 = Date.now();
  const results: Array<{ persona: Persona; turns: Turn[] }> = [];

  for (const persona of personas) {
    const sessionTurns = await runSession(ai, openai, persona, turns, model);
    results.push({ persona, turns: sessionTurns });
    printSession(persona, sessionTurns);
  }

  printSummary(results, Date.now() - t0);
}

main();
