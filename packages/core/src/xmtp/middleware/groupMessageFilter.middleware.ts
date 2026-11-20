import { AgentMiddleware, filter } from "@xmtp/agent-sdk";

export const groupMessageFilterMiddleware: AgentMiddleware = async (ctx, next) => {
  const isSelfMessage = filter.fromSelf(ctx.message, ctx.client);

  if (isSelfMessage) return;
  await next();
};
