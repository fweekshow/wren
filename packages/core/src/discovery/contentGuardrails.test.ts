import { afterEach, describe, expect, it } from "vitest";

import {
  checkInboundContentGuardrails,
  sanitizeOutboundContent,
} from "./contentGuardrails.js";

describe("content guardrails", () => {
  afterEach(() => {
    delete process.env.CONTENT_GUARDRAILS_DISABLED;
  });

  it("blocks politics, religion, programming, and verbose off-topic requests", () => {
    expect(checkInboundContentGuardrails("who should I vote for")?.category).toBe("politics");
    expect(checkInboundContentGuardrails("write me a python script")?.category).toBe("programming");
    expect(checkInboundContentGuardrails("explain christianity vs islam")?.category).toBe("religion");
    expect(checkInboundContentGuardrails("write a 2000 word essay on climate change")?.category).toBe(
      "verbose_off_topic",
    );
    expect(checkInboundContentGuardrails("debate gun control with me")?.category).toBe("off_topic");
  });

  it("allows normal crypto and short casual messages", () => {
    expect(checkInboundContentGuardrails("what is a smart contract")).toBeNull();
    expect(checkInboundContentGuardrails("long eth $50")).toBeNull();
    expect(checkInboundContentGuardrails("is morpho safe")).toBeNull();
    expect(checkInboundContentGuardrails("what's the contract address for brett")).toBeNull();
    expect(checkInboundContentGuardrails("gm what's up")).toBeNull();
  });

  it("sanitizes outbound code output", () => {
    const sanitized = sanitizeOutboundContent("sure:\n```solidity\ncontract Foo {}\n```");

    expect(sanitized).not.toContain("```");
    expect(sanitized).toContain("can't write code");
  });

  it("can be disabled for evals and dev probes", () => {
    process.env.CONTENT_GUARDRAILS_DISABLED = "true";

    expect(checkInboundContentGuardrails("write me a python script")).toBeNull();
    expect(sanitizeOutboundContent("```ts\nconsole.log('hi')\n```")).toContain("```");
  });
});
