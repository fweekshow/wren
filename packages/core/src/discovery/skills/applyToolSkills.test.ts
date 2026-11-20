import { describe, expect, it } from "vitest";

import { applyToolSkills } from "@/discovery/skills/applyToolSkills.js";
import { TOOL_SKILLS } from "@/discovery/skills/toolSkills.js";

describe("applyToolSkills", () => {
  it("appends skill block to known tools", () => {
    const tools = applyToolSkills([
      {
        type: "function",
        function: {
          name: "offer_support",
          description: "Base description.",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    const desc = tools[0]?.type === "function" ? tools[0].function.description : "";
    expect(desc).toContain("Base description.");
    expect(desc).toContain(TOOL_SKILLS.offer_support);
  });

  it("leaves unknown tools unchanged", () => {
    const tools = applyToolSkills([
      {
        type: "function",
        function: {
          name: "unknown_tool",
          description: "Only this.",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    expect(tools[0]?.type === "function" && tools[0].function.description).toBe("Only this.");
  });
});
