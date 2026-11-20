import type { DiscoveryAI } from "@/discovery/ai.js";
import type { MessagingPlatform } from "./handler.types.js";
import type { ImessageIntentEngine } from "./intentEngine.js";

export type MessagingKeys = {
  pendingTrade:                (s: string) => string;
  pendingPerpFlow:             (k: string) => string;
  pendingSweep:                (s: string) => string;
  pendingYieldChoice:          (s: string) => string;
  pendingAmountChoice:         (s: string) => string;
  pendingSwapDraft:            (s: string) => string;
  lastBalanceAssetMention:     (s: string) => string;
  pendingContactName:          (s: string) => string;
  pendingContactConfirm:       (s: string) => string;
  pendingSendDisambiguation:   (s: string) => string;
  pendingSendMessage:          (s: string) => string;
  pendingDisplayName:          (s: string) => string;
  pendingLink:                 (s: string) => string;
  pendingPostTxAction:         (s: string) => string;
  pendingOnrampEmail:          (s: string) => string;
  pendingEmailOtpVerification: (s: string) => string;
  pendingPhoneOtpVerification: (s: string) => string;
  pendingFundAmount:           (s: string) => string;
  pendingOfframpAmount:        (s: string) => string;
  pendingWorldCupMatch:        (s: string, cid?: string) => string;
  pendingEscrowConfirm:        (s: string) => string;
  pendingGiftStock:            (s: string) => string;
  pendingFlashOrder:           (s: string) => string;
  pendingGroupCopyTrade:       (conversationId: string) => string;
  pendingCopyTradeAmount:      (scopeId: string) => string;
  /** Keyed by launchFlowKey(conversationId, senderId). */
  pendingLaunch:               (k: string) => string;
};

export interface HandlerCtx {
  platform: MessagingPlatform;
  logPrefix: string;
  platformLabel: string;
  K: MessagingKeys;
  ai: DiscoveryAI;
  intentEngine: ImessageIntentEngine;
  dmTargetForConversation: (dmConversationId: string) => Record<string, unknown>;
}
