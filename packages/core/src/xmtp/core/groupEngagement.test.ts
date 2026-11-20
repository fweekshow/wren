import { describe, expect, it } from "vitest";

import { config } from "@/config/config.js";
import { isKnownAgentMessage, rememberAgentMessage } from "./agentOutboundMessages.js";
import {
  extractReplyText,
  isReplyToAgent,
  shouldEngageInGroup,
} from "./groupEngagement.js";
import {
  hasPendingInteraction,
  pendingUserKey,
  registerPendingInteractionChecker,
} from "./pendingInteractionRegistry.js";

function mockCtx(overrides: {
  text?: string;
  reply?: {
    content: string;
    reference?: string;
    referenceInboxId?: string;
    inReplyToSenderInboxId?: string;
  };
  agentInboxId?: string;
  senderInboxId?: string;
  conversationId?: string;
  isReply?: boolean;
  parentMessages?: Array<{ id: string; senderInboxId: string }>;
}) {
  const agentInboxId = overrides.agentInboxId ?? "agent-inbox";
  const content = overrides.reply
    ? {
        content: overrides.reply.content,
        reference: overrides.reply.reference,
        referenceInboxId: overrides.reply.referenceInboxId,
        inReplyTo: overrides.reply.inReplyToSenderInboxId
          ? { senderInboxId: overrides.reply.inReplyToSenderInboxId }
          : undefined,
      }
    : overrides.text ?? "";

  const parentMessages = overrides.parentMessages ?? [];

  return {
    message: {
      senderInboxId: overrides.senderInboxId ?? "user-inbox",
      content,
    },
    conversation: {
      id: overrides.conversationId ?? "conv-1",
      sync: async () => {},
      messages: async () => parentMessages,
    },
    client: { inboxId: agentInboxId },
    isReply: () => overrides.isReply ?? Boolean(overrides.reply),
  } as any;
}

describe("isReplyToAgent", () => {
  it("returns true when reply references the agent inbox", async () => {
    const ctx = mockCtx({
      isReply: true,
      reply: { content: "yes please", referenceInboxId: "agent-inbox" },
    });
    expect(await isReplyToAgent(ctx)).toBe(true);
  });

  it("returns true when enriched inReplyTo is from the agent", async () => {
    const ctx = mockCtx({
      isReply: true,
      reply: {
        content: "more details",
        referenceInboxId: "other",
        inReplyToSenderInboxId: "agent-inbox",
      },
    });
    expect(await isReplyToAgent(ctx)).toBe(true);
  });

  it("returns true when only reference id is present and parent is from agent", async () => {
    const ctx = mockCtx({
      isReply: true,
      reply: {
        content: "I'm doing good, and you?",
        reference: "0de48e5be133a6a219b3720dee938f41484e5cf2778fb0e96b0a08cbd378eb82",
      },
      parentMessages: [
        {
          id: "0de48e5be133a6a219b3720dee938f41484e5cf2778fb0e96b0a08cbd378eb82",
          senderInboxId: "agent-inbox",
        },
      ],
    });
    expect(await isReplyToAgent(ctx)).toBe(true);
  });

  it("returns false when replying to another user", async () => {
    const ctx = mockCtx({
      isReply: true,
      reply: { content: "hey", referenceInboxId: "someone-else" },
    });
    expect(await isReplyToAgent(ctx)).toBe(false);
  });

  it("returns false when reference points to another user's message", async () => {
    const ctx = mockCtx({
      isReply: true,
      reply: {
        content: "cool",
        reference: "msg-from-other-user",
      },
      parentMessages: [{ id: "msg-from-other-user", senderInboxId: "other-user" }],
    });
    expect(await isReplyToAgent(ctx)).toBe(false);
  });

  it("returns true when reference id was sent by the agent in this process", async () => {
    const refId = "cached-agent-message-id";
    rememberAgentMessage("conv-1", refId);
    const ctx = mockCtx({
      isReply: true,
      reply: { content: "follow up", reference: refId },
      parentMessages: [],
    });
    expect(await isReplyToAgent(ctx)).toBe(true);
    expect(isKnownAgentMessage("conv-1", refId)).toBe(true);
  });
});

describe("extractReplyText", () => {
  it("reads string content from a reply payload", () => {
    const ctx = mockCtx({
      isReply: true,
      reply: { content: "follow up question", referenceInboxId: "agent-inbox" },
    });
    expect(extractReplyText(ctx)).toBe("follow up question");
  });
});

describe("shouldEngageInGroup", () => {
  it("engages on @mention", async () => {
    const handle = config.mentionHandle.split(",")[0]?.trim() || "basemate";
    const text = `@${handle} swap $5 ETH`;
    const ctx = mockCtx({ text });
    expect(await shouldEngageInGroup(ctx, text)).toBe(true);
  });

  it("engages on reply-to-agent without mention", async () => {
    const ctx = mockCtx({
      isReply: true,
      reply: { content: "what about tomorrow?", referenceInboxId: "agent-inbox" },
    });
    expect(await shouldEngageInGroup(ctx, "what about tomorrow?")).toBe(true);
  });

  it("does not engage on reply to another user", async () => {
    const ctx = mockCtx({
      isReply: true,
      reply: { content: "cool", referenceInboxId: "other-user" },
    });
    expect(await shouldEngageInGroup(ctx, "cool")).toBe(false);
  });

  it("does not engage on plain text when only a pending wizard exists", async () => {
    const key = pendingUserKey("user-inbox", "conv-1");
    registerPendingInteractionChecker((k) => k === key);
    const ctx = mockCtx({ text: "random follow up without mention" });
    expect(await shouldEngageInGroup(ctx, "random follow up without mention")).toBe(false);
  });
});

describe("hasPendingInteraction", () => {
  it("returns true when a registered checker matches the pending key", () => {
    const key = pendingUserKey("user-inbox", "conv-1");
    registerPendingInteractionChecker((k) => k === key);
    expect(hasPendingInteraction(key)).toBe(true);
    expect(hasPendingInteraction(pendingUserKey("other", "conv-1"))).toBe(false);
  });
});
