import { SortDirection, type MessageContext } from "@xmtp/agent-sdk";

import { isKnownAgentMessage, rememberAgentMessage } from "./agentOutboundMessages.js";
import { hasPendingInteraction, pendingUserKey } from "./pendingInteractionRegistry.js";
import { isMentioned } from "./utils.js";

type ReplyContext = MessageContext<any> & {
  isReply?: () => boolean;
};

interface ReplyLike {
  content?: unknown;
  reference?: string;
  referenceId?: string;
  referenceInboxId?: string;
  inReplyTo?: {
    senderInboxId?: string;
    content?: unknown;
  };
}

function replyContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "text" in content) {
    const text = (content as { text?: string }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

function referencedMessageId(reply: ReplyLike): string | undefined {
  return reply.reference ?? reply.referenceId;
}

/** Extract user-visible text from an XMTP reply message. */
export function extractReplyText(ctx: MessageContext<any>): string {
  const replyCtx = ctx as ReplyContext;
  if (typeof replyCtx.isReply === "function" && !replyCtx.isReply()) {
    return "";
  }
  const reply = ctx.message.content as ReplyLike;
  return replyContentText(reply?.content);
}

async function parentMessageSenderInboxId(
  ctx: MessageContext<any>,
  refId: string,
): Promise<string | undefined> {
  const conversationId = ctx.conversation.id;
  if (isKnownAgentMessage(conversationId, refId)) {
    return ctx.client.inboxId;
  }

  try {
    await ctx.conversation.sync();
    const messages = await ctx.conversation.messages({
      limit: 500,
      direction: SortDirection.Descending,
    });

    const agentInboxId = ctx.client.inboxId;
    for (const msg of messages) {
      if (msg.senderInboxId === agentInboxId) {
        rememberAgentMessage(conversationId, msg.id);
      }
    }

    const parent = messages.find((m) => m.id === refId);
    return parent?.senderInboxId;
  } catch {
    return undefined;
  }
}

/** True when the user quote-replied to a message sent by this agent. */
export async function isReplyToAgent(ctx: MessageContext<any>): Promise<boolean> {
  const replyCtx = ctx as ReplyContext;
  if (typeof replyCtx.isReply === "function" && !replyCtx.isReply()) {
    return false;
  }

  const reply = ctx.message.content as ReplyLike;
  const agentInboxId = ctx.client.inboxId;

  if (reply.referenceInboxId === agentInboxId) return true;
  if (reply.inReplyTo?.senderInboxId === agentInboxId) return true;

  const refId = referencedMessageId(reply);
  if (!refId) return false;

  if (isKnownAgentMessage(ctx.conversation.id, refId)) return true;

  const parentSender = await parentMessageSenderInboxId(ctx, refId);
  return parentSender === agentInboxId;
}

/** Whether the agent should respond to this message in a group chat. */
export async function shouldEngageInGroup(
  ctx: MessageContext<any>,
  text: string,
): Promise<boolean> {
  if (isMentioned(text)) return true;
  if (await isReplyToAgent(ctx)) return true;
  return false;
}

/** True when a mid-flow wizard is waiting on this user in this chat. */
export async function hasPendingInteractionFor(ctx: MessageContext<any>): Promise<boolean> {
  const key = pendingUserKey(ctx.message.senderInboxId, ctx.conversation.id);
  return hasPendingInteraction(key);
}
