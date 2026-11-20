import { filter, type MessageContext } from "@xmtp/agent-sdk";

import { handleAccountLinkCommand } from "@/account-linking/index.js";
import { logger } from "@/utils/logger.js";
import {
  type EventResult,
  extractReplyText,
  resolveSenderWalletAddress,
  sendAgentText,
  type PluginMetadata,
  XMTPServicePlugin,
} from "@/xmtp/core/index.js";

const PLATFORM = "xmtp" as const;
const PENDING_TTL_MS = 5 * 60 * 1000;

/**
 * Cross-platform account linking over XMTP / Base App. Mirrors the iMessage
 * handler's connection-string handshake using the shared account-linking
 * service so a Base App user can link their iMessage identity (and vice versa).
 *
 * Runs at a high priority (low number) so connect intents and pasted tokens are
 * intercepted before the discovery AI. Only operates in DMs — linking secrets
 * should never be pasted in a group.
 */
export class AccountLinkPlugin extends XMTPServicePlugin {
  metadata: PluginMetadata = {
    name: "AccountLinkPlugin",
    version: "1.0.0",
    priority: 25,
    description: "Cross-platform account linking via one-time connection strings",
  };

  /** key = `${inboxId}:${conversationId}` → awaiting a string / "Generate". */
  private pendingLinks = new Map<string, number>();

  constructor() {
    super();
    this.onText = this.onText.bind(this);
    this.onReply = this.onReply.bind(this);
  }

  async onText(ctx: MessageContext<string>): Promise<EventResult> {
    return this.handle(ctx, ctx.message.content);
  }

  async onReply(ctx: MessageContext<any>): Promise<EventResult> {
    const text = extractReplyText(ctx);
    if (!text.trim()) return false;
    return this.handle(ctx as MessageContext<string>, text);
  }

  private pendingKey(ctx: MessageContext<string>): string {
    return `${ctx.message.senderInboxId}:${ctx.conversation.id}`;
  }

  private isAwaiting(key: string): boolean {
    const at = this.pendingLinks.get(key);
    if (at == null) return false;
    if (Date.now() - at > PENDING_TTL_MS) {
      this.pendingLinks.delete(key);
      return false;
    }
    return true;
  }

  private async handle(ctx: MessageContext<string>, rawText: string): Promise<EventResult> {
    // Linking only happens in 1:1 DMs.
    if (filter.isGroup(ctx.conversation)) return false;

    const text = rawText.trim();
    if (!text) return false;

    const key = this.pendingKey(ctx);
    const awaitingConnection = this.isAwaiting(key);

    try {
      const wallet = await resolveSenderWalletAddress(ctx);
      const result = await handleAccountLinkCommand({
        platform: PLATFORM,
        userKey: ctx.message.senderInboxId,
        walletAddress: wallet,
        text,
        awaitingConnection,
      });

      if (result.clearPending) this.pendingLinks.delete(key);
      if (!result.handled) return false;

      if (result.setPending) this.pendingLinks.set(key, Date.now());
      await sendAgentText(ctx, result.reply);
      return true;
    } catch (err: any) {
      logger.error(`❌ AccountLinkPlugin failed: ${err?.message || err}`);
      await sendAgentText(ctx, "I couldn't process that account-linking request right now.");
      return true;
    }
  }
}
