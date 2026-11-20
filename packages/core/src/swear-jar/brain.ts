/**
 * Cheap Alexander classifier. Regex stays the fast path; this runs only on
 * cued / borderline messages. Fail closed — never invent a fine or settle.
 */

import {
  createBankrLlmClient,
  logLlmTurn,
  openAiChatParams,
  providerForModel,
} from "@/llm/config.js";
import { logger } from "@/utils/logger.js";

import {
  matchHelp,
  matchNah,
  matchOff,
  matchOptIn,
  matchOptOut,
  matchSecrets,
  matchSettle,
  matchStatus,
  normalizeCommand,
} from "./commands.js";
import { SWEAR_JAR_BRAIN_MODEL } from "./constants.js";
import { detectSwear } from "./detect.js";
import { hasSwearCue } from "./judge.js";

export const BRAIN_INTENTS = [
  "ignore",
  "help",
  "status",
  "settle",
  "settle_confirm",
  "nah",
  "swear",
  "on",
  "off",
  "opt_in",
  "opt_out",
  "secrets",
] as const;

export type BrainIntent = (typeof BRAIN_INTENTS)[number];

export type ArmedFastPath =
  | "help"
  | "nah"
  | "settle"
  | "status"
  | "opt_in"
  | "opt_out"
  | "off"
  | "secrets"
  | "swear"
  | "brain"
  | "none";

export type BrainContext = {
  text: string;
  mentioned: boolean;
  armed: boolean;
  rosterNames: string[];
  potUsd: number;
  lastFineAgeSec: number | null;
  lastFineStatus: string | null;
};

export type BrainVerdict = {
  intent: BrainIntent;
  confidence: number;
  reason: string;
};

const INFO = new Set<BrainIntent>([
  "help",
  "status",
  "nah",
  "on",
  "off",
  "opt_in",
  "opt_out",
  "secrets",
  "settle_confirm",
]);

const INTENT_CUE =
  /\b(alexander|swear\s*jar|the\s+(jar|pot)|standings|empty\s+(the\s+)?(jar|pot)|release\s+(the\s+)?(jar|pot)|count me in|opt[\s-]?in|opt[\s-]?out|off my tab|put me on|leave me out|don'?t charge|whats?\s+in|check\s+(the\s+)?(jar|pot)|how's\s+(the\s+)?(jar|alexander)|what counts as a swear|what('?s| is) a swear)\b/i;

export function looksQuoted(text: string): boolean {
  return (
    /\b((he|she|they|someone|somebody|mom|dad|emma)\s+)?(said|says|saying|sang|singing)\b/i.test(
      text,
    ) || /\b(quote|quoted|lyrics)\b/i.test(text)
  );
}

export function hasIntentCue(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^(nah|wasn'?t a swear|not a swear)\b/i.test(t)) return true;
  return INTENT_CUE.test(t);
}

export function hasBrainCue(text: string, opts: { mentioned?: boolean } = {}): boolean {
  if (hasSwearCue(text) || hasIntentCue(text)) return true;
  if (opts.mentioned && /\b(alexander|jar|pot|swear|settle|nah)\b/i.test(text)) return true;
  return false;
}

export function applyThresholds(raw: { intent: string; confidence: number }): BrainIntent {
  const intent = BRAIN_INTENTS.includes(raw.intent as BrainIntent)
    ? (raw.intent as BrainIntent)
    : "ignore";
  const confidence =
    typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? raw.confidence : 0;

  if (intent === "ignore") return "ignore";
  if (INFO.has(intent) && confidence >= 0.6) return intent;
  if (intent === "swear" && confidence >= 0.85) return "swear";
  if (intent === "settle" && confidence >= 0.85) return "settle";
  if (intent === "settle" && confidence >= 0.6) return "settle_confirm";
  return "ignore";
}

export function resolveArmedFastPath(raw: string): ArmedFastPath {
  const cmd = normalizeCommand(raw);
  if (matchHelp(cmd)) return "help";
  if (matchSecrets(cmd)) return "secrets";
  if (matchNah(cmd)) return "nah";
  if (matchOptIn(cmd)) return "opt_in";
  if (matchOptOut(cmd)) return "opt_out";
  if (matchOff(cmd)) return "off";
  if (matchSettle(cmd)) return "settle";
  if (matchStatus(cmd)) return "status";
  if (detectSwear(raw) && !looksQuoted(raw)) return "swear";
  if (hasBrainCue(raw)) return "brain";
  return "none";
}

function stripJsonFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}

const SYSTEM =
  "You classify iMessage group chat for Alexander the swear jar. He is a jar automaton, not a chatbot.\n" +
  'Return JSON only: {"intent":"...","confidence":0-1,"reason":"short"}\n' +
  `intents: ${BRAIN_INTENTS.join(" | ")}\n\n` +
  "ignore: talking about a person named Alexander, dinner plans, argument 'settle this' without jar/pot/alexander, crypto pool/vault pot unless the jar is the clear referent, ordinary chat.\n" +
  "help: asking what Alexander does / how the jar works.\n" +
  "status: pot, standings, what's in the jar.\n" +
  "settle: explicit pay-the-winner / empty-the-jar / end this round. Settle RESTARTS a new empty round — it does not turn him off.\n" +
  "settle_confirm: they sound like they might want to pay out but are not explicit.\n" +
  "nah: rejecting a recent fine / 'that wasn't a swear'. Not a generic nah.\n" +
  "swear: EXTREME cursing or clearly vulgar sexual/bodily insults aimed as a curse. Standalone piss/pee/butt/ass/damn/hell/crap = ignore. Crude combos (piss in the butt) = swear. Quoted / attributed / lyrics = ignore.\n" +
  "on: summon Alexander into this group (group-level).\n" +
  "off: explicitly send him away (alexander off, jar off, unsummon). NOT settle. NOT a personal opt-out.\n" +
  "opt_in: this sender wants THEIR tab on (count me in, charge me).\n" +
  "opt_out: this sender wants THEIR tab off (off my tab, don't charge me). Group stays armed.\n" +
  "secrets: asking what counts as a swear / which words / the list — he refuses to reveal his ledger.\n" +
  "Be conservative. If unsure, ignore. Money intents (swear, settle) need to be obvious.";

export async function classifyAlexander(ctx: BrainContext): Promise<BrainVerdict> {
  const clean = ctx.text.trim();
  if (!clean) return { intent: "ignore", confidence: 0, reason: "empty" };

  const params = openAiChatParams({
    model: SWEAR_JAR_BRAIN_MODEL,
    temperature: 0,
    maxCompletionTokens: 120,
  });
  const t0 = Date.now();

  try {
    const client = createBankrLlmClient();
    const completion = await client.chat.completions.create(
      {
        ...params,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: JSON.stringify({
              message: clean.slice(0, 400),
              mentioned: ctx.mentioned,
              armed: ctx.armed,
              rosterNames: ctx.rosterNames.slice(0, 12),
              potUsd: ctx.potUsd,
              lastFineAgeSec: ctx.lastFineAgeSec,
              lastFineStatus: ctx.lastFineStatus,
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
    const parsed = JSON.parse(stripJsonFences(raw)) as {
      intent?: unknown;
      confidence?: unknown;
      reason?: unknown;
    };
    const intent = applyThresholds({
      intent: typeof parsed.intent === "string" ? parsed.intent : "ignore",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    });
    return {
      intent,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch (err) {
    logger.warn({ err }, "[swear-jar] brain failed — ignore");
    return { intent: "ignore", confidence: 0, reason: "error" };
  }
}
