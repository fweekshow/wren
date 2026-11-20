import OpenAI from "openai";

/**
 * Central LLM config — Bankr LLM Gateway is the only runtime provider.
 * The gateway exposes an OpenAI-compatible API, so the OpenAI SDK remains the
 * transport client while billing/routing goes through Bankr.
 */

export const DEFAULT_CHAT_MODEL = process.env.DEFAULT_MODEL?.trim() || "gpt-5.4-mini";
export const BANKR_LLM_BASE_URL =
  process.env.BANKR_LLM_BASE_URL?.trim().replace(/\/$/, "") || "https://llm.bankr.bot/v1";
export const DEFAULT_EMBEDDING_MODEL =
  process.env.BANKR_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";

export function getBankrLlmApiKey(): string {
  const apiKey = process.env.BANKR_LLM_API_KEY?.trim();
  if (!apiKey) throw new Error("BANKR_LLM_API_KEY is required in .env");
  return apiKey;
}

export function createBankrLlmClient(): OpenAI {
  const apiKey = getBankrLlmApiKey();
  return new OpenAI({
    apiKey,
    baseURL: BANKR_LLM_BASE_URL,
    defaultHeaders: {
      "X-API-Key": apiKey,
    },
  });
}

/** Models that reject custom temperature (reasoning / o-series). */
export function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return (
    /^o\d/.test(m) ||
    m.includes("reasoning") ||
    (m.startsWith("gpt-5.4") && !m.includes("mini") && !m.includes("nano"))
  );
}

export interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  maxCompletionTokens?: number;
}

/** OpenAI-compatible chat.completions.create params shared by agents + evals. */
export function openAiChatParams(opts: ChatCompletionOptions = {}) {
  const model = opts.model ?? DEFAULT_CHAT_MODEL;
  const params: Record<string, unknown> = {
    model,
    max_completion_tokens: opts.maxCompletionTokens ?? 400,
  };
  if (!isReasoningModel(model)) {
    params.temperature = opts.temperature ?? 0.4;
  }
  return params as {
    model: string;
    max_completion_tokens: number;
    temperature?: number;
  };
}

export interface LlmTurnTelemetry {
  model: string;
  provider: "bankr" | "anthropic";
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  toolCalls?: string[];
}

export function logLlmTurn(telemetry: LlmTurnTelemetry): void {
  const tools = telemetry.toolCalls?.length ? ` tools=${telemetry.toolCalls.join(",")}` : "";
  const tokens =
    telemetry.promptTokens != null
      ? ` tok=${telemetry.promptTokens}+${telemetry.completionTokens ?? 0}` +
        (telemetry.cachedTokens ? ` cached=${telemetry.cachedTokens}` : "")
      : "";
  console.log(
    `🤖 llm ${telemetry.provider} ${telemetry.model} ${telemetry.latencyMs}ms${tokens}${tools}`,
  );
}

export function getAnthropicApiKey(): string {
  return process.env.ANTHROPIC_API_KEY?.trim() || "";
}

export function getAnthropicDefaultModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-6";
}

/**
 * Optional stronger model used for advisory / strategy / analysis queries
 * (vs the fast default model for tool dispatch). Routed through the same
 * Bankr gateway (OpenAI-compatible), so no extra SDK/key is needed.
 *
 * Disabled by default: set ADVISORY_MODEL (e.g. "claude-sonnet-4-6") to turn
 * routing on. Returns "" when unset so callers fall back to the default model.
 */
export function getAdvisoryModel(): string {
  return process.env.ADVISORY_MODEL?.trim() || "";
}

/** Telemetry provider label inferred from the model name. */
export function providerForModel(model: string): "bankr" | "anthropic" {
  return model.toLowerCase().includes("claude") ? "anthropic" : "bankr";
}
