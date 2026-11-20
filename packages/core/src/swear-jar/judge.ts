/**
 * Cheap swear judge for borderline / phrase cases regex should not take.
 * Fail closed. Only called when the jar is armed and a heat cue is present.
 */

import {
  createBankrLlmClient,
  logLlmTurn,
  openAiChatParams,
  providerForModel,
} from "@/llm/config.js";
import { logger } from "@/utils/logger.js";

import { SWEAR_JAR_BRAIN_MODEL } from "./constants.js";

const JUDGE_MODEL = SWEAR_JAR_BRAIN_MODEL;
const SWEAR_CONFIDENCE = 0.8;

/** Mild / crude tokens that are not automatic fines — AI decides if the phrase is extreme. */
const HEAT_CUE =
  /\b(piss(?:ing|ed)?|pee(?:ing)?|butt|ass(?:es)?|crap|dang|heck|frick|screw|dick|cock|balls|boobs|tits|horny|sex|sexy|naked|nude|f+[\W_]*u*[\W_]*c+[\W_]*k|fvck|sh[i1!]t|b[i1]tch|cunt)\b/i;

export function hasSwearCue(text: string): boolean {
  return HEAT_CUE.test(text.trim());
}

function stripJsonFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}

/**
 * Extreme-only judge. Standalone piss/butt/pee/damn-adjacent = clean.
 * Crude combinations ("piss in the butt") = swear.
 */
export async function judgeSwear(text: string): Promise<boolean> {
  const clean = text.trim();
  if (!clean || !hasSwearCue(clean)) return false;

  const params = openAiChatParams({
    model: JUDGE_MODEL,
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
              "You judge iMessage group chat for Alexander the swear jar. $1 only for EXTREME swearing or clearly vulgar sexual/bodily insults.\n" +
              'Return JSON only: {"swear":true|false,"confidence":0-1}\n\n' +
              "swear=false: standalone mild words (piss, pee, butt, ass, damn, hell, crap, heck), quoting someone else, singing lyrics, talking about a person named Alexander, normal chat.\n" +
              'swear=true: crude combinations that are clearly nasty (e.g. "piss in the butt", "eat shit"), slurs, extreme sexual insults, obfuscated fuck/shit aimed as a curse.\n' +
              "Be conservative. If unsure, swear=false.",
          },
          { role: "user", content: JSON.stringify({ message: clean.slice(0, 400) }) },
        ],
      },
      { timeout: 8_000 },
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
      swear?: unknown;
      confidence?: unknown;
    };
    const swear = parsed.swear === true;
    const confidence =
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? parsed.confidence
        : 0;
    return swear && confidence >= SWEAR_CONFIDENCE;
  } catch (err) {
    logger.warn({ err }, "[swear-jar] judge failed — treating as clean");
    return false;
  }
}
