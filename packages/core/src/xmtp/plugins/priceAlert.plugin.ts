import { filter, type MessageContext } from "@xmtp/agent-sdk";

import { PriceAlertAdapter } from "@/discovery/adapters/priceAlert.adapter.js";
import {
  createAlertFromIntent,
  extractContractAddress,
  parseAlertIntents,
  parseDmTarget,
  pendingAlerts,
  pendingAlertKey,
  priceAlertDelivery,
  type FinalizeAlertInput,
  type ParsedAlertIntent,
  type SetupAlertResult,
} from "@/price-alerts/index.js";
import { logger } from "@/utils/logger.js";
import {
  type EventResult,
  type PluginMetadata,
  XMTPServicePlugin,
} from "@/xmtp/core/index.js";
import { registerPendingInteractionChecker } from "@/xmtp/core/pendingInteractionRegistry.js";
import { extractReplyText, shouldEngageInGroup } from "@/xmtp/core/groupEngagement.js";
import {
  removeMention,
  resolveSenderWalletAddress,
  sendAgentText,
  sendMarkdownOrText,
} from "@/xmtp/core/utils.js";

const PLATFORM = "xmtp" as const;
const LIST_RE = /\b(?:my|list|show|view)\s+(?:price\s+)?alerts?\b/i;
const CANCEL_RE =
  /\b(?:cancel|canecel|stop)\s+(?:(?:all|every)\s+)?(?:(?:price\s+)?alerts?\b|#?\d+\b)/i;
const CANCEL_WORD_RE = /^(?:cancel|canecel|nvm|never\s?mind|stop|forget it)\b/i;

function extractAlertIds(text: string): number[] {
  const ids = Array.from(text.matchAll(/#?(\d+)\b/g), (match) => Number(match[1]))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  return [...new Set(ids)];
}

/**
 * One-time token price alerts over XMTP. Users can set an alert from a DM or a
 * group (subject to the normal @mention / reply gate), but the alert itself is
 * always delivered to their DM. Runs ahead of BaseContentTokenPlugin (40) and
 * DiscoveryPlugin (60) so explicit alert requests are claimed first; anything
 * that isn't an alert falls through untouched.
 */
export class PriceAlertPlugin extends XMTPServicePlugin {
  metadata: PluginMetadata = {
    name: "PriceAlertPlugin",
    version: "1.0.0",
    priority: 30,
    description: "One-time token price alerts (DM delivery)",
  };

  constructor() {
    super();
    this.onText = this.onText.bind(this);
    this.onReply = this.onReply.bind(this);
  }

  async onInit(): Promise<void> {
    priceAlertDelivery.register(PLATFORM, async (alert, message) => {
      const target = parseDmTarget<{ walletAddress?: string }>(alert);
      const wallet = target?.walletAddress;
      if (!wallet || !this.client) return false;
      try {
        const dm: any = await this.client.conversations.newDmWithIdentifier({
          identifier: wallet as `0x${string}`,
          identifierKind: 0,
        });
        if (typeof dm.sync === "function") await dm.sync();
        await dm.send(message);
        return true;
      } catch (err: any) {
        logger.warn(`⚠️ XMTP price-alert DM failed: ${err?.message || err}`);
        return false;
      }
    });

    // Let group-engagement treat a user mid-disambiguation as an active flow.
    registerPendingInteractionChecker(async (key) =>
      pendingAlerts.hasAsync(`${PLATFORM}:${key}`),
    );

    logger.info("✅ PriceAlertPlugin initialized");
  }

  async onText(ctx: MessageContext<string>): Promise<EventResult> {
    return this.handle(ctx, ctx.message.content);
  }

  async onReply(ctx: MessageContext<any>): Promise<EventResult> {
    const text = extractReplyText(ctx);
    if (!text.trim()) return false;
    return this.handle(ctx as MessageContext<string>, text);
  }

  private coreInput(
    ctx: MessageContext<string>,
    isGroup: boolean,
    wallet: string | null,
  ): FinalizeAlertInput {
    return {
      platform: PLATFORM,
      userKey: ctx.message.senderInboxId,
      dmTarget: wallet ? { walletAddress: wallet } : null,
      sourceConversationId: ctx.conversation.id,
      sourceIsGroup: isGroup,
    };
  }

  private async handle(
    ctx: MessageContext<string>,
    rawText: string,
  ): Promise<EventResult> {
    try {
      const isGroup = filter.isGroup(ctx.conversation);
      const key = pendingAlertKey(
        PLATFORM,
        ctx.message.senderInboxId,
        ctx.conversation.id,
      );
      const cleanRaw = isGroup ? removeMention(rawText) : rawText;

      // Follow-up: the user previously got an ambiguity prompt. Complete the
      // alert with the contract address they just sent — even in a group where
      // the follow-up won't @mention the bot.
      const pending = await pendingAlerts.getAsync(key);
      if (pending) {
        const address = extractContractAddress(cleanRaw);
        if (address) {
          const wallet = await resolveSenderWalletAddress(ctx);
          const result = await createAlertFromIntent(
            this.coreInput(ctx, isGroup, wallet),
            { ...pending, contractAddress: address, tokenQuery: address },
          );
          this.persistPending(key, pending, result);
          await sendMarkdownOrText(ctx, this.replyFor(result));
          return true;
        }
        if (CANCEL_WORD_RE.test(cleanRaw.trim())) {
          pendingAlerts.delete(key);
          await sendAgentText(ctx, "Okay, cancelled. No alert was set.");
          return true;
        }
      }

      if (isGroup && !(await shouldEngageInGroup(ctx, rawText))) {
        return false;
      }

      const text = cleanRaw;

      if (CANCEL_RE.test(text)) {
        return this.handleCancel(ctx, text);
      }
      if (LIST_RE.test(text)) {
        return this.handleList(ctx);
      }

      const intents = parseAlertIntents(text);
      if (intents.length === 0) return false;

      const wallet = await resolveSenderWalletAddress(ctx);

      if (intents.length === 1) {
        const intent = intents[0];
        const result = await createAlertFromIntent(
          this.coreInput(ctx, isGroup, wallet),
          intent,
        );

        if (result.kind === "not_an_alert") return false;
        // Remember ambiguous / unresolved requests so the next message (a contract
        // address) can finish the job.
        this.persistPending(key, intent, result);
        await sendMarkdownOrText(ctx, this.replyFor(result));
        return true;
      }

      await this.createMultipleAlerts(ctx, key, intents, isGroup, wallet);
      return true;
    } catch (err: any) {
      logger.error(`❌ PriceAlertPlugin failed: ${err?.message || err}`);
      return true;
    }
  }

  /** Keep or clear the pending follow-up slot based on the setup outcome. */
  private persistPending(
    key: string,
    intent: Parameters<typeof pendingAlerts.set>[1],
    result: SetupAlertResult,
  ): void {
    if (
      result.kind === "ambiguous" ||
      result.kind === "unresolved" ||
      result.kind === "unpriced"
    ) {
      pendingAlerts.set(key, intent);
    } else {
      pendingAlerts.delete(key);
    }
  }

  private replyFor(result: SetupAlertResult): string {
    if (result.kind === "created") return `Alert #${result.alertId}: ${result.reply}`;
    return "reply" in result ? result.reply : "Something went wrong setting that alert.";
  }

  private async createMultipleAlerts(
    ctx: MessageContext<string>,
    key: string,
    intents: ParsedAlertIntent[],
    isGroup: boolean,
    wallet: string | null,
  ): Promise<void> {
    const input = this.coreInput(ctx, isGroup, wallet);
    const replies: string[] = [];
    let created = 0;

    for (const intent of intents) {
      const result = await createAlertFromIntent(input, intent);
      this.persistPending(key, intent, result);

      if (result.kind === "created") {
        created += 1;
        replies.push(this.replyFor(result));
      } else if ("reply" in result) {
        replies.push(result.reply);
      }
    }

    if (created > 0) {
      await sendMarkdownOrText(
        ctx,
        [`Created ${created} alert${created === 1 ? "" : "s"}.`, ...replies].join("\n"),
      );
      return;
    }

    if (replies.length > 0) {
      await sendMarkdownOrText(ctx, replies.join("\n"));
    }
  }

  private async handleList(ctx: MessageContext<string>): Promise<EventResult> {
    const alerts = await PriceAlertAdapter.listActiveForUser(
      PLATFORM,
      ctx.message.senderInboxId,
    );
    if (alerts.length === 0) {
      await sendAgentText(ctx, "You have no active price alerts.");
      return true;
    }
    const lines = alerts.map((a) => {
      const label = a.metric === "market_cap_usd" ? "MC" : "price";
      return `#${a.id}: ${a.symbol} ${label} ${a.direction} $${Number(a.target_value)}`;
    });
    await sendAgentText(ctx, ["Your active price alerts:", ...lines].join("\n"));
    return true;
  }

  private async handleCancel(
    ctx: MessageContext<string>,
    text: string,
  ): Promise<EventResult> {
    const ids = extractAlertIds(text);
    let count = 0;

    if (ids.length === 0) {
      count = await PriceAlertAdapter.cancelForUser(PLATFORM, ctx.message.senderInboxId);
    } else {
      for (const id of ids) {
        count += await PriceAlertAdapter.cancelForUser(
          PLATFORM,
          ctx.message.senderInboxId,
          id,
        );
      }
    }

    await sendAgentText(
      ctx,
      count > 0
        ? `Cancelled ${count} alert${count === 1 ? "" : "s"}.`
        : "No matching active alert to cancel.",
    );
    return true;
  }
}
