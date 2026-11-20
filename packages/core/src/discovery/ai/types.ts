/**
 * Shared type definitions for the DiscoveryAI system.
 * Extracted from discovery/ai.ts to keep the god-file manageable.
 *
 * All types here are re-exported from `@/discovery/ai.js` to preserve the
 * existing public import path — callers never need to change their imports.
 */

import type { NSGroup } from "@/discovery/adapters/nsGroup.adapter.js";
import type { StrategyTradeAttribution } from "@/discovery/adapters/strategy.adapter.js";
import type { FlashPreparedOrder } from "@/discovery/flash/types.js";

// ── Types re-exported from @basemate/shared (canonical source) ────────────────
import type {
  WalletCall,
  AvantisEnvelope,
  AvantisPairMeta,
  AvantisOrderType,
  AvantisUserTrade,
  AvantisUserData,
  LaunchToken,
  LaunchResult,
} from "@basemate/shared";
export type {
  WalletCall,
  AvantisEnvelope,
  AvantisPairMeta,
  AvantisOrderType,
  AvantisUserTrade,
  AvantisUserData,
  LaunchToken,
  LaunchResult,
};

export type TpslUpdateGuideState = {
  pairIndex: number;
  tradeIndex: number;
  pair: string;
  side: "long" | "short";
  entryPrice?: string;
  tp?: string;
  sl?: string;
  ownerInboxId?: string;
  /** Trader wallet (required for server-wallet TP/SL). */
  trader?: string;
  /** CDP account name for Basemate strategy wallets. */
  walletName?: string;
  signing?: "linked" | "server";
};

export type AvantisSerializedOrderType = AvantisOrderType;

export interface AvantisOpenUrlArgs {
  trader: string;
  pair: string;
  side: "long" | "short";
  orderType?: AvantisOrderType;
  collateral: string;
  leverage: number;
  openPrice?: string | null;
  takeProfit?: string | null;
  stopLoss?: string | null;
  slippagePercent?: string | number;
}

export interface AvantisIndexedTradeArgs {
  trader: string;
  pairIndex: number;
  tradeIndex: number;
}

export type AvantisPairIndexLookup = Map<number, string>;

export type XmtpMemberLike = {
  inboxId?: string;
  accountIdentifiers?: Array<{ identifierKind?: number; identifier?: string }>;
  identifiers?: Array<{ identifierKind?: number; identifier?: string }>;
  name?: string;
  displayName?: string;
  username?: string;
  consentState?: unknown;
};

export type AvantisTargetResolution =
  | { ok: true; wallet: string; label: string; isSelf: boolean }
  | { ok: false; message: string };

export interface AvantisPositionWalletTarget {
  wallet: string;
  label: string;
  source: "active" | "linked" | "basemate";
  /** CDP account name when closing via server signing. */
  walletName?: string;
}

export interface AvantisCloseWalletTarget {
  wallet: string;
  label: string;
  source: "active" | "basemate";
  serverAccountName?: string;
  forceServerWallet?: boolean;
}

export type AvantisCloseWalletScope = "active" | "basemate" | "both";

export interface AvantisPositionWalletReport {
  wallet: string;
  data: AvantisUserData | null;
  label?: string;
  source?: AvantisPositionWalletTarget["source"];
}

export interface AggregatedAvantisReportOptions {
  /** Base App shows Open Positions menu hint; chat transports show text close commands. */
  channel?: "xmtp" | "imessage" | "whatsapp" | "generic";
  compact?: boolean;
  attributions?: Map<string, StrategyTradeAttribution>;
}

export interface AvantisCloseIntent {
  tradeIndex?: number;
  pairIndex?: number;
  pair?: string;
  closeAll: boolean;
}

export interface MoonwellWithdrawIntent {
  asset?: string;
  amount?: string;
  isUsd?: boolean;
  all: boolean;
}

// ── Copy-trade context ────────────────────────────────────────────────────────

export type CopyTradeCtxPayload =
  | {
      type: "swap";
      fromSymbol: string;
      fromAddress: string;
      fromDecimals: number;
      toSymbol: string;
      toAddress: string;
      /** Human-readable amount of fromToken (e.g. "100") */
      amount: string;
    }
  | {
      type: "perp";
      pair: string;
      side: "long" | "short";
      leverage: number;
      /** USDC collateral size (e.g. "50") */
      collateral: string;
      orderType: string;
      /** Required to faithfully copy a limit order. */
      openPrice?: string;
    };

// ── Core AI response type ─────────────────────────────────────────────────────

export type AIResponse =
  | { type: "communities"; text: string; groups: NSGroup[] }
  | { type: "launches"; text: string; tokens: LaunchToken[] }
  | {
      type: "transaction";
      text: string;
      calls: WalletCall[];
      chainId: `0x${string}`;
      serverAccountName?: string;
      forceServerWallet?: boolean;
      followUp?: string;
      // Set when the LLM send path resolved the recipient from a saved contact
      // (any phrasing). Lets the handler notify the recipient by text once the
      // transfer confirms, mirroring the deterministic contact-send path.
      contactTransfer?: { recipientPhone: string; amount: string; asset: string; memo?: string; autoSaveContact?: { name: string; phone: string } };
      protocolVolume?: {
        protocol:
          | "moonwell"
          | "morpho"
          | "aave"
          | "avantis"
          | "uniswap"
          | "aerodrome"
          | "bankr";
        action: string;
        token?: string;
        amountUsdc: number;
        notionalUsdc?: number;
      };
      copyTradeCtx?: CopyTradeCtxPayload;
    }
  | {
      /** Definitive Flash advanced spot order awaiting confirm / quick exec. */
      type: "flash_order";
      text: string;
      prepared: FlashPreparedOrder;
      amountUsd?: number | null;
    }
  | { type: "approve"; text: string; approveUrl: string }
  | {
      type: "disambiguate";
      text: string;
      token: string;
      amountToken: string | null;
      amountUsd: string | null;
      options: Array<{ protocol: "moonwell" | "aerodrome" | "morpho" | "aave"; label: string }>;
    }
  | {
      type: "amount_select";
      text: string;
      asset: string;
      protocol: "moonwell" | "morpho" | "aave";
      presetsUsd: number[];
    }
  | {
      type: "perp_guide";
      text: string;
      state: {
        dir?: "long" | "short";
        tok?: string;
        lev?: number;
        coll?: string;
        order?: AvantisOrderType;
        openPrice?: string;
        tp?: string;
        sl?: string;
        tpsl?: "skip" | "set";
      };
    }
  | {
      type: "launch_guide";
      text: string;
      state: {
        name?: string;
        symbol?: string;
        imageUrl?: string;
        imagePromptDone?: boolean;
        /** bankr = retired; doppler_stock = leftover Redis; b20_stock = native B20 + V4 */
        mode?: "bankr" | "doppler_stock" | "b20_stock";
        /** Quote ticker to pair against. */
        pairSymbol?: string;
        /** Unused leftover from iStonks Doppler; B20 ignores this. */
        feeMode?: "both" | "stock";
        rewardStocks?: string[];
        feeAddress?: string;
        description?: string;
        website?: string;
        twitter?: string;
        telegram?: string;
      };
    }
  | {
      type: "tpsl_update_guide";
      text: string;
      state: TpslUpdateGuideState;
    }
  | {
      type: "wallet_info";
      text: string;
      address: string;
      balances: Array<{ symbol: string; formatted: string }>;
      portfolioViewUrl?: string;
    }
  | {
      type: "onramp_link";
      text: string;
      url: string;
      address?: string;
    }
  | {
      type: "offramp_link";
      text: string;
      url: string;
    }
  | {
      type: "withdraw_result";
      text: string;
      transactionHash: string;
    }
  | {
      type: "withdraw_preview";
      text: string;
      to: string;
      amount: string;
      asset: string;
      label: string;
      accountName: string;
    }
  | { type: "markdown"; text: string }
  | { type: "menu"; description?: string }
  | {
      type: "text";
      text: string;
      portfolioViewUrl?: string;
    }
  | {
      type: "pnl_card_ready";
      position: { pnlUsd: number; pnlPct: number; pair: string; side: "long" | "short"; leverage: number };
      text: string;
    }
  | {
      type: "pnl_position_picker";
      positions: Array<{
        label: string;
        pnlUsd: number;
        pnlPct: number;
        pair: string;
        side: "long" | "short";
        leverage: number;
      }>;
      text: string;
    }
  | {
      type: "perp_setup_redirect";
      text: string;
    }
  | {
      type: "perp_min_fix";
      text: string;
      trade: {
        pair: string;
        side: "long" | "short";
        leverage: number;
        collateral: string;
        orderType?: AvantisOrderType;
        openPrice?: string;
        takeProfit?: string;
        stopLoss?: string;
      };
      needCollateral: number;
      needLeverage: number;
    }
  | {
      type: "worldcup_matches";
      text: string;
      dateFrom?: string;
      dateTo?: string;
      team?: string;
      featured?: boolean;
    }
  | {
      type: "worldcup_bet_wizard";
      text: string;
      state: {
        matchId?: string;
        team?: string;
        stakeUsd?: number;
        amountBasemate?: number;
      };
    };

// ── Routing eval ──────────────────────────────────────────────────────────────

/** Populated by routing eval — records tool invocations in call order. */
export interface RoutingEvalRecorder {
  invocations: Array<{ tool: string; args: Record<string, unknown> }>;
}
