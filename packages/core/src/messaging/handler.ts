import { sanitizeAmount, type WalletCall } from "@basemate/shared";
import {
  convKey,
  stateDelete,
  stateGet,
  stateHas,
  stateHasAny,
  stateSet,
} from "@/state/conversationState.store.js";

import { config } from "@/config/config.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import {
  resolveTokenAsync,
  type AIResponse,
  DiscoveryAI,
} from "@/discovery/ai.js";
import { detectWalletIntent, giftStockHint, looksLikeGiftStockAsk, parseGiftStock } from "@/discovery/ai/intents.js";
import { checkInboundContentGuardrails } from "@/discovery/contentGuardrails.js";
import { resolveSendRecipient } from "@/discovery/services/sendRecipient.service.js";
import { fetchErc20TokenBalance } from "@/portfolio-reviews/index.js";
import { handleAccountLinkCommand, resolveAllWalletsForUser } from "@/account-linking/index.js";
import {
  createAlertFromIntent,
  extractContractAddress,
  pendingAlerts,
  pendingAlertKey,
} from "@/price-alerts/index.js";
import { GasEstimationError, InsufficientGasError, type TokenBalance } from "@/wallet/cdp.js";
import {
  generateOtp,
  issueEmailOtp,
  resendEmailOtp,
  verifyEmailOtp,
} from "@/wallet/emailOtp.js";
import { FundSessionAdapter } from "@/wallet/fundSession.js";
import { createHeadlessOnrampOrder } from "@/wallet/onramp.js";
import { OnrampUserDataAdapter } from "@/wallet/onrampUserData.js";
import { PhoneEscrowAdapter } from "@/wallet/phoneEscrow.js";
import {
  formatSweepPreview,
  formatSweepResult,
  resolveCustodialSweepWallets,
  sweepCustodialWallets,
  type SweepWalletTarget,
} from "@/wallet/sweep.js";

import { ContactsAdapter } from "./contacts.adapter.js";
import { UserProfileAdapter } from "./adapters/userProfile.adapter.js";
import {
  confettiTextOutbound,
  renderAIResponseText,
  singleBubbleTextOutbound,
  stripMarkdown,
  transactionMiniAppOutbound,
  type ImessageOutbound,
} from "@/imessage/outbound.js";
import { launchFlowKey } from "./utils/launch.utils.js";
import {
  LlmImessageIntentEngine,
  type ImessageIntent,
  type ImessageIntentContext,
  type ImessageIntentEngine,
} from "./intentEngine.js";
import {
  productModeForIntentAction,
  productModeForPendingState,
  type ImessageProductMode,
} from "./productMode.js";
export type {
  CreateMessagingHandlerOptions,
  ImessageHandler,
  ImessageInboundParams,
  MessagingPlatform,
} from "./handler.types.js";
import type {
  ContactTransferNotification,
  CreateMessagingHandlerOptions,
  ImessageAvantisCloseRequest,
  ImessageHandler,
  ImessageInboundParams,
  ImessagePerpState,
  LastBalanceAssetMention,
  MessagingPlatform,
  PendingAmountChoice,
  PendingEscrowConfirm,
  PendingSendMessage,
  PendingPerpFlow,
  PendingSwapDraft,
  PendingTrade,
  PendingYieldChoice,
  TradeDeliveryContext,
} from "./handler.types.js";
import {
  basemateTxUrl,
  executePendingTrade,
  explicitPresetAmountMessage,
  explicitYieldMessage,
  extractBalanceAssetMention,
  extractRecipientName,
  findWalletBalance,
  formatPhoneDisplay,
  hasFullBalancePhrase,
  isAmountPromptResponse,
  isBalanceFastPathIntent,
  isEmptyPortfolio,
  isEmptyPortfolioSummaryResponse,
  isEmptyPortfolioSummaryText,
  isFundIntent,
  looksLikeEmail,
  looksLikeOtp,
  mainWalletInfoText,
  normalizeContactPhone,
  parseChoiceIndex,
  parseContactSaveText,
  parseCustomDepositAmountUsd,
  parseNumberText,
  parsePresetChoiceIndex,
  parseSwapDraft,
  PENDING_OTP_TTL_MS,
  PENDING_TRADE_TTL_MS,
  phoneNumberForHeadlessOnramp,
  rememberPendingAlert,
  requiresWalletBeforeGeneralAi,
  replyFromResult,
  saveImessageContactFromChat,
  shouldRouteToGeneralAi,
  trimBalanceAmount,
  walletBalanceLines,
  walletOnboardingEmailPrompt,
  ZERO_ADDRESS,
} from "./handler.utils.js";
import {
  extractExplicitTransferMessage,
  isTransferMessageSkip,
  normalizeTransferMessage,
  stripExplicitTransferMessage,
} from "./utils/transferMessage.utils.js";

import type { HandlerCtx } from "./handler.ctx.js";
import {
  connectBasemateAccountMessages as _connectBasemateAccountMessages,
  getConnectedWalletAddress as _getConnectedWalletAddress,
  transactionApprovalOutbound as _transactionApprovalOutbound,
  hasPendingInteraction as _hasPendingInteraction,
} from "./handlers/account.handler.js";
import {
  handleFundAmount as _handleFundAmount,
  handleOfframpIntent as _handleOfframpIntent,
  executePendingSweep as _executePendingSweep,
  executePendingWithdraw as _executePendingWithdraw,
  buildPhoneEscrowDepositLink as _buildPhoneEscrowDepositLink,
  routeTransactionResponse as _routeTransactionResponse,
  type PendingSweep,
  type PendingWithdraw,
} from "./handlers/wallet.handler.js";
import {
  cancelPendingFlashOrder as _cancelPendingFlashOrder,
  executePendingFlashOrder as _executePendingFlashOrder,
  routeFlashOrderResponse as _routeFlashOrderResponse,
  type PendingFlashOrder,
} from "./handlers/flash.handler.js";
import {
  respondToFollowup as _respondToFollowup,
  executePostSwapDeposit as _executePostSwapDeposit,
} from "./handlers/followup.handler.js";
import { handleCopyTradeText } from "./handlers/copyTrade.handler.js";

/** Base mainnet chain id (hex), used for every iMessage transaction. */
const BASE_CHAIN_ID = "0x2105" as const;

/**
 * True when a resolved recipient label is a real person name worth saving as a
 * contact (not a bare phone number or a 0x address). Guards the send-success
 * auto-save so we never store a contact whose "name" is just the number.
 */
function isSavableContactName(name: string | null | undefined): name is string {
  const n = name?.trim();
  if (!n) return false;
  if (n.toLowerCase().startsWith("0x")) return false;
  if (/^\+?[\d\s().\-]{6,}$/.test(n)) return false; // phone-like
  return true;
}

function formatEscrowConfirmPrompt(escrow: PendingEscrowConfirm["escrow"]): string {
  const who = `${escrow.contactName} (${escrow.phone})`;
  if (escrow.sourceUsdcAmount && escrow.quotedLocalAmount) {
    return (
      `reply YES to convert ${escrow.sourceUsdcAmount} USDC → ~${escrow.quotedLocalAmount} ${escrow.tokenSymbol} ` +
      `for ${who} to claim, or NO to cancel.`
    );
  }
  return (
    `reply YES to send ${escrow.amount} ${escrow.tokenSymbol} for ${who} to claim, or NO to cancel.`
  );
}

/** Detects a compound "swap X→Y and deposit/stake on PROTOCOL" user message. */
function detectCompoundSwapDeposit(
  message: string,
): { toAsset: string; protocol: string } | null {
  const lower = message.toLowerCase();
  if (!/\b(swap|exchange|convert|trade)\b/.test(lower)) return null;
  if (!/\b(and|then|also)\b/.test(lower)) return null;
  if (!/\b(stake|deposit|earn|supply|put|invest)\b/.test(lower)) return null;
  let protocol: string | null = null;
  if (/\bmorpho\b/.test(lower)) protocol = "morpho";
  else if (/\bmoonwell\b/.test(lower)) protocol = "moonwell";
  else if (/\baave\b/.test(lower)) protocol = "aave";
  if (!protocol) return null;
  const toMatch = message.match(/\b(?:to|into)\s+([A-Z][A-Za-z0-9]{1,9})\b/);
  if (!toMatch) return null;
  const toAsset = toMatch[1].toUpperCase();
  const skip = new Set(["MORPHO", "MOONWELL", "AAVE", "THE", "IT", "THEM", "A", "AN"]);
  if (skip.has(toAsset)) return null;
  return { toAsset, protocol };
}

/**
 * Shared inbound message pipeline for Spectrum iMessage and the local REPL.
 * Returns outbound plain-text chunks in the order they should be sent.
 */
export function createImessageHandler(
  ai = new DiscoveryAI(),
  intentEngine: ImessageIntentEngine = new LlmImessageIntentEngine(),
  options: CreateMessagingHandlerOptions = {},
): ImessageHandler {
  const platform = options.platform ?? "imessage";
  const logPrefix = options.logPrefix ?? (platform === "whatsapp" ? "[WhatsApp]" : "[iMessage]");
  const platformLabel = platform === "whatsapp" ? "WhatsApp" : "iMessage";
  const dmTargetForConversation = (dmConversationId: string): Record<string, unknown> =>
    platform === "whatsapp" ? { to: dmConversationId } : { spaceId: dmConversationId };
  // ── Conversation-state key builders (namespaced by platform + scopeId) ─────
  // All pending-flow state is now stored in Redis (with in-process fallback).
  // Key pattern: conv:{platform}:{scopeId}:{slotName}
  // For perp-flows the scopeId is the perpFlowKey (`${senderId}:${conversationId}`).
  const K = {
    pendingTrade:                (s: string) => convKey(platform, s, "pendingTrade"),
    pendingPerpFlow:             (k: string) => convKey(platform, k, "pendingPerpFlow"),
    pendingSweep:                (s: string) => convKey(platform, s, "pendingSweep"),
    pendingYieldChoice:          (s: string) => convKey(platform, s, "pendingYieldChoice"),
    pendingAmountChoice:         (s: string) => convKey(platform, s, "pendingAmountChoice"),
    pendingSwapDraft:            (s: string) => convKey(platform, s, "pendingSwapDraft"),
    lastBalanceAssetMention:     (s: string) => convKey(platform, s, "lastBalanceAssetMention"),
    pendingContactName:          (s: string) => convKey(platform, s, "pendingContactName"),
    pendingContactConfirm:       (s: string) => convKey(platform, s, "pendingContactConfirm"),
    pendingSendDisambiguation:   (s: string) => convKey(platform, s, "pendingSendDisambiguation"),
    pendingSendMessage:          (s: string) => convKey(platform, s, "pendingSendMessage"),
    pendingDisplayName:          (s: string) => convKey(platform, s, "pendingDisplayName"),
    pendingLink:                 (s: string) => convKey(platform, s, "pendingLink"),
    pendingPostTxAction:         (s: string) => convKey(platform, s, "pendingPostTxAction"),
    pendingOnrampEmail:          (s: string) => convKey(platform, s, "pendingOnrampEmail"),
    pendingEmailOtpVerification: (s: string) => convKey(platform, s, "pendingEmailOtpVerification"),
    pendingPhoneOtpVerification: (s: string) => convKey(platform, s, "pendingPhoneOtpVerification"),
    pendingFundAmount:           (s: string) => convKey(platform, s, "pendingFundAmount"),
    pendingOfframpAmount:        (s: string) => convKey(platform, s, "pendingOfframpAmount"),
    pendingWithdraw:             (s: string) => convKey(platform, s, "pendingWithdraw"),
    pendingWorldCupMatch:        (s: string, cid?: string) => convKey(platform, cid ? `${s}:${cid}` : s, "pendingWorldCupMatch"),
    pendingEscrowConfirm:        (s: string) => convKey(platform, s, "pendingEscrowConfirm"),
    pendingGiftStock:            (s: string) => convKey(platform, s, "pendingGiftStock"),
    pendingFlashOrder:           (s: string) => convKey(platform, s, "pendingFlashOrder"),
    pendingGroupCopyTrade:       (cid: string) => convKey(platform, cid, "pendingGroupCopyTrade"),
    pendingCopyTradeAmount:      (scopeId: string) => convKey(platform, scopeId, "pendingCopyTradeAmount"),
    pendingLaunch:               (k: string) => convKey(platform, k, "pendingLaunch"),
  } as const;

  const ctx: HandlerCtx = {
    platform,
    logPrefix,
    platformLabel,
    K,
    ai,
    intentEngine,
    dmTargetForConversation,
  };

  // ── Closure wrappers (bind ctx to extracted handler functions) ─────────────
  const connectBasemateAccount = (senderId: string, opts?: { reauth?: boolean }) =>
    _connectBasemateAccountMessages(ctx, senderId, opts);
  const getConnectedWalletAddress = (senderId: string) => _getConnectedWalletAddress(ctx, senderId);
  const transactionApprovalOutbound = (args: Parameters<typeof _transactionApprovalOutbound>[1]) =>
    _transactionApprovalOutbound(ctx, args);
  const hasPendingInteraction = (params: { senderId: string; conversationId: string }) =>
    _hasPendingInteraction(ctx, params);

  const handleFundAmount = (senderId: string, walletAddress: string, amount: string) =>
    _handleFundAmount(ctx, senderId, walletAddress, amount);
  const handleOfframpIntent = (senderId: string, walletAddress: string, amount: string) =>
    _handleOfframpIntent({ platform, senderId, walletAddress, amount });
  const executePendingSweep = (pending: PendingSweep) =>
    _executePendingSweep(ctx, pending);
  const executePendingWithdraw = (pending: PendingWithdraw) =>
    _executePendingWithdraw(ctx, pending);
  const buildPhoneEscrowDepositLink = (args: {
    senderId: string;
    phone: string;
    contactName: string;
    amount: string;
    tokenAddress: string;
    tokenSymbol: string;
    tokenDecimals: number;
    senderWalletAddress: string;
    memo?: string;
    autoSaveContact?: { name: string; phone: string };
    sourceUsdcAmount?: string;
    quotedLocalAmount?: string;
  }) => _buildPhoneEscrowDepositLink(ctx, args);
  const routeTransactionResponse = (args: {
    senderId: string;
    conversationId: string;
    originalText: string;
    resp: Extract<AIResponse, { type: "transaction" }>;
    custodialAccountName?: string;
    contactTransfer?: ContactTransferNotification;
    isGroup?: boolean;
    deliveryPhone?: string;
  }) => _routeTransactionResponse(ctx, args);
  const routeFlashOrderResponse = (args: {
    senderId: string;
    conversationId: string;
    resp: Extract<AIResponse, { type: "flash_order" }>;
  }) => _routeFlashOrderResponse(ctx, args);

  const startAvantisCloseFromChat = (args: {
    senderId: string;
    text: string;
    intent: ImessageIntent;
    walletAddress: string;
  }) => _startAvantisCloseFromChat(ctx, args);
  const executeFullBalanceSwap = (args: {
    senderId: string;
    conversationId: string;
    text: string;
    draft: PendingSwapDraft;
    walletAddress: string;
    custodialAccountName?: string;
    tradeContext?: Omit<TradeDeliveryContext, "copyTradeCtx">;
  }) => _executeFullBalanceSwap(ctx, args);
  const submitPerpTrade = (params: {
    senderId: string;
    state: ImessagePerpState;
    walletAddress: string;
    tradeContext?: Omit<TradeDeliveryContext, "copyTradeCtx">;
  }) => _submitPerpTrade(ctx, params);
  const renderNextPerpStep = (
    flowKey: string,
    flow: PendingPerpFlow,
    params: {
      senderId: string;
      walletAddress: string;
      custodialAccountName?: string;
      tradeContext?: Omit<TradeDeliveryContext, "copyTradeCtx">;
    },
  ) => _renderNextPerpStep(ctx, flowKey, flow, params);

  const respondToFollowup = (
    senderId: string,
    conversationId: string,
    message: string,
    walletAddress: string,
    context?: Omit<TradeDeliveryContext, "copyTradeCtx">,
  ) => _respondToFollowup(ctx, senderId, conversationId, message, walletAddress, context);
  const executePostSwapDeposit = (args: {
    senderId: string;
    toAsset: string;
    protocol: string;
    walletAddress: string;
    custodialAccountName?: string;
    conversationId: string;
  }) => _executePostSwapDeposit(ctx, args);

  async function handleInboundText(params: ImessageInboundParams): Promise<ImessageOutbound[]> {
    const {
      senderId,
      conversationId,
      dmConversationId = conversationId,
      isGroup = false,
      deliveryPhone,
      groupParticipants = [],
    } = params;
    let { text } = params;
    if (/^\s*(chirp|turn on wren\b.*)\s*$/i.test(text)) {
      const { captureConnectText } = await import("@/messaging/wrenConnect.js");
      const captured = await captureConnectText({
        senderId,
        text,
        channel: platform === "whatsapp" ? "whatsapp" : "imessage",
        service: platform === "whatsapp" ? null : "iMessage",
      });
      if (captured) {
        return [singleBubbleTextOutbound("You're on Wren. Stocks people send you land here.")];
      }
    }
    const outbound: ImessageOutbound[] = [];
    const tradeContext = {
      conversationId,
      isGroup,
      deliveryPhone,
      originSenderId: senderId,
    } satisfies Omit<TradeDeliveryContext, "copyTradeCtx">;
    let contactTransfer: ContactTransferNotification | undefined = params.resolvedContactTransfer;
    let pendingTransactionResponse: Extract<AIResponse, { type: "transaction" }> | undefined;
    // undefined = not asked yet, null = explicitly skipped, string = supplied.
    let transferMessageDecision: string | null | undefined;
    const selectedTransferMessage = (): string | undefined =>
      transferMessageDecision === undefined
        ? extractExplicitTransferMessage(text) ?? undefined
        : transferMessageDecision ?? undefined;
    const notifyProductMode = (mode: ImessageProductMode | undefined): void => {
      if (!mode || !options.onProductModeDetected) return;
      void Promise.resolve(
        options.onProductModeDetected({ senderId, conversationId, mode }),
      ).catch((err) => console.warn("⚠️ [iMessage] product mode callback failed:", err));
    };

    const guardrail = checkInboundContentGuardrails(text);
    if (guardrail) {
      outbound.push(guardrail.reply);
      return outbound;
    }

    let walletAddress = "";
    let custodialAccountName: string | undefined;
    const promptWalletSetup = async (): Promise<void> => {
      outbound.push(...(await connectBasemateAccount(senderId)));
    };
    try {
      await WalletAdapter.ensureProfile(senderId);
      // Register the sender in the Basemate user registry (fire-and-forget).
      void UserProfileAdapter.ensureProfile(senderId);
      // CDP Embedded Wallet is the only signing wallet.
      walletAddress = (await getConnectedWalletAddress(senderId)) ?? "";
    } catch (walletErr) {
      console.error("⚠️ [iMessage] wallet profile setup failed:", walletErr);
    }

    // Gate: if the user has no wallet set up yet, every message gets the
    // onboarding prompt — no intent routing, no LLM, no echoed text.
    if (!walletAddress && !isGroup) {
      const setupMessages = await connectBasemateAccount(senderId);
      outbound.push(...setupMessages);
      return outbound;
    }

    const flowKey = perpFlowKey(senderId, conversationId);
    const alertKey = pendingAlertKey(platform, senderId, conversationId);
    const linkPending = await stateGet<{ createdAt: number }>(K.pendingLink(senderId));
    if (linkPending && Date.now() - linkPending.createdAt > PENDING_TRADE_TTL_MS) {
      await stateDelete(K.pendingLink(senderId));
    }
    const pendingSwapDraft = await stateGet<PendingSwapDraft>(K.pendingSwapDraft(senderId));
    if (pendingSwapDraft && Date.now() - pendingSwapDraft.createdAt > PENDING_TRADE_TTL_MS) {
      await stateDelete(K.pendingSwapDraft(senderId));
    }
    const lastBalanceAsset = await stateGet<LastBalanceAssetMention>(K.lastBalanceAssetMention(senderId));
    if (lastBalanceAsset && Date.now() - lastBalanceAsset.createdAt > PENDING_TRADE_TTL_MS) {
      await stateDelete(K.lastBalanceAssetMention(senderId));
    }
    const pendingPerp = await stateGet<PendingPerpFlow>(K.pendingPerpFlow(flowKey));

    const copyTradeReply = await handleCopyTradeText(ctx, {
      senderId,
      conversationId,
      isGroup,
      deliveryPhone,
      text,
    });
    if (copyTradeReply) return copyTradeReply;

    const pendingSendMessage = await stateGet<PendingSendMessage>(K.pendingSendMessage(senderId));
    if (pendingSendMessage) {
      if (Date.now() - pendingSendMessage.createdAt > PENDING_TRADE_TTL_MS) {
        await stateDelete(K.pendingSendMessage(senderId));
        outbound.push("that send timed out — just ask again and i'll set it right back up 💙");
        return outbound;
      } else {
        const reply = text.trim();
        if (/^(?:cancel|nvm|nevermind|never mind|stop)$/i.test(reply)) {
          await stateDelete(K.pendingSendMessage(senderId));
          outbound.push("okay, cancelled that send.");
          return outbound;
        }
        await stateDelete(K.pendingSendMessage(senderId));
        transferMessageDecision = isTransferMessageSkip(reply)
          ? null
          : normalizeTransferMessage(reply);
        text = pendingSendMessage.originalText;
        contactTransfer = pendingSendMessage.contactTransfer;
        pendingTransactionResponse = pendingSendMessage.transaction;
      }
    }

    // Consume a pending ambiguous-send selection ("1"/"2") and re-drive the
    // send to the chosen contact. Placed before contact parsing so a bare "1"
    // isn't mistaken for a name/number reply.
    const pendingDisambig = await stateGet<{
      candidates: { name: string; phone: string | null }[];
      amount: string;
      asset: string;
      memo?: string;
      createdAt: number;
    }>(K.pendingSendDisambiguation(senderId));
    if (pendingDisambig) {
      if (Date.now() - pendingDisambig.createdAt > PENDING_TRADE_TTL_MS) {
        await stateDelete(K.pendingSendDisambiguation(senderId));
      } else {
        const reply = text.trim();
        if (/^(cancel|nvm|nevermind|never mind|stop|no)$/i.test(reply)) {
          await stateDelete(K.pendingSendDisambiguation(senderId));
          outbound.push("okay, cancelled that send.");
          return outbound;
        }
        const idx = parseChoiceIndex(reply);
        const chosen =
          idx != null && idx >= 0 && idx < pendingDisambig.candidates.length
            ? pendingDisambig.candidates[idx]
            : null;
        if (!chosen?.phone) {
          outbound.push(
            `reply with the number of who you meant (1–${pendingDisambig.candidates.length}), or "cancel".`,
          );
          return outbound;
        }
        await stateDelete(K.pendingSendDisambiguation(senderId));
        const { resolveSendTarget } = await import("./resolveSendTarget.js");
        const picked = await resolveSendTarget(senderId, { phone: chosen.phone });
        if (picked.kind === "wallet") {
          // Re-drive unambiguously by address — reuses the entire send path
          // (balance nudge, pay-mode confirm, execution) with no duplication.
          return handleInboundText({
            ...params,
            text:
              `send ${pendingDisambig.amount} ${pendingDisambig.asset} to ${picked.address}` +
              (pendingDisambig.memo ? ` with message ${pendingDisambig.memo}` : ""),
            resolvedContactTransfer: {
              recipientPhone: chosen.phone,
              amount: pendingDisambig.amount,
              asset: pendingDisambig.asset,
              ...(pendingDisambig.memo ? { memo: pendingDisambig.memo } : {}),
              ...(isSavableContactName(chosen.name)
                ? { autoSaveContact: { name: chosen.name, phone: chosen.phone } }
                : {}),
            },
          });
        }
        if (picked.kind === "claim_phone") {
          const token = await resolveTokenAsync(pendingDisambig.asset);
          if (!token.resolved || token.address === "ETH") {
            outbound.push(
              `sending to ${chosen.name} needs a token like USDC (not ETH) — they haven't linked a wallet yet.`,
            );
            return outbound;
          }
          const { isUsdSendAsset, resolveCorridorStable } = await import(
            "@/portfolio/corridorRouting.js"
          );
          const { buildCorridorSendCalls } = await import("@/portfolio/corridorSend.js");
          let escrow: PendingEscrowConfirm["escrow"] = {
            phone: picked.phone,
            contactName: chosen.name,
            amount: pendingDisambig.amount,
            tokenAddress: token.address,
            tokenSymbol: token.symbol,
            tokenDecimals: token.decimals,
            ...(pendingDisambig.memo ? { memo: pendingDisambig.memo } : {}),
          };
          let corridorFallbackNote: string | null = null;
          let corridorConfirmLine: string | null = null;
          if (isUsdSendAsset(pendingDisambig.asset)) {
            const corridor = resolveCorridorStable(picked.phone);
            if (corridor?.address) {
              const senderWalletAddress = await getConnectedWalletAddress(senderId);
              if (senderWalletAddress) {
                const routed = await buildCorridorSendCalls({
                  mode: "escrow",
                  usdcAmount: pendingDisambig.amount,
                  localStable: corridor,
                  senderAddress: senderWalletAddress,
                  phone: picked.phone,
                });
                if (!routed.fallback) {
                  escrow = {
                    ...escrow,
                    amount: routed.localAmount,
                    tokenAddress: corridor.address,
                    tokenSymbol: corridor.symbol,
                    tokenDecimals: corridor.decimals,
                    sourceUsdcAmount: pendingDisambig.amount,
                    quotedLocalAmount: routed.quotedLocalAmount,
                  };
                  corridorConfirmLine =
                    `i'll convert ${pendingDisambig.amount} USDC → ~${routed.quotedLocalAmount} ${corridor.symbol} ` +
                    `so ${chosen.name} can claim it at ${picked.phone}`;
                } else {
                  corridorFallbackNote =
                    `couldn't convert to ${corridor.symbol} right now — sending USDC instead. `;
                }
              }
            }
          }
          await stateSet(K.pendingEscrowConfirm(senderId), {
            escrow,
            createdAt: Date.now(),
            awaitingMessage: !pendingDisambig.memo,
            ...(isSavableContactName(chosen.name)
              ? { autoSaveContact: { name: chosen.name, phone: picked.phone } }
              : {}),
          });
          const basemateHint = picked.isOnBasemate
            ? `${chosen.name} is on Basemate — they'll get it the moment they link their wallet. `
            : `they'll get a text to claim it once they set up basemate. `;
          const sendLine =
            corridorConfirmLine ??
            `i'll send ${escrow.amount} ${escrow.tokenSymbol} so ${chosen.name} can claim it at ${picked.phone}`;
          outbound.push(
            pendingDisambig.memo
              ? `${corridorFallbackNote ?? ""}${sendLine} — ` +
                  `${basemateHint}\n\nreply YES to confirm, or NO to cancel.`
              : 'Would you like to add a message? Reply with a message, or "skip".',
          );
          return outbound;
        }
        outbound.push(`hmm, i couldn't set up a send to ${chosen.name} — try again.`);
        return outbound;
      }
    }

    // Save contacts typed in chat. Handled before intent classification so the
    // distinctive "Name: +number" / bare-number forms never get misrouted.
    // Verify-on-add: a typed contact isn't stored until the user confirms the
    // name + full number, so a fat-fingered digit never silently becomes the
    // wallet money later flows to. `proposeContactSave` stashes the pending
    // save and returns the confirm prompt.
    const proposeContactSave = async (name: string, phone: string): Promise<string> => {
      await stateSet(K.pendingContactConfirm(senderId), { name, phone, createdAt: Date.now() });
      return `save ${name} at ${formatPhoneDisplay(phone)}? reply YES to confirm, or NO to skip.`;
    };

    // (0) Awaiting a YES/NO on a proposed contact save.
    const pendingConfirm = await stateGet<{ name: string; phone: string; createdAt: number }>(
      K.pendingContactConfirm(senderId),
    );
    if (pendingConfirm) {
      if (Date.now() - pendingConfirm.createdAt > PENDING_TRADE_TTL_MS) {
        await stateDelete(K.pendingContactConfirm(senderId));
        // Don't block the current message — let it fall through to normal routing.
      } else {
        const reply = text.trim();
        if (/^(y|yes|yep|yeah|yup|confirm|correct|ok|okay|save|sure|do it|👍)$/i.test(reply)) {
          await stateDelete(K.pendingContactConfirm(senderId));
          outbound.push(
            await saveImessageContactFromChat(senderId, pendingConfirm.name, pendingConfirm.phone),
          );
          return outbound;
        }
        if (/^(n|no|nope|cancel|nvm|nevermind|never mind|stop|wrong|edit)$/i.test(reply)) {
          await stateDelete(K.pendingContactConfirm(senderId));
          outbound.push(
            'okay, didn\'t save that. send it again like "Alex: +1 415 555 0123" when you\'re ready.',
          );
          return outbound;
        }
        // Anything else (e.g. they re-typed a corrected "Name: +number"): drop
        // the stale proposal and fall through so the fresh parse re-proposes.
        await stateDelete(K.pendingContactConfirm(senderId));
      }
    }

    // (1) Awaiting a name for a number the user just shared or just paid.
    const pendingName = await stateGet<{
      phone: string;
      createdAt: number;
      source?: "autosave";
    }>(K.pendingContactName(senderId));
    if (pendingName) {
      if (Date.now() - pendingName.createdAt > PENDING_TRADE_TTL_MS) {
        await stateDelete(K.pendingContactName(senderId));
        // Don't block the current message — let it fall through to normal routing.
      } else {
        const reply = text.trim();
        if (/^(cancel|nvm|nevermind|never mind|stop|no)$/i.test(reply)) {
          await stateDelete(K.pendingContactName(senderId));
          outbound.push("okay, didn't save that contact.");
          return outbound;
        }
        // If they typed another save instead of a plain name, honor it: a full
        // "Name: +number" confirms; a different bare number re-targets.
        const asFresh = parseContactSaveText(reply);
        if (asFresh) {
          const freshPhone = normalizeContactPhone(asFresh.phoneRaw);
          if (!freshPhone) {
            outbound.push(
              "that number needs a country code — send it in full international format, like +63 917 123 4567.",
            );
            return outbound;
          }
          if (asFresh.name) {
            await stateDelete(K.pendingContactName(senderId));
            outbound.push(await proposeContactSave(asFresh.name, freshPhone));
            return outbound;
          }
          await stateSet(K.pendingContactName(senderId), { phone: freshPhone, createdAt: Date.now() });
          outbound.push(`got it — what name should i save ${formatPhoneDisplay(freshPhone)} under?`);
          return outbound;
        }
        await stateDelete(K.pendingContactName(senderId));
        // Auto-save after a completed send: the number already worked on-chain,
        // so skip the confirm and save straight away. Manual adds get the gate.
        if (pendingName.source === "autosave") {
          outbound.push(await saveImessageContactFromChat(senderId, reply, pendingName.phone));
        } else {
          outbound.push(await proposeContactSave(reply, pendingName.phone));
        }
        return outbound;
      }
    }

    // (2) A fresh contact-save message. Bare numbers are only intercepted when
    // no other prompt is awaiting a reply, so we don't hijack a numeric answer.
    const hasPendingInputFlow = await hasPendingInteraction({ senderId, conversationId });
    const contactSave = parseContactSaveText(text);
    if (contactSave && (contactSave.name !== undefined || !hasPendingInputFlow)) {
      const phone = normalizeContactPhone(contactSave.phoneRaw);
      if (!phone) {
        outbound.push(
          "that number needs a country code — send it in full international format, like +63 917 123 4567.",
        );
        return outbound;
      }
      if (contactSave.name) {
        outbound.push(await proposeContactSave(contactSave.name, phone));
        return outbound;
      }
      await stateSet(K.pendingContactName(senderId), { phone, createdAt: Date.now() });
      outbound.push(
        `give me a name to attach to this contact so we can add it to your contacts list — what should i call ${formatPhoneDisplay(phone)}?`,
      );
      return outbound;
    }

    // ── Onramp email setup commands ───────────────────────────────────────────
    const onrampCommand = text.trim();
    if (/^(?:add|set|update|change)\s+(?:my\s+)?email$/i.test(onrampCommand)) {
      notifyProductMode("money");
      await stateDelete(K.pendingEmailOtpVerification(senderId));
      await stateSet(K.pendingOnrampEmail(senderId), { createdAt: Date.now() });
      outbound.push(walletOnboardingEmailPrompt());
      return outbound;
    }

    if (/^(?:resend\s+(?:code|otp)|send\s+(?:code|otp)\s+again)$/i.test(onrampCommand)) {
      notifyProductMode("money");
      const existingPending = await stateGet<{ createdAt: number; pendingAmount?: string }>(K.pendingEmailOtpVerification(senderId));
      try {
        const result = await resendEmailOtp(senderId);
        if (result.ok) {
          await stateSet(K.pendingEmailOtpVerification(senderId), {
            createdAt: Date.now(),
            pendingAmount: existingPending?.pendingAmount,
          });
          outbound.push(`i sent a new verification code to ${result.email} — reply with the 6-digit code.`);
        } else if (result.reason === "already_verified") {
          await stateDelete(K.pendingEmailOtpVerification(senderId));
          outbound.push(`email is already verified ✓ — say "add funds" anytime to top up.`);
        } else {
          await stateSet(K.pendingOnrampEmail(senderId), { createdAt: Date.now(), pendingAmount: existingPending?.pendingAmount });
          outbound.push("i don't have an email to verify yet — reply with your email address:");
        }
      } catch (err) {
        console.error("⚠️ [onramp] email OTP resend failed:", err);
        outbound.push("couldn't resend the verification email — try again in a moment.");
      }
      return outbound;
    }

    // ── Onramp email collection ───────────────────────────────────────────────
    const onrampEmailPending = await stateGet<{ createdAt: number; pendingAmount?: string }>(K.pendingOnrampEmail(senderId));
    if (onrampEmailPending) {
      if (Date.now() - onrampEmailPending.createdAt > PENDING_OTP_TTL_MS) {
        await stateDelete(K.pendingOnrampEmail(senderId));
      } else {
        notifyProductMode("money");
        const reply = text.trim();
        if (/^(skip|cancel|nvm|nevermind|no)$/i.test(reply)) {
          await stateDelete(K.pendingOnrampEmail(senderId));
          outbound.push("ok — you can enable Apple Pay later by saying \"add email\".");
          return outbound;
        }
        if (!looksLikeEmail(reply)) {
          outbound.push("that doesn't look like a valid email — try again, or reply \"skip\".");
          return outbound;
        }
        const email = reply.toLowerCase();
        const pendingAmount = onrampEmailPending.pendingAmount;
        await stateDelete(K.pendingOnrampEmail(senderId));
        try {
          await issueEmailOtp(senderId, email);
          await stateSet(K.pendingEmailOtpVerification(senderId), { createdAt: Date.now(), pendingAmount });
          outbound.push(`i sent a verification code to ${email} — reply with the 6-digit code to confirm.`);
        } catch (err) {
          console.error("⚠️ [onramp] email OTP send failed:", err);
          outbound.push("couldn't send the verification email — try again in a moment.");
        }
        return outbound;
      }
    }

    // ── Email OTP verification ────────────────────────────────────────────────
    let emailOtpPending = await stateGet<{ createdAt: number; pendingAmount?: string }>(K.pendingEmailOtpVerification(senderId));
    if (!emailOtpPending && looksLikeOtp(text)) {
      const userData = await OnrampUserDataAdapter.get(senderId);
      if (userData?.email && !userData.emailVerifiedAt && userData.pendingEmailOtp) {
        emailOtpPending = { createdAt: Date.now() };
        await stateSet(K.pendingEmailOtpVerification(senderId), emailOtpPending);
      }
    }
    if (emailOtpPending) {
      if (Date.now() - emailOtpPending.createdAt > PENDING_OTP_TTL_MS) {
        await stateDelete(K.pendingEmailOtpVerification(senderId));
      } else {
        notifyProductMode("money");
        const reply = text.trim();
        if (/^(cancel|skip)$/i.test(reply)) {
          await stateDelete(K.pendingEmailOtpVerification(senderId));
          outbound.push("ok — email verification cancelled. you can try again by saying \"add email\".");
          return outbound;
        }
        if (!looksLikeOtp(reply)) {
          outbound.push("reply with the 6-digit code i sent to your email, or \"cancel\".");
          return outbound;
        }
        const verification = await verifyEmailOtp(senderId, reply);
        if (!verification.ok && verification.reason === "mismatch") {
          outbound.push("that code doesn't match — check the email and try again, or \"cancel\".");
          return outbound;
        }
        if (!verification.ok) {
          outbound.push("that code expired — say \"resend code\" and i'll send a new one.");
          return outbound;
        }
        const pendingAmountAfterEmail = emailOtpPending.pendingAmount;
        await stateDelete(K.pendingEmailOtpVerification(senderId));
        // If there was a pending fund amount, continue the flow automatically
        if (pendingAmountAfterEmail) {
          const fundingAddress = await getConnectedWalletAddress(senderId);
          if (!fundingAddress) {
            await promptWalletSetup();
            return outbound;
          }
          outbound.push("email verified ✓");
          outbound.push(...(await handleFundAmount(senderId, fundingAddress, pendingAmountAfterEmail)));
        } else {
          outbound.push(`email verified ✓ — Apple Pay is now enabled. say "add funds" anytime to top up.`);
        }
        return outbound;
      }
    }

    // ── Phone OTP verification (for onramp) ──────────────────────────────────
    const phoneOtpPending = await stateGet<{ code: string; createdAt: number; pendingAmount?: string }>(K.pendingPhoneOtpVerification(senderId));
    if (phoneOtpPending) {
      if (Date.now() - phoneOtpPending.createdAt > PENDING_OTP_TTL_MS) {
        await stateDelete(K.pendingPhoneOtpVerification(senderId));
      } else {
        notifyProductMode("money");
        const reply = text.trim();
        if (/^(cancel|skip)$/i.test(reply)) {
          await stateDelete(K.pendingPhoneOtpVerification(senderId));
          outbound.push("ok — verification cancelled.");
          return outbound;
        }
        if (!looksLikeOtp(reply)) {
          outbound.push("reply with the 6-digit code i sent, or \"cancel\".");
          return outbound;
        }
        if (reply !== phoneOtpPending.code) {
          outbound.push("that code doesn't match — try again or \"cancel\".");
          return outbound;
        }
        await stateDelete(K.pendingPhoneOtpVerification(senderId));
        await OnrampUserDataAdapter.upsert(senderId, {
          phoneVerifiedAt: new Date(),
          pendingPhoneOtp: null,
          pendingPhoneOtpExpiresAt: null,
        });
        // If there was a pending fund amount, continue immediately.
        if (phoneOtpPending.pendingAmount) {
          const fundingAddress = await getConnectedWalletAddress(senderId);
          if (!fundingAddress) {
            await promptWalletSetup();
            return outbound;
          }
          outbound.push(...(await handleFundAmount(senderId, fundingAddress, phoneOtpPending.pendingAmount)));
          return outbound;
        }
        outbound.push("phone verified ✓ — say \"add funds\" to top up with Apple Pay.");
        return outbound;
      }
    }

    // ── Pending fund amount selection ────────────────────────────────────────
    const fundAmountPending = await stateGet<{ createdAt: number }>(K.pendingFundAmount(senderId));
    if (fundAmountPending) {
      if (Date.now() - fundAmountPending.createdAt > PENDING_OTP_TTL_MS) {
        await stateDelete(K.pendingFundAmount(senderId));
      } else {
        notifyProductMode("money");
        const reply = text.trim();
        if (/^(cancel|nvm|nevermind)$/i.test(reply)) {
          await stateDelete(K.pendingFundAmount(senderId));
          outbound.push("ok — cancelled.");
          return outbound;
        }
        const parsed = parseNumberText(reply);
        const amount = parsed ?? undefined;
        if (!amount || Number(amount) <= 0) {
          // Not a dollar amount — drop pending state and handle as a new message.
          await stateDelete(K.pendingFundAmount(senderId));
        } else {
          await stateDelete(K.pendingFundAmount(senderId));
          const fundingAddress = await getConnectedWalletAddress(senderId);
          if (fundingAddress) {
            outbound.push(...(await handleFundAmount(senderId, fundingAddress, amount)));
          } else {
            await promptWalletSetup();
          }
          return outbound;
        }
      }
    }

    // ── Pending offramp amount selection ────────────────────────────────────
    const offrampAmountPending = await stateGet<{ createdAt: number }>(
      K.pendingOfframpAmount(senderId),
    );
    if (offrampAmountPending) {
      if (Date.now() - offrampAmountPending.createdAt > PENDING_OTP_TTL_MS) {
        await stateDelete(K.pendingOfframpAmount(senderId));
      } else {
        notifyProductMode("money");
        const reply = text.trim();
        if (/^(cancel|nvm|nevermind)$/i.test(reply)) {
          await stateDelete(K.pendingOfframpAmount(senderId));
          outbound.push("ok — cash out cancelled.");
          return outbound;
        }
        const amount = parseNumberText(reply) ?? undefined;
        if (!amount || Number(amount) <= 0) {
          outbound.push("reply with the USDC amount to cash out, like 25 or 50.");
          return outbound;
        }
        await stateDelete(K.pendingOfframpAmount(senderId));
        const sourceAddress = await getConnectedWalletAddress(senderId);
        if (!sourceAddress) {
          await promptWalletSetup();
          return outbound;
        }
        outbound.push(...(await handleOfframpIntent(senderId, sourceAddress, amount)));
        return outbound;
      }
    }

    // Route channel cash-outs before the classifier/LLM. The generic AI still
    // exposes a legacy custodial offramp tool for non-channel callers; allowing
    // a channel request to reach it can emit its text without the new opaque
    // wallet handoff.
    if (detectWalletIntent(text) === "offramp_to_fiat") {
      notifyProductMode("money");
      const sourceAddress = await getConnectedWalletAddress(senderId);
      if (!sourceAddress) {
        await promptWalletSetup();
        return outbound;
      }
      const amountMatch = text.match(/\$?\s*(\d+(?:\.\d{1,6})?)\s*(?:USDC|USD)?\b/i);
      const amount = amountMatch?.[1] ? sanitizeAmount(amountMatch[1]) : null;
      if (!amount || Number(amount) <= 0) {
        await stateSet(K.pendingOfframpAmount(senderId), { createdAt: Date.now() });
        outbound.push("how much USDC should i cash out? reply with an amount like 25 or 50.");
        return outbound;
      }
      outbound.push(...(await handleOfframpIntent(senderId, sourceAddress, amount)));
      return outbound;
    }

    // ── Fast-path: fund wallet intent ────────────────────────────────────────
    // Intercept clear "add funds" / "fund $X" phrases before hitting the AI to
    // avoid the AI misclassifying small amounts or returning a text response.
    const fundFastPath = isFundIntent(text);
    if (fundFastPath) {
      notifyProductMode("money");
      const fundingAddress = await getConnectedWalletAddress(senderId);
      if (!fundingAddress) {
        await promptWalletSetup();
        return outbound;
      }
      outbound.push(...(await handleFundAmount(senderId, fundingAddress, fundFastPath)));
      return outbound;
    }

    if (isEmptyPortfolioSummaryText(text)) {
      return outbound;
    }

    if (isBalanceFastPathIntent(text)) {
      const balanceAsset = extractBalanceAssetMention(text);
      if (balanceAsset) {
        await stateSet(K.lastBalanceAssetMention(senderId), {
          asset: balanceAsset,
          createdAt: Date.now(),
        });
      }
      const connectedWalletAddress = await getConnectedWalletAddress(senderId);
      if (!connectedWalletAddress) {
        await promptWalletSetup();
        return outbound;
      }
      const walletInfo = await mainWalletInfoText(senderId, connectedWalletAddress);
      if (!walletInfo) {
        await promptWalletSetup();
        return outbound;
      }
      outbound.push(...walletInfo);
      return outbound;
    }

    const intentContext: ImessageIntentContext = {
      pendingSweep: await stateHas(K.pendingSweep(senderId)),
      pendingPerpFlow: pendingPerp?.kind,
      pendingPriceAlert: await pendingAlerts.hasAsync(alertKey),
      pendingAccountLink: await stateHas(K.pendingLink(senderId)),
      pendingWorldCupMatch: await stateHas(K.pendingWorldCupMatch(senderId, conversationId)),
      pendingEscrowConfirm: await stateHas(K.pendingEscrowConfirm(senderId)),
      pendingFlashOrder: await stateHas(K.pendingFlashOrder(senderId)),
      pendingLaunch: await stateHas(K.pendingLaunch(launchFlowKey(conversationId, senderId))),
    };
    const intent = await intentEngine.classify(
      text,
      intentContext,
    );

    // No upfront name ask — users can stay private. Greetings/help flow straight
    // to the brain, which guides new users on what Basemate does and how to ask.

    notifyProductMode(
      productModeForIntentAction(intent.action) ??
        productModeForPendingState({
          pendingAmountChoice: await stateHas(K.pendingAmountChoice(senderId)),
          pendingPerp: Boolean(pendingPerp),
          pendingSwapDraft: Boolean(pendingSwapDraft),
          pendingYieldChoice: await stateHas(K.pendingYieldChoice(senderId)),
        }),
    );

    const worldCupIntentResponse = await handleWorldCupIntent(ctx, {
      senderId,
      conversationId,
      walletAddress,
      text,
      intent,
    });
    if (worldCupIntentResponse) {
      outbound.push(...worldCupIntentResponse);
      return outbound;
    }

    const avantisClose = await startAvantisCloseFromChat({
      senderId,
      text,
      intent,
      walletAddress,
    });
    if (avantisClose) {
      outbound.push(...avantisClose);
      return outbound;
    }

    // Set the Basemate (embedded) wallet as the signing preference at any time.
    if (intent.action === "choose_basemate_wallet") {
      outbound.push(...(await connectBasemateAccount(senderId)));
      return outbound;
    }

    // Embedded wallets are the only supported signing path.
    if (intent.action === "change_signing_wallet") {
      outbound.push("Basemate uses your embedded wallet to sign securely on basemate.app.");
      return outbound;
    }

    // Cross-platform account linking (connection-string handshake).
    if (await stateHas(K.pendingLink(senderId)) || intent.action === "account_link") {
      const linkResult = await handleAccountLinkCommand({
        platform,
        userKey: senderId,
        walletAddress: walletAddress || null,
        text,
        awaitingConnection: await stateHas(K.pendingLink(senderId)),
      });
      if (linkResult.clearPending) await stateDelete(K.pendingLink(senderId));
      if (linkResult.handled) {
        if (linkResult.setPending) await stateSet(K.pendingLink(senderId), { createdAt: Date.now() });
        outbound.push(stripMarkdown(linkResult.reply));
        return outbound;
      }
    }

    // Awaiting confirmation of the recipient's number before locking escrow.
    const pendingEscrow = await stateGet<PendingEscrowConfirm>(K.pendingEscrowConfirm(senderId));
    if (pendingEscrow) {
      if (Date.now() - pendingEscrow.createdAt > PENDING_TRADE_TTL_MS) {
        await stateDelete(K.pendingEscrowConfirm(senderId));
        outbound.push("that send expired — just ask again and i'll set it up.");
        return outbound;
      }
      if (pendingEscrow.awaitingMessage) {
        const reply = params.text.trim();
        if (/^(?:cancel|nvm|nevermind|never mind|stop)$/i.test(reply)) {
          await stateDelete(K.pendingEscrowConfirm(senderId));
          outbound.push("okay, cancelled — nothing was sent.");
          return outbound;
        }
        const memo = isTransferMessageSkip(reply) ? null : normalizeTransferMessage(reply);
        const nextPending: PendingEscrowConfirm = {
          ...pendingEscrow,
          escrow: {
            ...pendingEscrow.escrow,
            ...(memo ? { memo } : {}),
          },
          awaitingMessage: false,
        };
        await stateSet(K.pendingEscrowConfirm(senderId), nextPending);
        outbound.push(formatEscrowConfirmPrompt(nextPending.escrow));
        return outbound;
      }
      if (intent.action === "cancel") {
        await stateDelete(K.pendingEscrowConfirm(senderId));
        outbound.push("okay, cancelled — nothing was sent.");
        return outbound;
      }
      if (intent.action === "confirm") {
        await stateDelete(K.pendingEscrowConfirm(senderId));
        const senderWalletAddress = await getConnectedWalletAddress(senderId);
        if (!senderWalletAddress) {
          await promptWalletSetup();
          return outbound;
        }
        outbound.push(
          ...(await buildPhoneEscrowDepositLink({
            senderId,
            ...pendingEscrow.escrow,
            senderWalletAddress,
            ...(pendingEscrow.autoSaveContact
              ? { autoSaveContact: pendingEscrow.autoSaveContact }
              : {}),
          })),
        );
        return outbound;
      }
      outbound.push(formatEscrowConfirmPrompt(pendingEscrow.escrow));
      return outbound;
    }

    // Stock gift wizard (phone/pick → note → holdings YES or Apple Pay). Not escrow confirm.
    {
      const {
        continueGiftStockNote,
        continueGiftStockPick,
        continueGiftStockPhone,
        confirmGiftStock,
        formatGiftPayNudge,
        formatGiftHoldingsNudge,
        looksLikeGiftApplePay,
        retryOpenStockGift,
      } = await import("@/discovery/ai/tools/giftStock.handlers.js");
      type PendingGiftStock = import("@/discovery/ai/tools/giftStock.handlers.js").PendingGiftStock;
      if (/^retry(?:\s+gift)?$/i.test(text.trim())) {
        outbound.push(...(await retryOpenStockGift(senderId)));
        return outbound;
      }
      const pendingGift = await stateGet<PendingGiftStock>(K.pendingGiftStock(senderId));
      if (pendingGift) {
        if (Date.now() - pendingGift.createdAt > PENDING_TRADE_TTL_MS) {
          await stateDelete(K.pendingGiftStock(senderId));
          outbound.push("that gift expired — ask again and i'll re-quote.");
          return outbound;
        }
        if (intent.action === "cancel" || /^(?:cancel|nvm|nevermind|never mind|stop|no)$/i.test(text.trim())) {
          await stateDelete(K.pendingGiftStock(senderId));
          outbound.push("okay, cancelled — nothing was sent.");
          return outbound;
        }
        if (pendingGift.step === "pick") {
          const result = await continueGiftStockPick(platform, senderId, pendingGift, text);
          outbound.push(...result.messages);
          return outbound;
        }
        if (pendingGift.step === "phone") {
          const result = await continueGiftStockPhone(platform, senderId, pendingGift, text);
          outbound.push(...result.messages);
          return outbound;
        }
        if (pendingGift.step === "note") {
          const result = await continueGiftStockNote(platform, senderId, pendingGift, text);
          if (result.clear) await stateDelete(K.pendingGiftStock(senderId));
          outbound.push(...result.messages);
          return outbound;
        }
        if (pendingGift.step === "pay") {
          if (looksLikeGiftApplePay(text) || intent.action === "confirm") {
            const result = await confirmGiftStock(platform, senderId, pendingGift, {
              forceApplePay: true,
            });
            if (result.clear) await stateDelete(K.pendingGiftStock(senderId));
            outbound.push(...result.messages);
            return outbound;
          }
          outbound.push(formatGiftPayNudge(pendingGift));
          return outbound;
        }
        if (pendingGift.step === "confirm") {
          if (looksLikeGiftApplePay(text)) {
            const result = await confirmGiftStock(platform, senderId, pendingGift, {
              forceApplePay: true,
            });
            if (result.clear) await stateDelete(K.pendingGiftStock(senderId));
            outbound.push(...result.messages);
            return outbound;
          }
          if (intent.action === "confirm" || /^(?:yes|y|yeah|yep|confirm|send it|do it)$/i.test(text.trim())) {
            const result = await confirmGiftStock(platform, senderId, pendingGift);
            if (result.clear) await stateDelete(K.pendingGiftStock(senderId));
            outbound.push(...result.messages);
            return outbound;
          }
          outbound.push(formatGiftHoldingsNudge(pendingGift));
          return outbound;
        }
      }
    }

    const pendingSweep = await stateGet<PendingSweep>(K.pendingSweep(senderId));
    if (pendingSweep) {
      const isStale = Date.now() - pendingSweep.createdAt > PENDING_TRADE_TTL_MS;
      if (isStale) {
        await stateDelete(K.pendingSweep(senderId));
        outbound.push("that sweep confirmation expired — ask me to sweep again and i'll rebuild it.");
        return outbound;
      }
      if (intent.action === "confirm") {
        await stateDelete(K.pendingSweep(senderId));
        outbound.push(...(await executePendingSweep(pendingSweep)));
        return outbound;
      }
      if (intent.action === "cancel") {
        await stateDelete(K.pendingSweep(senderId));
        outbound.push("okay, cancelled — nothing was submitted.");
        return outbound;
      }
      outbound.push('reply "confirm" to run the sweep, or "cancel".');
      return outbound;
    }

    // Awaiting confirmation for a custodial withdrawal (withdraw_funds tool).
    const pendingWithdraw = await stateGet<PendingWithdraw>(K.pendingWithdraw(senderId));
    if (pendingWithdraw) {
      const isStale = Date.now() - pendingWithdraw.createdAt > PENDING_TRADE_TTL_MS;
      if (isStale) {
        await stateDelete(K.pendingWithdraw(senderId));
        outbound.push("that withdrawal expired — just ask again and i'll rebuild it.");
        return outbound;
      }
      if (intent.action === "confirm") {
        await stateDelete(K.pendingWithdraw(senderId));
        outbound.push(...(await executePendingWithdraw(pendingWithdraw)));
        return outbound;
      }
      if (intent.action === "cancel") {
        await stateDelete(K.pendingWithdraw(senderId));
        outbound.push("okay, cancelled — nothing was withdrawn.");
        return outbound;
      }
      outbound.push(`withdraw ${pendingWithdraw.label} — reply "confirm" to proceed or "cancel".`);
      return outbound;
    }

    // Awaiting confirmation for a Definitive Flash advanced order (limit/stop/TWAP).
    const pendingFlash = await stateGet<PendingFlashOrder>(K.pendingFlashOrder(senderId));
    if (pendingFlash) {
      const FLASH_CONFIRM_TTL_MS = 10 * 60 * 1000;
      if (Date.now() - pendingFlash.createdAt > FLASH_CONFIRM_TTL_MS) {
        await stateDelete(K.pendingFlashOrder(senderId));
        outbound.push("that order quote expired — ask me again and i'll re-quote.");
        return outbound;
      }
      const bare = text.trim().toLowerCase();
      const isConfirm =
        intent.action === "confirm" ||
        /^(confirm|yes|yep|yeah|yup|ok|okay)$/i.test(bare);
      const isCancel =
        intent.action === "cancel" ||
        /^(cancel|canecel|nope|stop|abort|nvm|no)$/i.test(bare);
      if (isConfirm) {
        outbound.push(...((await _executePendingFlashOrder(ctx, senderId)) ?? ["couldn't place that order."]));
        return outbound;
      }
      if (isCancel) {
        await _cancelPendingFlashOrder(ctx, senderId);
        outbound.push("okay, cancelled — nothing was placed.");
        return outbound;
      }
      outbound.push(`${pendingFlash.label}\n\nreply "confirm" to place it, or "cancel".`);
      return outbound;
    }

    const pendingYield = await stateGet<PendingYieldChoice>(K.pendingYieldChoice(senderId));
    if (pendingYield) {
      if (Date.now() - pendingYield.createdAt > PENDING_TRADE_TTL_MS) {
        await stateDelete(K.pendingYieldChoice(senderId));
      } else if (intent.action === "cancel") {
        await stateDelete(K.pendingYieldChoice(senderId));
        outbound.push("okay, cancelled.");
        return outbound;
      } else {
        const selectedIndex = parseChoiceIndex(text);
        if (selectedIndex !== null) {
          const option = pendingYield.options[selectedIndex];
          if (!option) {
            outbound.push(`reply with a number from 1 to ${pendingYield.options.length}, or "cancel".`);
            return outbound;
          }
          await stateDelete(K.pendingYieldChoice(senderId));
          outbound.push(
            ...(await respondToFollowup(
              senderId,
              conversationId,
              explicitYieldMessage(pendingYield, option),
              walletAddress,
              tradeContext,
            )),
          );
          return outbound;
        }
      }
    }

    const pendingAmount = await stateGet<PendingAmountChoice>(K.pendingAmountChoice(senderId));
    if (pendingAmount) {
      if (Date.now() - pendingAmount.createdAt > PENDING_TRADE_TTL_MS) {
        await stateDelete(K.pendingAmountChoice(senderId));
      } else if (intent.action === "cancel") {
        await stateDelete(K.pendingAmountChoice(senderId));
        outbound.push("okay, cancelled.");
        return outbound;
      } else {
        const selectedIndex = parsePresetChoiceIndex(text, pendingAmount.presetsUsd.length);
        if (selectedIndex !== null) {
          const usd = pendingAmount.presetsUsd[selectedIndex];
          if (usd !== undefined) {
            await stateDelete(K.pendingAmountChoice(senderId));
            outbound.push(
              ...(await respondToFollowup(
                senderId,
                conversationId,
                explicitPresetAmountMessage(pendingAmount, usd),
                walletAddress,
                tradeContext,
              )),
            );
            return outbound;
          }
        }
        const customUsd = parseCustomDepositAmountUsd(text);
        if (customUsd !== null) {
          await stateDelete(K.pendingAmountChoice(senderId));
          outbound.push(
            ...(await respondToFollowup(
              senderId,
              conversationId,
              explicitPresetAmountMessage(pendingAmount, customUsd),
              walletAddress,
              tradeContext,
            )),
          );
          return outbound;
        }
        // Handle "all", "max", "everything", "all MXNB" — resolve to actual on-chain balance.
        if (/^(all|max|everything|all\s+\w+)$/i.test(text.trim()) && walletAddress) {
          let resolvedAmount: string | undefined;
          try {
            const token = await resolveTokenAsync(pendingAmount.asset);
            if (token.resolved && token.address !== "ETH") {
              const balance = await fetchErc20TokenBalance(token.address, walletAddress, token.decimals);
              if (balance > 0) {
                resolvedAmount = String(parseFloat(balance.toPrecision(6)));
              }
            }
          } catch (err) {
            console.warn("⚠️ [iMessage] balance fetch for 'all' failed:", err);
          }
          if (resolvedAmount) {
            await stateDelete(K.pendingAmountChoice(senderId));
            const verb = pendingAmount.protocol === "moonwell" || pendingAmount.protocol === "aave" ? "supply" : "deposit";
            const depositMsg = `${verb} ${resolvedAmount} ${pendingAmount.asset} on ${pendingAmount.protocol}`;
            outbound.push(
              ...(await respondToFollowup(
                senderId,
                conversationId,
                depositMsg,
                walletAddress,
                tradeContext,
              )),
            );
            return outbound;
          }
        }
      }
    }

    const freshPendingSwapDraft = await stateGet<PendingSwapDraft>(K.pendingSwapDraft(senderId));
    if (freshPendingSwapDraft && hasFullBalancePhrase(text)) {
      await stateDelete(K.pendingSwapDraft(senderId));
      outbound.push(
        ...(await executeFullBalanceSwap({
          senderId,
          conversationId,
          text,
          draft: freshPendingSwapDraft,
          walletAddress,
          custodialAccountName,
          tradeContext,
        })),
      );
      return outbound;
    }

    if (pendingPerp) {
      const isStale = Date.now() - pendingPerp.createdAt > PENDING_PERP_TTL_MS;
      if (isStale) {
        await stateDelete(K.pendingPerpFlow(flowKey));
        outbound.push("that perp flow expired — ask again and i'll rebuild it.");
        return outbound;
      }

      if (intent.action === "cancel") {
        await stateDelete(K.pendingPerpFlow(flowKey));
        outbound.push("okay, cancelled — no perp was placed.");
        return outbound;
      }

      if (pendingPerp.kind === "setup_choice") {
        if (intent.action === "perp_setup_skip") {
          const tradeFlow: PendingPerpFlow = {
            ...pendingPerp,
            kind: "trade",
            state: pendingPerp.state,
          };
          outbound.push("okay — skipping saved defaults for this trade.");
          outbound.push(
            ...(await renderNextPerpStep(flowKey, tradeFlow, {
              senderId,
              walletAddress,
              custodialAccountName,
              tradeContext,
            })),
          );
          return outbound;
        }
        if (intent.action === "perp_setup_save") {
          await stateSet(K.pendingPerpFlow(flowKey), { ...pendingPerp, kind: "profile_tier" });
          outbound.push(tierPromptText());
          return outbound;
        }
        outbound.push('reply "skip" to trade now, or "setup" to save defaults first.');
        return outbound;
      }

      if (pendingPerp.kind === "profile_tier") {
        if (intent.action === "perp_setup_skip") {
          const tradeFlow: PendingPerpFlow = { ...pendingPerp, kind: "trade" };
          outbound.push("okay — skipping saved defaults for this trade.");
          outbound.push(
            ...(await renderNextPerpStep(flowKey, tradeFlow, {
              senderId,
              walletAddress,
              custodialAccountName,
              tradeContext,
            })),
          );
          return outbound;
        }
        if (intent.action !== "perp_tier_choice") {
          outbound.push('pick steady, tactical, aggressive, or basemaxxing — or reply "skip".');
          return outbound;
        }
        const tier = parseTier(text);
        if (!tier) {
          outbound.push('pick steady, tactical, aggressive, or basemaxxing — or reply "skip".');
          return outbound;
        }
        await stateSet(K.pendingPerpFlow(flowKey), {
          ...pendingPerp,
          kind: "profile_collateral",
          tier,
        });
        const leverage = resolveLeverageForTier(tier, 75);
        outbound.push(`default USDC margin per trade? reply with a dollar amount. avantis needs about $${Math.ceil(100 / leverage)}+ at ${leverage}x.`);
        return outbound;
      }

      if (pendingPerp.kind === "profile_collateral") {
        const amount = parseNumberText(text) ?? extractCollateralFromText(text);
        if (!pendingPerp.tier || !amount) {
          outbound.push("reply with your default USDC margin, like 25 or $50.");
          return outbound;
        }
        const saved = await mirrorImessagePerpProfile(senderId, conversationId, {
          risk_tier: pendingPerp.tier,
          default_collateral_usdc: amount,
        });
        if (!saved) {
          await stateDelete(K.pendingPerpFlow(flowKey));
          outbound.push("couldn't save your perp settings — try again in a sec.");
          return outbound;
        }
        await stateDelete(K.pendingPerpFlow(flowKey));
        outbound.push(`saved — ${pendingPerp.tier}, $${amount} USDC per trade. ask for the perp again and i'll use those defaults.`);
        return outbound;
      }

      let nextState = mergePerpState(pendingPerp.state, parsePerpIntent(text));
      if (!nextState.order && /\bmarket\b/i.test(text)) nextState.order = "market";
      if (!nextState.order && /\blimit\b|\bentry\b/i.test(text)) nextState.order = "limit";
      if (pendingPerp.state.order === "limit" && !pendingPerp.state.openPrice) {
        nextState.openPrice = nextState.openPrice ?? parseNumberText(text);
      }
      if (pendingPerp.state.tok && !pendingPerp.state.lev) {
        nextState.lev = nextState.lev ?? extractLeverageFromText(text);
      }
      if (pendingPerp.state.lev && !pendingPerp.state.coll) {
        nextState.coll = nextState.coll ?? parseNumberText(text) ?? extractCollateralFromText(text);
      }
      if (/\b(skip|no|none)\b/i.test(text) && !pendingPerp.state.tpsl) {
        nextState.tpsl = "skip";
      }
      const hasTpslPrice = Boolean(nextState.tp || nextState.sl);
      if (hasTpslPrice) nextState.tpsl = "set";

      outbound.push(
        ...(await renderNextPerpStep(
          flowKey,
          { ...pendingPerp, kind: "trade", state: nextState },
          { senderId, walletAddress, custodialAccountName, tradeContext },
        )),
      );
      return outbound;
    }

    if (intent.action === "main_wallet_fund") {
      notifyProductMode("money");
      const connectedWalletAddress = await getConnectedWalletAddress(senderId);
      if (!connectedWalletAddress) {
        await promptWalletSetup();
        return outbound;
      }
      const amountEntry = intent.amounts[0];
      const amount =
        amountEntry?.amountUsd != null
          ? String(amountEntry.amountUsd)
          : amountEntry?.amount
            ? sanitizeAmount(amountEntry.amount) ?? "0"
            : "0";
      outbound.push(...(await handleFundAmount(senderId, connectedWalletAddress, amount)));
      return outbound;
    }

    if (intent.action === "main_wallet_balance") {
      const balanceAsset = extractBalanceAssetMention(text);
      if (balanceAsset) {
        await stateSet(K.lastBalanceAssetMention(senderId), {
          asset: balanceAsset,
          createdAt: Date.now(),
        });
      }
      const connectedWalletAddress = await getConnectedWalletAddress(senderId);
      if (!connectedWalletAddress) {
        await promptWalletSetup();
        return outbound;
      }
      const walletInfo = await mainWalletInfoText(senderId, connectedWalletAddress);
      if (!walletInfo) {
        await promptWalletSetup();
        return outbound;
      }
      outbound.push(...walletInfo);
      return outbound;
    }

    if (intent.action === "main_wallet_offramp") {
      notifyProductMode("money");
      const connectedWalletAddress = await getConnectedWalletAddress(senderId);
      if (!connectedWalletAddress) {
        await promptWalletSetup();
        return outbound;
      }
      const amountCandidate =
        intent.amounts.find((entry) => entry.asset?.toUpperCase() === "USDC")?.amount ??
        intent.amounts[0]?.amount;
      const amount = amountCandidate ? sanitizeAmount(amountCandidate) : null;
      if (!amount || Number(amount) <= 0) {
        await stateSet(K.pendingOfframpAmount(senderId), { createdAt: Date.now() });
        outbound.push("how much USDC should i cash out? reply with an amount like 25 or 50.");
        return outbound;
      }
      outbound.push(...(await handleOfframpIntent(senderId, connectedWalletAddress, amount)));
      return outbound;
    }

    const profile = await getImessagePerpProfile(senderId, conversationId);
    if (PerpProfileAdapter.isComplete(profile)) {
      await ensureSenderPerpProfile(senderId, profile);
    }

    if (intent.action === "perp_trade" && PerpProfileAdapter.isComplete(profile)) {
      const directPerpState = parsePerpIntent(text);
      if (directPerpState.dir && directPerpState.tok) {
        const state = await applyProfileDefaults(directPerpState, senderId, conversationId);
        outbound.push(
          ...(await renderNextPerpStep(
            flowKey,
            { kind: "trade", state, originalText: text, createdAt: Date.now() },
            { senderId, walletAddress, custodialAccountName, tradeContext },
          )),
        );
        return outbound;
      }
    }

    // One-time price alerts. Group-created alerts are confirmed in the group,
    // but future alert delivery stays private to the user's DM.
    const alertCore = {
      platform,
      userKey: senderId,
      dmTarget: dmTargetForConversation(dmConversationId),
      sourceConversationId: conversationId,
      sourceIsGroup: isGroup,
    };
    const pendingAlert = await pendingAlerts.getAsync(alertKey);

    // Follow-up: finish a pending (ambiguous) alert once the user replies with a
    // contract address like "0x… this one".
    if (pendingAlert) {
      const address = extractContractAddress(text);
      if (intent.action === "price_alert_followup" && address) {
        const result = await createAlertFromIntent(alertCore, {
          ...pendingAlert,
          contractAddress: address,
          tokenQuery: address,
        });
        rememberPendingAlert(alertKey, pendingAlert, result);
        outbound.push(stripMarkdown(replyFromResult(result)));
        return outbound;
      }
      if (intent.action === "cancel") {
        pendingAlerts.delete(alertKey);
        outbound.push("okay, cancelled. no alert was set.");
        return outbound;
      }
    }

    // Token launches moved to the standalone iStonks project.
    if (intent.action === "bankr_launch") {
      outbound.push(
        "token launches moved to iStonks — text that line or open basemate.app/istonks/launch",
      );
      return outbound;
    }

    if (!shouldRouteToGeneralAi(intent.action)) {
      if (looksLikeGiftStockAsk(text)) {
        outbound.push(giftStockHint());
        return outbound;
      }
      outbound.push("hmm not sure i caught that — what are you trying to do?");
      return outbound;
    }

    // B20 stock gifts must not fall into the phone-USDC claim path.
    // "Send $2 of Apple stock to Joe Shmoe" classifies as send_token with
    // no parsed amount (next token is "of"), so the claim handler asks for USDC.
    const stockGift = parseGiftStock(text);
    if (stockGift) {
      const { gift_stock } = await import("@/discovery/ai/tools/giftStock.handlers.js");
      const result = await gift_stock(
        {
          inboxId: senderId,
          walletAddress,
          conversationId,
          userMessage: text,
          copyPlatform: platform,
        },
        stockGift,
      );
      if (result.control?.type === "text" && result.control.text) {
        outbound.push(result.control.text);
      } else {
        outbound.push("couldn't start that stock gift — try again in a sec");
      }
      return outbound;
    }
    if (looksLikeGiftStockAsk(text)) {
      outbound.push(giftStockHint());
      return outbound;
    }

    // Contact resolution via the unified resolver (owner-scoped; wallets join).
    // Groups prefer tag + Spectrum participants before the contact-book-only path.
    if (intent.action === "send_token" && !intent.targetAddress) {
      const { extractPrimaryPersonTag } = await import("./utils/groupTag.utils.js");
      const recipientName =
        intent.targetName ??
        extractPrimaryPersonTag(stripExplicitTransferMessage(text)) ??
        extractRecipientName(stripExplicitTransferMessage(text));
      if (recipientName) {
        const { resolveSendTarget, resolveTaggedGroupRecipient } = await import(
          "./resolveSendTarget.js"
        );
        const target = isGroup
            ? await resolveTaggedGroupRecipient(senderId, recipientName, groupParticipants)
            : await resolveSendTarget(senderId, { name: recipientName });

        if (target.kind === "ambiguous") {
          const numbered = target.candidates
            .map((c, i) => `${i + 1}. ${c.name}${c.phone ? ` (${formatPhoneDisplay(c.phone)})` : ""}`)
            .join("\n");
          const amt = intent.amounts[0];
          const amount = amt?.amount ? sanitizeAmount(amt.amount) ?? amt.amount : null;
          const asset = amt?.asset ? amt.asset.toUpperCase() : null;
          if (amount && asset) {
            // Stash the parsed send so a "1"/"2" reply can complete it without
            // re-typing. Consumed at the top of the next message.
            await stateSet(K.pendingSendDisambiguation(senderId), {
              candidates: target.candidates,
              amount,
              asset,
              ...(selectedTransferMessage() ? { memo: selectedTransferMessage() } : {}),
              createdAt: Date.now(),
            });
            outbound.push(
              `a couple of your contacts match "${recipientName}":\n${numbered}\n\n` +
                `reply 1 or 2 and i'll send ${amount} ${asset}.`,
            );
          } else {
            outbound.push(
              `i found a few contacts that match "${recipientName}":\n${numbered}\n\nwhich one did you mean?`,
            );
          }
          return outbound;
        }

        if (target.kind === "unknown") {
          // Only full ENS/Basenames (.eth / .base.eth) continue to on-chain
          // resolution. Bare labels like "mom" are contacts — never guess a suffix.
          const isEnsOrBasename = /\.(base\.)?eth$/i.test(recipientName);
          if (!isEnsOrBasename) {
            outbound.push(
              isGroup
                ? `i don't recognize "${recipientName}" in this group yet. ` +
                    `@mention them from your iMessage contacts, or share their contact card once, ` +
                    `and i'll be able to send to them.`
                : `i don't have "${recipientName}" saved in your contacts. ` +
                    `share their contact card once and i'll be able to send to them.`,
            );
            return outbound;
          }
          console.log(`👤 [iMessage] contact "${recipientName}" not found; trying normal send recipient resolution`);
        } else if (target.kind === "wallet") {
          // Carry structured transfer metadata into the durable approval row so
          // the receipt poller can notify the recipient only after on-chain success.
          const recipientPhone = target.phone ?? null;
          if (recipientPhone) {
            const amt = intent.amounts[0];
            if (amt?.amount && amt.asset) {
              // Auto-save on every successful send-to-phone that carried a real
              // recipient name (group tag *or* DM) — not just group tags — so the
              // next send can use the name. The save fires only on on-chain
              // success and no-ops if the phone is already saved.
              const saveName = target.name ?? recipientName;
              contactTransfer = {
                recipientPhone,
                amount: sanitizeAmount(amt.amount) ?? amt.amount,
                asset: amt.asset.toUpperCase(),
                ...(selectedTransferMessage() ? { memo: selectedTransferMessage() } : {}),
                ...(isSavableContactName(saveName)
                  ? { autoSaveContact: { name: saveName, phone: recipientPhone } }
                  : {}),
              };
            }
          }

          // Keep the human contact name in the message. Rewriting to 0x made
          // confirms show a wallet address depending on phrasing — max abstraction
          // means the AI resolves the name via contacts and labels use phone/name.
        } else if (target.kind === "claim_phone") {
          const contactPhone = target.phone;
          const amt = intent.amounts[0];
          const requestedAsset = amt?.asset?.trim() || "USDC";
          const asset = requestedAsset.startsWith("0x")
            ? requestedAsset
            : requestedAsset.toUpperCase();
          const amount = amt?.amount ? sanitizeAmount(amt.amount) : null;
          if (!amount || Number(amount) <= 0) {
            outbound.push(
              `how much ${asset} should i send for ${recipientName} to claim? ` +
                `try "send 10 ${asset} to ${recipientName}".`,
            );
            return outbound;
          }

          const token = await resolveTokenAsync(asset);
          if (!token.resolved) {
            outbound.push(
              `i couldn't find ${asset} as a token on Base. use a known token symbol or its contract address.`,
            );
            return outbound;
          }
          if (token.address === "ETH") {
            outbound.push(
              `sending to a phone works with tokens like USDC, not ETH. ` +
                `ask ${recipientName} to connect their Basemate wallet so you can send ETH directly.`,
            );
            return outbound;
          }

          const { isUsdSendAsset, resolveCorridorStable } = await import(
            "@/portfolio/corridorRouting.js"
          );
          const { buildCorridorSendCalls } = await import("@/portfolio/corridorSend.js");

          let escrow: PendingEscrowConfirm["escrow"] = {
            phone: contactPhone,
            contactName: recipientName,
            amount,
            tokenAddress: token.address,
            tokenSymbol: token.symbol,
            tokenDecimals: token.decimals,
            ...(selectedTransferMessage() ? { memo: selectedTransferMessage() } : {}),
          };
          let corridorFallbackNote: string | null = null;
          let corridorConfirmLine: string | null = null;

          if (isUsdSendAsset(asset)) {
            const corridor = resolveCorridorStable(contactPhone);
            if (corridor?.address) {
              const senderWalletAddress = await getConnectedWalletAddress(senderId);
              if (senderWalletAddress) {
                const routed = await buildCorridorSendCalls({
                  mode: "escrow",
                  usdcAmount: amount,
                  localStable: corridor,
                  senderAddress: senderWalletAddress,
                  phone: contactPhone,
                });
                if (!routed.fallback) {
                  escrow = {
                    ...escrow,
                    amount: routed.localAmount,
                    tokenAddress: corridor.address,
                    tokenSymbol: corridor.symbol,
                    tokenDecimals: corridor.decimals,
                    sourceUsdcAmount: amount,
                    quotedLocalAmount: routed.quotedLocalAmount,
                  };
                  corridorConfirmLine =
                    `i'll convert ${amount} USDC → ~${routed.quotedLocalAmount} ${corridor.symbol} ` +
                    `so ${recipientName} can claim it at ${contactPhone}`;
                } else {
                  corridorFallbackNote =
                    `couldn't convert to ${corridor.symbol} right now — sending USDC instead. `;
                }
              }
            }
          }

          // Confirm the resolved E.164 number before locking any funds. An
          // inferred or wrong country code would strand the escrow (the deposit
          // hash would never match the recipient's real iMessage handle), so the
          // sender must verify the exact number they're sending to first.
          await stateSet(K.pendingEscrowConfirm(senderId), {
            escrow,
            createdAt: Date.now(),
            awaitingMessage: transferMessageDecision === undefined && !selectedTransferMessage(),
            ...(isSavableContactName(recipientName)
              ? { autoSaveContact: { name: recipientName, phone: contactPhone } }
              : {}),
          });
          const basemateHint = target.isOnBasemate
            ? `${recipientName} is on Basemate — they'll get it the moment they link their wallet. `
            : `they'll get a text to claim it once they set up basemate. `;
          const sendLine =
            corridorConfirmLine ??
            `i'll send ${escrow.amount} ${escrow.tokenSymbol} so ${recipientName} can claim it at ${contactPhone}`;
          outbound.push(
            transferMessageDecision === undefined && !selectedTransferMessage()
              ? 'Would you like to add a message? Reply with a message, or "skip".'
              : `${corridorFallbackNote ?? ""}${sendLine} — ` +
                  `${basemateHint}\n\nreply YES to confirm, or NO to cancel.`,
          );
          return outbound;
        }
      }
    }

    const fallbackBalanceAsset = (await stateGet<LastBalanceAssetMention>(K.lastBalanceAssetMention(senderId)))?.asset;
    const fullBalanceDraft = intent.action === "swap" && hasFullBalancePhrase(text)
      ? parseSwapDraft(text, fallbackBalanceAsset)
      : null;
    if (fullBalanceDraft) {
      const compound = detectCompoundSwapDeposit(text);
      if (compound) {
        await stateSet(K.pendingPostTxAction(senderId), {
          toAsset: compound.toAsset,
          protocol: compound.protocol,
          conversationId,
        });
        console.log(`🔗 [iMessage] Compound intent: swap → ${compound.toAsset}, then ${compound.protocol}`);
      }
      outbound.push(
        ...(await executeFullBalanceSwap({
          senderId,
          conversationId,
          text,
          draft: fullBalanceDraft,
          walletAddress,
          custodialAccountName,
          tradeContext,
        })),
      );
      return outbound;
    }

    if (requiresWalletBeforeGeneralAi(intent.action)) {
      const connectedWalletAddress = await getConnectedWalletAddress(senderId);
      if (!connectedWalletAddress) {
        await promptWalletSetup();
        return outbound;
      }
    }

    const swapDraft = intent.action === "swap" ? parseSwapDraft(text, fallbackBalanceAsset) : null;
    const linkedWallets = await resolveAllWalletsForUser(platform, senderId, walletAddress);
    const resp = pendingTransactionResponse ?? await ai.respond(text, {
        inboxId: senderId,
        walletAddress,
        linkedWallets,
        custodialWallet: false,
        conversationId,
        userMessage: text,
        disableDeterministicRouting: false,
        copyPlatform: platform,
        copyUserKey: senderId,
        positionsChannel: platform,
        intentAction: intent.action,
        intentTargetName: intent.targetName,
        intentAsset: intent.assets[0] ?? intent.amounts[0]?.asset ?? null,
        intentAmount: intent.amounts[0]?.amountUsd ?? intent.amounts[0]?.amount ?? null,
      });

    console.log(`🤖 ${logPrefix} AIResponse type=${resp.type}`);
    if (isEmptyPortfolioSummaryResponse(resp)) {
      const connectedWalletAddress = await getConnectedWalletAddress(senderId);
      if (!connectedWalletAddress) {
        await promptWalletSetup();
        return outbound;
      }
    }
    if (swapDraft && isAmountPromptResponse(resp)) {
      await stateSet(K.pendingSwapDraft(senderId), swapDraft);
    }

    if (resp.type === "perp_setup_redirect") {
      await stateSet(K.pendingPerpFlow(flowKey), {
        kind: "setup_choice",
        state: parsePerpIntent(text),
        originalText: text,
        createdAt: Date.now(),
      });
      outbound.push(setupChoiceText(resp.text));
      return outbound;
    }

    if (resp.type === "perp_guide") {
      const state = mergePerpState(parsePerpIntent(text), resp.state);
      outbound.push(stripMarkdown(resp.text));
      outbound.push(
        ...(await renderNextPerpStep(
          flowKey,
          { kind: "trade", state, originalText: text, createdAt: Date.now() },
          { senderId, walletAddress, custodialAccountName, tradeContext },
        )),
      );
      return outbound;
    }

    if (resp.type === "launch_guide") {
      outbound.push(
        "token launches moved to iStonks — text that line or open basemate.app/istonks/launch",
      );
      return outbound;
    }

    if (resp.type === "flash_order") {
      outbound.push(
        ...(await routeFlashOrderResponse({
          senderId,
          conversationId,
          resp,
        })),
      );
      return outbound;
    }

    if (resp.type === "transaction") {
      // Detect compound swap+deposit intent and store follow-up action for after confirmation.
      const compound = detectCompoundSwapDeposit(text);
      if (compound) {
        await stateSet(K.pendingPostTxAction(senderId), {
          toAsset: compound.toAsset,
          protocol: compound.protocol,
          conversationId,
        });
        console.log(`🔗 [iMessage] Compound intent: swap → ${compound.toAsset}, then ${compound.protocol}`);
      }
      // For sends to a saved contact, show the contact's name (+ phone) in the
      // approval label instead of a raw/shortened 0x address. The handler rewrote
      // the recipient to an address before the AI ran, so substitute it back.
      // Look the contact up by the phone captured in contactTransfer (always set
      // on the contact-send path) rather than intent.targetName, which is null
      // when the name came from extractRecipientName rather than the classifier.
      // Prefer the deterministic contactTransfer; otherwise fall back to one the
      // LLM send path attached when it resolved the recipient from a saved
      // contact (recipient-first phrasing, slang verbs, etc.). Either way the
      // recipient gets a text once the transfer confirms.
      let effectiveContactTransfer = contactTransfer
        ? {
            ...contactTransfer,
            ...(resp.contactTransfer?.memo ? { memo: resp.contactTransfer.memo } : {}),
          }
        : resp.contactTransfer;
      const selectedMemo = selectedTransferMessage();
      if (
        effectiveContactTransfer?.recipientPhone &&
        transferMessageDecision === undefined &&
        !selectedMemo &&
        !effectiveContactTransfer.memo
      ) {
        await stateSet(K.pendingSendMessage(senderId), {
          originalText: text,
          contactTransfer: effectiveContactTransfer,
          transaction: resp,
          createdAt: Date.now(),
        } satisfies PendingSendMessage);
        outbound.push('Would you like to add a message? Reply with a message, or "skip".');
        return outbound;
      }
      if (effectiveContactTransfer) {
        const { memo: existingMemo, ...transferWithoutMemo } = effectiveContactTransfer;
        const memo = transferMessageDecision === null
          ? undefined
          : selectedMemo ?? existingMemo;
        effectiveContactTransfer = memo
          ? { ...transferWithoutMemo, memo }
          : transferWithoutMemo;
      }
      let txResp = resp;
      if (effectiveContactTransfer?.recipientPhone) {
        const contact = await ContactsAdapter.findByPhone(
          senderId,
          effectiveContactTransfer.recipientPhone,
        );
        const { formatContactSendDisplay } = await import(
          "@/messaging/utils/sendDisplay.utils.js"
        );
        const displayName = formatContactSendDisplay({
          name: contact?.name ?? intent.targetName,
          phone: effectiveContactTransfer.recipientPhone,
          fallback: effectiveContactTransfer.recipientPhone,
        });
        // Match a full or shortened address ("0x2113…163c" / "0x1234...abcd"),
        // tolerating either an ellipsis char or literal dots. Also replace a
        // bare contact name that somehow got an address-only label.
        txResp = {
          ...resp,
          text: resp.text
            .replace(
              /\bto 0x[0-9a-fA-F]{2,}(?:[.\u2026]+[0-9a-fA-F]{2,})?/i,
              `to ${displayName}`,
            )
            .replace(
              new RegExp(
                `\\bto ${effectiveContactTransfer.recipientPhone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
                "i",
              ),
              `to ${displayName}`,
            ),
        };
      }
      if (
        effectiveContactTransfer?.memo &&
        !txResp.text.toLowerCase().includes(effectiveContactTransfer.memo.toLowerCase())
      ) {
        txResp = { ...txResp, text: `${txResp.text} — ${effectiveContactTransfer.memo}` };
      }
      outbound.push(
        ...(await routeTransactionResponse({
          senderId,
          conversationId,
          originalText: text,
          resp: txResp,
          isGroup,
          deliveryPhone,
          contactTransfer: effectiveContactTransfer,
        })),
      );

      return outbound;
    }

    // Custodial withdrawal confirmation flow — store the pending state so the user
    // can review and reply "confirm" before we execute the on-chain transfer.
    if (resp.type === "withdraw_preview") {
      await stateSet(K.pendingWithdraw(senderId), {
        to: resp.to,
        amount: resp.amount,
        asset: resp.asset,
        label: resp.label,
        accountName: resp.accountName,
        createdAt: Date.now(),
      });
      outbound.push(resp.text);
      return outbound;
    }

    if (resp.type === "disambiguate") {
      await stateSet(K.pendingYieldChoice(senderId), {
        token: resp.token,
        amountToken: resp.amountToken,
        options: resp.options,
        createdAt: Date.now(),
      });
      await stateDelete(K.pendingAmountChoice(senderId));
      outbound.push(...renderAIResponseText(resp));
      return outbound;
    }

    if (resp.type === "amount_select") {
      await stateSet(K.pendingAmountChoice(senderId), {
        asset: resp.asset,
        protocol: resp.protocol,
        presetsUsd: resp.presetsUsd,
        createdAt: Date.now(),
      });
      await stateDelete(K.pendingYieldChoice(senderId));
      outbound.push(...renderAIResponseText(resp));
      return outbound;
    }

    await stateDelete(K.pendingYieldChoice(senderId));
    await stateDelete(K.pendingAmountChoice(senderId));

    const worldCupAiResponse = await handleWorldCupAiResponse(ctx, {
      senderId,
      conversationId,
      walletAddress,
      text,
      resp,
    });
    if (worldCupAiResponse) {
      outbound.push(...worldCupAiResponse);
      return outbound;
    }

    // Intercept the old hosted-widget onramp_link response and replace it with
    // the headless Apple Pay flow. The AI still classifies and routes fund
    // intents, but we always redirect the result to our /pay page.
    if (resp.type === "onramp_link") {
      const fundingAddress = await getConnectedWalletAddress(senderId);
      if (!fundingAddress) {
        await promptWalletSetup();
        return outbound;
      }
      const amountMatch = text.match(/\$\s*([0-9][\d,]*(?:\.\d+)?)/) ??
        text.match(/\b([0-9][\d,]*(?:\.\d+)?)\s*(?:dollars?|usd|usdc)?\b/i);
      const amount = amountMatch
        ? (sanitizeAmount(amountMatch[1].replace(/,/g, "")) ?? undefined)
        : undefined;
      outbound.push(...(await handleFundAmount(senderId, fundingAddress, amount ?? "25")));
      return outbound;
    }

    outbound.push(...renderAIResponseText(resp));
    return outbound;
  }

  /**
   * Handle an inbound vCard contact shared by the user.
   * Saves the contact to the sender's contact book and confirms with a reply.
   */
  async function handleInboundContact({
    senderId,
    name,
    phone,
  }: {
    senderId: string;
    name?: string;
    phone?: string;
  }): Promise<string> {
    if (!name && !phone) {
      return "that contact card didn't include a name or phone number — try again";
    }
    // Strict: a shared number must include a country code. We never infer one —
    // a wrong guess would strand escrowed funds against an unreachable phone
    // hash — so reject a country-code-less number up front instead of saving a
    // contact that silently can't receive money. The number is stored in the
    // exact E.164 form the recipient's inbound iMessage handle arrives in, so
    // resolveWallet / escrow release key on the same handle they reuse.
    let storedPhone: string | undefined;
    if (phone) {
      const normalized = ContactsAdapter.normalizeHandle(phone);
      if (!normalized) {
        const who = name ? name : "them";
        const example = name ?? "Xen";
        return (
          `i can't save that number for ${who} — it's missing a country code. ` +
          `text it to me in full international format, like "${example}: +1 818 860 8766".`
        );
      }
      storedPhone = normalized;
    }
    try {
      await ContactsAdapter.saveContact(senderId, name ?? storedPhone!, storedPhone);
    } catch (err) {
      console.error("⚠️ [iMessage] failed to save contact:", err);
      return "hmm, something went wrong saving that contact — try sharing it again";
    }
    const label = name ? `${name}${storedPhone ? ` (${storedPhone})` : ""}` : storedPhone!;
    return `saved ${label} — next time say "send 10 USDC to ${name ?? storedPhone}" and i'll use this contact`;
  }

  return { handleInboundText, handleInboundContact, hasPendingInteraction };
}
