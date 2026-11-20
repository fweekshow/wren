import { filter, type MessageContext } from "@xmtp/agent-sdk";
import {
  ContentTypeWalletSendCalls,
  type WalletSendCallsParams,
} from "@xmtp/content-type-wallet-send-calls";

import { buildRoutedSwap, type WalletCall } from "@/discovery/ai.js";
import {
  analyzeBaseContentTokenLink,
  analyzeBaseContractAddress,
  extractAnalysisContractAddress,
  extractBaseContentUrl,
} from "@/discovery/services/baseContentToken.service.js";
import { registerAction, sendActions } from "@/xmtp/content-types/inline-actions/index.js";
import type { ActionsContent } from "@/xmtp/content-types/inline-actions/types/ActionsContent.js";
import {
  type EventResult,
  extractReplyText,
  removeMention,
  resolveSenderWalletAddress,
  sendMarkdownOrText,
  shouldEngageInGroup,
  type PluginMetadata,
  XMTPServicePlugin,
} from "@/xmtp/core/index.js";
import { pendingUserKey } from "@/xmtp/core/pendingInteractionRegistry.js";

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BUY_AMOUNTS = ["10", "25", "50", "100"];

const pendingCustomBaseContentBuy = new Map<
  string,
  {
    tokenAddress: string;
    tokenSymbol: string;
  }
>();

async function sendWalletSendCalls(
  ctx: MessageContext,
  calls: WalletCall[],
  fallbackText: string,
  from: string,
): Promise<void> {
  const payload: WalletSendCallsParams = {
    version: "1.0",
    chainId: "0x2105",
    from: from as `0x${string}`,
    calls: calls.map((call) => ({
      to: call.to,
      data: call.data,
      value: call.value,
      metadata: call.metadata,
    })),
  };

  try {
    await (ctx.conversation as any).send(payload, ContentTypeWalletSendCalls);
  } catch (err) {
    console.error("BaseContentTokenPlugin wallet_sendCalls failed:", err);
    await ctx.conversation.send(fallbackText);
  }
}

export class BaseContentTokenPlugin extends XMTPServicePlugin {
  metadata: PluginMetadata = {
    name: "BaseContentTokenPlugin",
    version: "1.0.0",
    priority: 40,
    description: "Analyzes Base App content links that expose token contract addresses",
  };

  onText = async (ctx: MessageContext<string>): Promise<EventResult> => {
    return this.handleContentMessage(ctx, ctx.message.content);
  };

  onReply = async (ctx: MessageContext<any>): Promise<EventResult> => {
    const text = extractReplyText(ctx);
    if (!text.trim()) return false;
    return this.handleContentMessage(ctx as MessageContext<string>, text);
  };

  private async handleContentMessage(
    ctx: MessageContext<string>,
    messageContent: string,
  ): Promise<EventResult> {
    const isGroup = filter.isGroup(ctx.conversation);

    if (isGroup && !(await shouldEngageInGroup(ctx, messageContent))) {
      return false;
    }

    const cleanContent = isGroup ? removeMention(messageContent) : messageContent;
    const pendingKey = pendingUserKey(ctx.message.senderInboxId, ctx.conversation.id);
    const pendingBuy = pendingCustomBaseContentBuy.get(pendingKey);
    if (pendingBuy) {
      const rawAmount = cleanContent.replace(/[^0-9.]/g, "").trim();
      const parsed = parseFloat(rawAmount);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 10000) {
        pendingCustomBaseContentBuy.delete(pendingKey);
        await this.sendBuyTransaction(
          ctx,
          pendingBuy.tokenAddress,
          pendingBuy.tokenSymbol,
          rawAmount,
        );
        return true;
      }
      if (rawAmount) {
        pendingCustomBaseContentBuy.delete(pendingKey);
      }
    }

    const baseContentUrl = extractBaseContentUrl(cleanContent);
    const analysisAddress = extractAnalysisContractAddress(cleanContent);
    if (!baseContentUrl && !analysisAddress) {
      return false;
    }

    try {
      await ctx.conversation.send("Fetching the Base token details...");
      const result = analysisAddress
        ? await analyzeBaseContractAddress(analysisAddress)
        : await (async () => {
            const linkResult = await analyzeBaseContentTokenLink(cleanContent);
            return linkResult.handled ? linkResult : null;
          })();

      if (!result) return false;

      await sendMarkdownOrText(ctx, result.report);
      if (result.address) {
        await this.sendTradeNowAction(ctx, result.address, result.tokenSymbol, result.imageUrl);
      }
      return true;
    } catch (err) {
      console.error("BaseContentTokenPlugin failed:", err);
      await ctx.conversation.send(
        "I couldn't fetch that Base content link right now. Try again in a bit.",
      );
      return true;
    }
  };

  private async sendTradeNowAction(
    ctx: MessageContext<string>,
    tokenAddress: string,
    tokenSymbol: string,
    imageUrl?: string | null,
  ): Promise<void> {
    const safeSymbol = tokenSymbol.replace(/[^a-zA-Z0-9]/g, "").toUpperCase() || "TOKEN";
    const msgId = ctx.message.id.slice(0, 8);
    const tokenKey = `${safeSymbol.toLowerCase()}_${msgId}`;
    const tradeActionId = `base_trade_${tokenKey}`;
    const customActionId = `base_amt_custom_${tokenKey}`;

    for (const amount of BUY_AMOUNTS) {
      registerAction(`base_amt_${amount}_${tokenKey}`, async (actionCtx: MessageContext) => {
        await this.sendBuyTransaction(
          actionCtx as MessageContext<string>,
          tokenAddress,
          safeSymbol,
          amount,
        );
      });
    }

    registerAction(customActionId, async (actionCtx: MessageContext) => {
      pendingCustomBaseContentBuy.set(
        pendingUserKey(actionCtx.message.senderInboxId, actionCtx.conversation.id),
        {
          tokenAddress,
          tokenSymbol: safeSymbol,
        },
      );
      await actionCtx.conversation.send(
        `How much USDC do you want to spend on $${safeSymbol}? Reply with a number (e.g. 50)`,
      );
    });

    registerAction(tradeActionId, async (actionCtx: MessageContext) => {
      const amountMenu: ActionsContent = {
        id: `base_buy_amt_${tokenKey}`,
        description: `How much USDC to buy $${safeSymbol}? (Actual fill may be lower for thin pools)`,
        actions: [
          ...BUY_AMOUNTS.map((amount) => ({
            id: `base_amt_${amount}_${tokenKey}`,
            label: `$${amount}`,
            style: "primary" as const,
          })),
          {
            id: customActionId,
            label: "Custom",
            style: "secondary" as const,
          },
        ],
      };
      await sendActions(actionCtx.conversation, amountMenu);
    });

    await sendActions(ctx.conversation, {
      id: `base_trade_${tokenKey}`,
      description: `Ready to trade $${safeSymbol}?`,
      actions: [
        {
          id: tradeActionId,
          label: "Trade Now",
          style: "primary" as const,
          ...(imageUrl ? { imageUrl } : {}),
        },
      ],
    });
  }

  private async sendBuyTransaction(
    ctx: MessageContext<string>,
    tokenAddress: string,
    tokenSymbol: string,
    amount: string,
  ): Promise<void> {
    const buyerAddress = (await resolveSenderWalletAddress(ctx as any)) || "";
    if (!buyerAddress) {
      await ctx.conversation.send(
        "Connect your wallet in Base App first, then try Trade Now again.",
      );
      return;
    }

    await ctx.conversation.send(`Getting best price for $${tokenSymbol}...`);
    const swap = await buildRoutedSwap(
      USDC_ADDRESS,
      "USDC",
      6,
      tokenAddress,
      tokenSymbol,
      amount,
      buyerAddress,
    );

    if (!swap) {
      await ctx.conversation.send(
        `Couldn't build a swap for $${tokenSymbol}. The token may not have a Uniswap pool yet.`,
      );
      return;
    }

    await sendWalletSendCalls(ctx, swap.calls, swap.label, buyerAddress);
  }
}
