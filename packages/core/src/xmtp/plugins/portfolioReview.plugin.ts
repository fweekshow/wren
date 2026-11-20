import { filter, type MessageContext } from "@xmtp/agent-sdk";
import { ContentTypeMarkdown } from "@xmtp/content-type-markdown";

import {
  handlePortfolioReviewCommand,
  parseReviewDmTarget,
  portfolioReviewDelivery,
} from "@/portfolio-reviews/index.js";
import { logger } from "@/utils/logger.js";
import {
  type EventResult,
  extractReplyText,
  removeMention,
  resolveSenderWalletAddress,
  sendAgentText,
  shouldEngageInGroup,
  type PluginMetadata,
  XMTPServicePlugin,
} from "@/xmtp/core/index.js";

const PLATFORM = "xmtp" as const;

export class PortfolioReviewPlugin extends XMTPServicePlugin {
  metadata: PluginMetadata = {
    name: "PortfolioReviewPlugin",
    version: "1.0.0",
    priority: 35,
    description: "Daily portfolio review scheduling and delivery",
  };

  constructor() {
    super();
    this.onText = this.onText.bind(this);
    this.onReply = this.onReply.bind(this);
  }

  async onInit(): Promise<void> {
    portfolioReviewDelivery.register(PLATFORM, async (subscription, message) => {
      const target = parseReviewDmTarget<{ walletAddress?: string }>(subscription);
      const wallet = target?.walletAddress ?? subscription.wallet_address;
      if (!wallet || !this.client) return false;
      try {
        const dm: any = await this.client.conversations.newDmWithIdentifier({
          identifier: wallet as `0x${string}`,
          identifierKind: 0,
        });
        if (typeof dm.sync === "function") await dm.sync();
        await dm.send(message, ContentTypeMarkdown);
        return true;
      } catch (err: any) {
        logger.warn(`⚠️ XMTP portfolio review DM failed: ${err?.message || err}`);
        return false;
      }
    });
    logger.info("✅ PortfolioReviewPlugin initialized");
  }

  async onText(ctx: MessageContext<string>): Promise<EventResult> {
    return this.handle(ctx, ctx.message.content);
  }

  async onReply(ctx: MessageContext<any>): Promise<EventResult> {
    const text = extractReplyText(ctx);
    if (!text.trim()) return false;
    return this.handle(ctx as MessageContext<string>, text);
  }

  private async handle(ctx: MessageContext<string>, rawText: string): Promise<EventResult> {
    try {
      const isGroup = filter.isGroup(ctx.conversation);
      const text = isGroup ? removeMention(rawText) : rawText;
      const wallet = await resolveSenderWalletAddress(ctx);
      const result = await handlePortfolioReviewCommand({
        platform: PLATFORM,
        userKey: ctx.message.senderInboxId,
        text,
        walletAddress: wallet,
        dmTarget: wallet ? { walletAddress: wallet } : null,
      });

      if (!result.handled) {
        if (isGroup && !(await shouldEngageInGroup(ctx, rawText))) return false;
        return false;
      }

      await sendAgentText(ctx, result.reply);
      return true;
    } catch (err: any) {
      logger.error(`❌ PortfolioReviewPlugin failed: ${err?.message || err}`);
      await sendAgentText(ctx, "I couldn't update your portfolio review settings right now.");
      return true;
    }
  }
}
