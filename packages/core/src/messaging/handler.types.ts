import type { WalletCall } from "@basemate/shared";

import type { AIResponse } from "@/discovery/ai.js";
import type { CopyTradeCtxPayload } from "@/discovery/ai/types.js";
import type { ImessageProductMode } from "@/messaging/productMode.js";
import type { GroupParticipant } from "@/messaging/utils/groupTag.utils.js";

type AvantisOrderType = "market" | "limit";
type PerpRiskTier = "steady" | "tactical" | "aggressive" | "basemaxxing";
type EnrichedMatch = Record<string, unknown>;

import type { ImessageOutbound } from "@/imessage/outbound.js";

export type { GroupParticipant } from "@/messaging/utils/groupTag.utils.js";

export type MessagingPlatform = "imessage" | "whatsapp";

export interface ContactTransferNotification {
  recipientPhone: string;
  amount: string;
  asset: string;
  /** Optional user note for the send (UI/notify metadata only). */
  memo?: string;
  /**
   * When set, save this contact for the sender after the transfer succeeds
   * (group tag-to-send resolved from Spectrum participants).
   */
  autoSaveContact?: { name: string; phone: string };
}

/** Waiting for the sender's optional message choice before preparing a contact send. */
export interface PendingSendMessage {
  originalText: string;
  contactTransfer: ContactTransferNotification;
  transaction: Extract<AIResponse, { type: "transaction" }>;
  createdAt: number;
}

export interface TradeDeliveryContext {
  conversationId: string;
  isGroup: boolean;
  /** Originating iMessage line, needed to reopen a group from a poller. */
  deliveryPhone?: string;
  originSenderId: string;
  copyTradeCtx?: CopyTradeCtxPayload;
}

export type PendingGroupCopyTrade = CopyTradeCtxPayload & {
  label: string;
  originSenderId: string;
  deliveryPhone?: string;
  expiresAt: number;
};

/**
 * A transaction the user has been asked to confirm but hasn't yet. Because
 * iMessage has no wallet "sign" prompt, we summarize the prepared calls, wait
 * for a text confirmation, then submit them from the custodial wallet.
 */
export interface PendingTrade {
  calls?: WalletCall[];
  /** Short human label, e.g. "Long ETH on Avantis". */
  label: string;
  /** CDP account name to submit FROM. */
  accountName?: string;
  batches?: PendingTradeBatch[];
  createdAt: number;
  /** Set only for contact-based sends to trigger a post-confirm DM to the recipient. */
  recipientNotification?: {
    phone: string;
    contactName: string;
    /** Human-readable amount string, e.g. "10 USDC". */
    amount: string;
  };
}

export interface PendingTradeBatch {
  accountName: string;
  label: string;
  calls: WalletCall[];
}

export interface PendingEscrowDeposit {
  phone: string;
  contactName: string;
  amount: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  memo?: string;
  /**
   * When set, this escrow was corridor-routed: `amount`/`tokenSymbol` are the
   * local stable, and YES re-quotes a USDC→local swap spending this USDC amount.
   */
  sourceUsdcAmount?: string;
  /** Expected local out (pre-slippage) for confirm copy, e.g. "12.7". */
  quotedLocalAmount?: string;
}

/** Waiting for the sender to confirm the recipient's number before locking escrow. */
export interface PendingEscrowConfirm {
  escrow: PendingEscrowDeposit;
  createdAt: number;
  /** The next reply supplies or skips the optional transfer message. */
  awaitingMessage?: boolean;
  /** Auto-save after a successful escrow deposit (group participant resolution). */
  autoSaveContact?: { name: string; phone: string };
}

export interface PendingYieldChoice {
  token: string;
  amountToken: string | null;
  options: Extract<AIResponse, { type: "disambiguate" }>["options"];
  createdAt: number;
}

export interface PendingAmountChoice {
  asset: string;
  protocol: Extract<AIResponse, { type: "amount_select" }>["protocol"];
  presetsUsd: number[];
  createdAt: number;
}

export interface PendingSwapDraft {
  fromAsset: string;
  toAsset: string;
  createdAt: number;
}

export interface LastBalanceAssetMention {
  asset: string;
  createdAt: number;
}

export type PerpTpslChoice = "skip" | "set";

export interface ImessagePerpState {
  dir?: "long" | "short";
  tok?: string;
  lev?: number;
  coll?: string;
  order?: AvantisOrderType;
  openPrice?: string;
  tp?: string;
  sl?: string;
  tpsl?: PerpTpslChoice;
}

export interface PendingPerpFlow {
  kind: "setup_choice" | "trade" | "profile_tier" | "profile_collateral";
  state: ImessagePerpState;
  originalText: string;
  tier?: PerpRiskTier;
  createdAt: number;
}

export interface PendingWorldCupMatch {
  team: string;
  matches: EnrichedMatch[];
  amountBasemate: number | null;
  amountUsd: number | null;
  createdAt: number;
}

export interface ImessageAvantisCloseRequest {
  closeAll: boolean;
  pair?: string;
  tradeIndex?: number;
  walletScope: "main_server_wallet" | "basemate_wallet" | "both_wallets";
}

/** A contact-save request parsed from chat text. */
export interface ParsedContactSave {
  /** Present for the "Name: <number>" form; absent for a bare number. */
  name?: string;
  /** The raw phone portion as typed (may still lack a country code). */
  phoneRaw: string;
}

export interface ImessageInboundParams {
  senderId: string;
  conversationId: string;
  dmConversationId?: string;
  isGroup?: boolean;
  /** Provider line that owns the originating iMessage conversation. */
  deliveryPhone?: string;
  /** Spectrum space.participants for group tag-to-send resolution. */
  groupParticipants?: GroupParticipant[];
  /** Internal metadata used when a disambiguated contact send is re-driven by address. */
  resolvedContactTransfer?: ContactTransferNotification;
  text: string;
}

/**
 * iMessage-specific handler interface.
 *
 * `handleInboundText` returns `ImessageOutbound[]` (richer than plain `string[]`)
 * so the iMessage layer can transmit images, links, and multi-part replies.
 * It intentionally does NOT extend `ContactAwareChannel` directly because the
 * return type is narrower — callers that need the generic interface can use
 * `MessageChannel` via a wrapper.
 */
export interface ImessageHandler {
  handleInboundText(params: ImessageInboundParams): Promise<ImessageOutbound[]>;
  handleInboundContact(params: { senderId: string; name?: string; phone?: string }): Promise<string>;
  hasPendingInteraction(params: { senderId: string; conversationId: string }): Promise<boolean>;
}

export interface CreateMessagingHandlerOptions {
  platform?: MessagingPlatform;
  logPrefix?: string;
  rampIntentsComingSoon?: boolean;
  onProductModeDetected?: (args: {
    senderId: string;
    conversationId: string;
    mode: ImessageProductMode;
  }) => void | Promise<void>;
}
