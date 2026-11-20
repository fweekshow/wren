/**
 * mockOpenAI — factories for mocked OpenAI chat.completions.create responses.
 *
 * Usage (in a test file with vi.mock):
 *
 *   import { makeTextCompletion, makeToolCallCompletion } from "@/test-utils/mockOpenAI.js";
 *   const mockCreate = vi.fn().mockResolvedValueOnce(makeTextCompletion("hello"));
 */

import type OpenAI from "openai";

type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;
type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

let _callId = 0;
function nextId(prefix = "call") {
  return `${prefix}_${++_callId}`;
}

/** A completion that returns a plain text response with no tool calls. */
export function makeTextCompletion(
  text: string,
  opts: { finishReason?: string } = {},
): ChatCompletion {
  return {
    id: nextId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "gpt-5.4-mini",
    choices: [
      {
        index: 0,
        finish_reason: (opts.finishReason ?? "stop") as ChatCompletion["choices"][0]["finish_reason"],
        message: {
          role: "assistant",
          content: text,
          tool_calls: undefined,
          refusal: null,
        },
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

/** A completion that returns a single tool call. */
export function makeToolCallCompletion(
  toolName: string,
  args: Record<string, unknown> = {},
  opts: { callId?: string } = {},
): ChatCompletion {
  const callId = opts.callId ?? nextId("call");
  const toolCall: ToolCall = {
    id: callId,
    type: "function",
    function: {
      name: toolName,
      arguments: JSON.stringify(args),
    },
  };
  return {
    id: nextId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "gpt-5.4-mini",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [toolCall],
          refusal: null,
        },
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 },
  };
}

/** A completion that returns multiple tool calls in one round. */
export function makeMultiToolCallCompletion(
  calls: Array<{ toolName: string; args?: Record<string, unknown> }>,
): ChatCompletion {
  const toolCalls: ToolCall[] = calls.map(({ toolName, args = {} }) => ({
    id: nextId("call"),
    type: "function",
    function: {
      name: toolName,
      arguments: JSON.stringify(args),
    },
  }));
  return {
    id: nextId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "gpt-5.4-mini",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: toolCalls,
          refusal: null,
        },
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 200, completion_tokens: 60, total_tokens: 260 },
  };
}

/** A completion that simulates token-budget truncation (finish_reason "length", empty content). */
export function makeLengthTruncatedCompletion(): ChatCompletion {
  return {
    id: nextId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "gpt-5.4-mini",
    choices: [
      {
        index: 0,
        finish_reason: "length",
        message: {
          role: "assistant",
          content: "",
          tool_calls: undefined,
          refusal: null,
        },
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 1800, completion_tokens: 200, total_tokens: 2000 },
  };
}

/** Reset the internal call-id counter (call in beforeEach to keep IDs deterministic). */
export function resetCallIds(): void {
  _callId = 0;
}
