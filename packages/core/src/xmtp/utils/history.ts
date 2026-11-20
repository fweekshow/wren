import { MessageContext } from "@xmtp/agent-sdk";

import type { ActionsContent } from "@/xmtp/content-types/inline-actions/types/ActionsContent.js";
import type { IntentContent } from "@/xmtp/content-types/inline-actions/types/IntentContent.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const DEFAULT_HISTORY_LIMIT = 20;

export interface ConversationHistorySource {
  conversation: {
    sync(): Promise<void>;
    messages(opts: { limit: number; direction: number }): Promise<
      Array<{
        id: string;
        senderInboxId: string;
        contentType?: { typeId?: string };
        content: unknown;
        sentAt?: Date;
      }>
    >;
  };
  agentInboxId: string;
  excludeMessageId?: string;
}

type RawMessage = Awaited<
  ReturnType<ConversationHistorySource["conversation"]["messages"]>
>[number];

function mapMessagesToHistory(
  messages: RawMessage[],
  agentInboxId: string,
  excludeMessageId: string | undefined,
  limit: number,
): ChatMessage[] {
  const history: ChatMessage[] = [];

  for (const msg of messages) {
    if (excludeMessageId && msg.id === excludeMessageId) continue;

    const isFromAgent = msg.senderInboxId === agentInboxId;
    const role: "user" | "assistant" = isFromAgent ? "assistant" : "user";
    const contentTypeId = msg.contentType?.typeId;
    let content: string | null = null;

    switch (contentTypeId) {
      case "text":
      case "markdown":
        if (typeof msg.content === "string") content = msg.content;
        break;

      case "actions": {
        const actionsContent = msg.content as ActionsContent;
        if (actionsContent?.description && actionsContent?.actions) {
          const labels = actionsContent.actions.map((a) => a.label).join(", ");
          content = `${actionsContent.description} [Options: ${labels}]`;
        }
        break;
      }

      case "intent": {
        const intentContent = msg.content as IntentContent;
        if (intentContent?.actionId) {
          content = `[Selected action: ${intentContent.actionId}]`;
        }
        break;
      }

      case "reaction":
        continue;

      default:
        continue;
    }

    if (content) {
      const timestamp = msg.sentAt
        ? msg.sentAt.toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
            timeZone: "America/Los_Angeles",
          })
        : undefined;
      const prefixedContent = timestamp ? `[${timestamp}] ${content}` : content;
      history.push({ role, content: prefixedContent });
    }

    if (history.length >= limit) break;
  }

  return history.reverse();
}

/**
 * Loads recent XMTP conversation history as a chat-style transcript.
 */
export async function getConversationHistory(
  ctxOrSource: MessageContext<any> | ConversationHistorySource,
  limit: number = DEFAULT_HISTORY_LIMIT,
): Promise<ChatMessage[]> {
  const source: ConversationHistorySource =
    "message" in ctxOrSource
      ? {
          conversation: ctxOrSource.conversation,
          agentInboxId: ctxOrSource.client.inboxId,
          excludeMessageId: ctxOrSource.message.id,
        }
      : ctxOrSource;

  await source.conversation.sync();

  const messages = await source.conversation.messages({
    limit: limit * 2,
    direction: 1,
  });

  return mapMessagesToHistory(messages, source.agentInboxId, source.excludeMessageId, limit);
}
