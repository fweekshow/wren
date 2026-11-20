import type OpenAI from "openai";

import { TOOL_SKILLS } from "@/discovery/skills/toolSkills.js";

/** Append fat-skill routing blocks to each tool description (byte-stable for prompt caching). */
export function applyToolSkills(
  tools: OpenAI.Chat.Completions.ChatCompletionTool[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => {
    if (tool.type !== "function") return tool;
    const skill = TOOL_SKILLS[tool.function.name];
    if (!skill) return tool;
    const base = tool.function.description ?? "";
    return {
      ...tool,
      function: {
        ...tool.function,
        description: base ? `${base}\n\n${skill}` : skill,
      },
    };
  });
}
