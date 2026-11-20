import { AgentMiddleware, filter } from "@xmtp/agent-sdk";

import { logger } from "@/utils/logger.js";

export const loggingMiddleware: AgentMiddleware = async (ctx, next) => {
  const content = filter.isText(ctx.message)
    ? ctx.message.content
    : JSON.stringify(ctx.message.content);

  logger.info({
    event: "message_received",
    sender: ctx.message.senderInboxId.substring(0, 8),
    contentType: ctx.message.contentType?.typeId,
    content,
    isGroup: filter.isGroup(ctx.conversation),
    conversationId: ctx.conversation.id,
    messageId: ctx.message.id,
  });

  await next();
};
