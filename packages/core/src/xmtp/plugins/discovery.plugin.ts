import { Client, filter, MessageContext } from "@xmtp/agent-sdk";
import {
  createRemoteAttachment,
  downloadRemoteAttachment,
  encryptAttachment,
} from "@xmtp/agent-sdk/util";
import {
  ContentTypeRemoteAttachment,
  type RemoteAttachment,
} from "@xmtp/content-type-remote-attachment";
import {
  ContentTypeWalletSendCalls,
  type WalletSendCallsParams,
} from "@xmtp/content-type-wallet-send-calls";
import { getAddress, isAddress } from "viem";

import {
  AVANTIS_PERP_MANAGE_HINT,
  AVANTIS_MINI_APP_URL,
  AVANTIS_ENABLED,
  MOONWELL_PORTFOLIO_URL,
  MORPHO_PORTFOLIO_URL,
  AAVE_PORTFOLIO_URL,
  DiscoveryAI,
  buildAvantisTpslUpdateCalls,
  prepareAvantisOpen,
  buildDirectSwap,
  buildRoutedSwap,
  deployBankrToken,
  fetchAvantisMarkPrice,
  fetchAvantisUserData,
  enrichAvantisPositionsWithPnl,
  getAvantisPairMeta,
  getListedAvantisBases,
  parseSimpleUsdBuy,
  resolveSelfAvantisPositionWallets,
  resolveTpslReferencePrice,
  buildStrategyAttributionMap,
  attributionKeyForTrade,
  resolveTokenAsync,
  type AIResponse,
  type CopyTradeCtxPayload,
  type AvantisPositionWalletTarget,
  type AvantisUserTrade,
  type TpslUpdateGuideState,
  type WalletCall,
  type LaunchToken,
  formatAvantisTradeCard,
  perpNotionalUsdc,
  resolveProtocolVolumeUsdc,
} from "@/discovery/ai.js";
import { fetchErc20TokenBalance } from "@/portfolio-reviews/index.js";
import {
  executeCloseForWalletTarget,
  executeTpslUpdateForWalletTarget,
} from "@/discovery/avantisPositionClose.util.js";
import { sendCalls, getBalances, BASE_USDC_ADDRESS, isStrategyPaymasterEnabled } from "@/wallet/cdp.js";
import {
  cashoutLiquidFromWallet,
  formatCashoutPreview,
  formatCashoutResult,
  formatSweepPreview,
  formatSweepResult,
  resolveCustodialSweepWallets,
  sweepCustodialWallets,
} from "@/wallet/sweep.js";
import { resolveAllWalletsForUser } from "@/account-linking/index.js";
import { generatePnlCardPng, type PnlCardInput } from "@/discovery/pnlCard.js";
import { uploadEncryptedAttachment } from "@/discovery/pnlCardUpload.js";
import {
  TPSL_SL_PERCENTS,
  TPSL_TP_PERCENTS,
  computeTpslPresetPrice,
  formatTpslExactUsd,
  formatTpslPresetLabel,
  formatTpslReferenceUsd,
  isValidTpslPrice,
  normalizeTpslUserPrice,
  tpslValidationHint,
} from "@/discovery/avantisTpsl.util.js";
import {
  GroupAdapter,
  PerpProfileAdapter,
  ProtocolVolumeAdapter,
  StrategyAdapter,
  type StrategyRow,
  type StrategyStatus,
  TokenLaunchAdapter,
  UserAdapter,
  type PerpProfile,
} from "@/discovery/adapters/index.js";
import type { StrategyTradeAttribution } from "@/discovery/adapters/strategy.adapter.js";
import type { StrategyConfig } from "@basemate/shared";
import {
  alignExplanationToConfig,
  type AuthoredStrategy,
  buildStrategyFromPrompt,
  finalizeStrategyConfig,
  formatStrategySpec,
  reconcileNameLeverage,
  resolveStrategyDirection,
} from "@/discovery/strategy/promptStrategy.js";
import {
  buildTradeAnalysis,
  improveStrategyFromWiki,
  setLossStreakNotifier,
} from "@/discovery/strategy/strategyWiki.js";
import { setStrategyExecFailureNotifier } from "@/discovery/strategy/strategyExecNotify.js";
import { PUBLISH_MIN_CLOSED_TRADES } from "@/discovery/strategy/publishGate.js";
import { deployPaperStrategy, deployStrategy, promotePaperToLive } from "@/discovery/strategy/runner.js";
import { syncCreatorStrategyPnls, syncStrategyWalletPnl } from "@/discovery/strategy/pnlSync.js";
import { ORACLE_MIN_SAMPLES } from "@/discovery/strategy/signals.js";
import {
  BASEMATE_WALLET_LABEL,
  resolveBasemateServerWallet,
  shortAddress,
} from "@/discovery/strategy/wallet.js";
import { tryBuildSignedPortfolioUrl } from "@/portfolio/access.js";
import {
  evaluatePerpMinPosition,
  formatPerpBelowMinText,
  minCollateralForTier,
  perpMarginPresetAmounts,
  perpSetupAmountButtonLabel,
  perpSetupMarginPresets,
  perpMinFixTradeWithCollateral,
  perpMinFixTradeWithLeverage,
  perpSetupFinishMinWarning,
  type PerpMinFixTrade,
} from "@/discovery/perpMinPosition.util.js";
import {
  PERP_TIER_OPTIONS,
  perpTierSetupDescription,
  perpTierUpdateDescription,
  sayLessTierDescription,
  resolveLeverageForTier,
  PERP_SETUP_REFERENCE_MAX_LEVERAGE,
  type PerpRiskTier,
} from "@/discovery/perpTier.config.js";
import { resolveBasename } from "@/discovery/services/basename.util.js";
import { invalidateBankrMarketStatsCache } from "@/discovery/services/bankrVolume.service.js";
import { sendMarkdownOrText } from "@/xmtp/core/utils.js";
import { runSerialized } from "@/xmtp/utils/conversationQueue.js";
import { shouldAbandonPendingWizard } from "@/xmtp/utils/pendingWizard.util.js";
import {
  perpWizardAwaitingFromInputKind,
  type PerpWizardContext,
} from "@/discovery/perpWizard.util.js";
import {
  isLaunchImageMime,
  isLaunchImageSizeOk,
  isLaunchImageSkip,
  uploadLaunchImage,
} from "@/xmtp/utils/launchImageUpload.js";
import {
  BASE_NETWORK_ID,
  parseTransactionReference,
  type ParsedTransactionReference,
} from "@/discovery/services/transactionReference.util.js";
import {
  sendActions,
  registerAction,
  showMenu,
  initializeAppFromConfig,
  type ActionHandler,
  type AppConfig,
} from "@/xmtp/content-types/inline-actions/index.js";
import type { ActionsContent } from "@/xmtp/content-types/inline-actions/types/ActionsContent.js";
import { createCapabilitiesConfig } from "@/xmtp/menus/capabilities.config.js";
import {
  dispatchWorldCupAiResponse,
  getWorldCupRenderer,
} from "@/xmtp/plugins/worldCup.plugin.js";
import {
  XMTPServicePlugin,
  extractReplyText,
  isReplyToAgent,
  removeMention,
  resolveSenderWalletAddress,
  formatPortfolioViewMarkdown,
  sendAgentText,
  shouldEngageInGroup,
  type PluginMetadata,
  type EventResult,
} from "@/xmtp/core/index.js";
import {
  hasPendingInteraction,
  registerPendingInteractionChecker,
} from "@/xmtp/core/pendingInteractionRegistry.js";
import {
  launchTryHandleText,
  launchRenderStep,
  launchExecute,
  finalizePendingB20Launch,
  finalizePendingDopplerLaunch,
  defaultLaunchState,
  type LaunchState,
  type LaunchWizardDeps,
} from "@/xmtp/plugins/handlers/launchWizard.handler.js";
import {
  XK,
  pendingCustomYieldToken,
  pendingStrategyPrompt,
  pendingCashout as _pendingCashout,
  improveInFlight as _improveInFlight,
  touchPending,
  clearPendingIfExpired,
  activePendingLabel,
  registerPendingTxConfirmLink,
  pendingUserKey,
  type TxConfirmLink,
  type PendingProtocolVolume,
  type CopyTradeContext,
  PENDING_TTL_MS as _PENDING_TTL_MS,
} from "@/xmtp/plugins/handlers/discovery.stateKeys.js";
import {
  sendWalletSendCalls,
  sendTrackedWalletCalls,
} from "@/xmtp/plugins/handlers/discovery.walletSend.js";
import {
  guardPerpWizardClick,
  guardTpslUpdateClick,
  sendPerpManageLink,
  sendPerpBackActions as perpSendPerpBackActions,
  registerPerpBackAction as perpRegisterPerpBackAction,
  registerSetupBackAction as perpRegisterSetupBackAction,
  renderTpslPresetMenu as perpRenderTpslPresetMenu,
  startPerpWizard as perpStartPerpWizard,
  startSayLess as perpStartSayLess,
  startPerpSettingsUpdate as perpStartPerpSettingsUpdate,
  ensurePerpProfileOrRedirect as perpEnsurePerpProfileOrRedirect,
  sendPerpSetupDm as perpSendPerpSetupDm,
  renderPerpSetupStep as perpRenderPerpSetupStep,
  renderPerpSetupOnConversation as perpRenderPerpSetupOnConversation,
  finishPerpProfileSetup as perpFinishPerpProfileSetup,
  renderPerpStep as perpRenderPerpStep,
  buildPerpTrade as perpBuildPerpTrade,
  submitAvantisPerpTrade as perpSubmitAvantisPerpTrade,
  renderPerpMinFix as perpRenderPerpMinFix,
  renderTpslUpdateStep as perpRenderTpslUpdateStep,
  submitTpslUpdate as perpSubmitTpslUpdate,
  closeOpenPosition as perpCloseOpenPosition,
  showOpenPositionDetail as perpShowOpenPositionDetail,
  listOpenPositions as perpListOpenPositions,
  dispatchPerpTopUpSend as perpDispatchPerpTopUpSend,
  dispatchPerpTopUpBundle as perpDispatchPerpTopUpBundle,
  renderPerpWalletTopUp as perpRenderPerpWalletTopUp,
  showServerWalletBalance as perpShowServerWalletBalance,
  renderPerpWalletCashout as perpRenderPerpWalletCashout,
  type PerpWizardDeps,
  type PerpSetupState,
  type PerpState,
  PERP_WALLET_TOPUP_USDC as _PERP_WALLET_TOPUP_USDC,
  PERP_QUICK_PICKS as _PERP_QUICK_PICKS,
} from "@/xmtp/plugins/handlers/perpWizard.handler.js";
import {
  startPromptStrategy as stratStartPromptStrategy,
  sendPromptStrategyDm as stratSendPromptStrategyDm,
  armPromptStrategyOnConversation as stratArmPromptStrategyOnConversation,
  cancelStrategyPrompt as stratCancelStrategyPrompt,
  listOpenStrategies as stratListOpenStrategies,
  showStrategyDetail as stratShowStrategyDetail,
  sendPaperStrategyActions as stratSendPaperStrategyActions,
  formatStrategyDetailLines as stratFormatStrategyDetailLines,
  runPromptStrategy as stratRunPromptStrategy,
  presentBuiltStrategy as stratPresentBuiltStrategy,
  capabilityInfoLines as stratCapabilityInfoLines,
  renderFinalStrategyCard as stratRenderFinalStrategyCard,
  sendExitChoice as stratSendExitChoice,
  sendMinNotionalChoice as stratSendMinNotionalChoice,
  sendCapabilityConfirm as stratSendCapabilityConfirm,
  startWikiRemix as stratStartWikiRemix,
  runImproveStrategy as stratRunImproveStrategy,
  runImproveStrategyInner as stratRunImproveStrategyInner,
  sendImproveActions as stratSendImproveActions,
  sendStrategyActions as stratSendStrategyActions,
  LIVE_STRATEGY_STATUSES,
  OPEN_STRATEGY_STATUSES,
  type StrategyWizardDeps,
} from "@/xmtp/plugins/handlers/strategyWizard.handler.js";
import {
  extractPerpMarketSymbol,
  isStrategyAffirmation,
  isStrategyCancel,
  bumpStrategyVersion,
  formatConfigChanges,
  humanJoin,
  isSweepIntentText,
  extractDestinationAddress,
  isConfirmText,
  isCancelText,
  logTextHandler,
  basemateTxLink,
  formatSignedUsdShort,
  formatStrategyListLabel,
  formatOpenPositionListLabel,
  formatOpenPositionCloseButtonLabel,
} from "@/xmtp/plugins/discovery.utils.js";
import { isMenuNavigationIntent } from "@/xmtp/utils/menuNavigationIntent.util.js";
import {
  convKey,
  stateDelete,
  stateGet,
  stateHas,
  stateHasAny,
  stateSet,
} from "@/state/conversationState.store.js";

const DISCOVERY_IMG = "https://res.cloudinary.com/dg5qvbxjp/image/upload/v1766297709/trending_zrqqfn.png";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// sendPerpManageLink → handlers/perpWizard.handler.ts

async function sendTextWithPortfolioLink(
  ctx: MessageContext,
  text: string,
  portfolioViewUrl?: string,
): Promise<void> {
  if (portfolioViewUrl) {
    await sendMarkdownOrText(
      ctx as MessageContext<string>,
      `${text}\n\n${formatPortfolioViewMarkdown(portfolioViewUrl)}`,
    );
    return;
  }
  await sendAgentText(ctx, text);
}

/** After automated Basemate-wallet perp actions, link portfolio — not Avantis mini app. */
// sendPerpManageLink extracted → handlers/perpWizard.handler.ts

function aiRespondCtx(
  ctx: MessageContext<string>,
  walletAddress: string,
  userMessage?: string,
  linkedWallets?: string[],
) {
  const content =
    userMessage ??
    (typeof ctx.message.content === "string" ? ctx.message.content : "");
  return {
    inboxId: ctx.message.senderInboxId,
    walletAddress,
    linkedWallets,
    isGroup: filter.isGroup(ctx.conversation),
    conversationId: ctx.conversation.id,
    userMessage: content,
    currentMessageId: ctx.message.id,
    agentInboxId: ctx.client.inboxId,
    conversation: ctx.conversation as any,
    client: ctx.client,
    copyPlatform: "xmtp" as const,
    copyUserKey: ctx.message.senderInboxId,
    positionsChannel: "xmtp" as const,
  };
}

// PendingProtocolVolume, TxConfirmLink, CopyTradeContext → handlers/discovery.stateKeys.ts
// PERP_WALLET_TOPUP_USDC, pendingCashout, pendingCustomYieldToken → handlers/perpWizard.handler.ts / stateKeys.ts
// XK, registerPendingTxConfirmLink → handlers/discovery.stateKeys.ts

/** Skip duplicate post-sign messages when fallback + transactionReference both fire. */
const POST_SIGN_DEDUPE_MS = 90_000;

// ── Types for Redis-stored pending-flow objects ───────────────────────────────

type PendingPerpInput = {
  kind: "leverage" | "amount" | "limitPrice" | "takeProfit" | "stopLoss";
  state: PerpState;
  maxLev?: number;
  minColl?: number;
  refPrice?: number;
  tpslSide?: "long" | "short";
};

type PendingTpslUpdateInput = {
  kind: "takeProfit" | "stopLoss";
  state: TpslUpdateGuideState;
  refPrice?: number;
};

type PendingLaunch = {
  kind: "name" | "symbol" | "image" | "pair";
  state: LaunchState;
};

type PendingAvantisPerpPoll = {
  intervalId: ReturnType<typeof setInterval>;
  timeoutId: ReturnType<typeof setTimeout>;
  trader: string;
  pairNorm: string;
  side: "long" | "short";
  leverage: number;
  collateralApprox: number;
  knownTradeIndices: Set<number>;
};

const pendingAvantisPerpPoll = new Map<string, PendingAvantisPerpPoll>();

function normalizeAvantisPair(pair: string): string {
  return pair.replace(/-/g, "").toUpperCase();
}

function clearAvantisPerpPoll(conversationId: string): void {
  const poll = pendingAvantisPerpPoll.get(conversationId);
  if (!poll) return;
  clearInterval(poll.intervalId);
  clearTimeout(poll.timeoutId);
  pendingAvantisPerpPoll.delete(conversationId);
}

let finalizeSignedTransactionRef:
  | ((ctx: MessageContext<unknown>, ref: ParsedTransactionReference | null) => Promise<void>)
  | undefined;

/** Poll Avantis when Base App omits transactionReference after a perp sign. */
function scheduleAvantisPerpConfirmPoll(
  ctx: MessageContext<string>,
  trader: string,
  trade: PerpMinFixTrade,
  knownTradeIndices: number[],
): void {
  const conversationId = ctx.conversation.id;
  clearAvantisPerpPoll(conversationId);

  const poll: PendingAvantisPerpPoll = {
    intervalId: undefined as unknown as ReturnType<typeof setInterval>,
    timeoutId: undefined as unknown as ReturnType<typeof setTimeout>,
    trader,
    pairNorm: normalizeAvantisPair(trade.pair),
    side: trade.side,
    leverage: trade.leverage,
    collateralApprox: parseFloat(trade.collateral),
    knownTradeIndices: new Set(knownTradeIndices),
  };

  const tryConfirm = async (): Promise<void> => {
    if (
      !await stateHas(XK.pendingProtocolVolume(conversationId)) &&
      !await stateHas(XK.pendingTxConfirmLink(conversationId))
    ) {
      clearAvantisPerpPoll(conversationId);
      return;
    }

    try {
      const data = await fetchAvantisUserData(trader);
      for (const pos of data.positions) {
        if (poll.knownTradeIndices.has(pos.tradeIndex)) continue;
        const posPair = normalizeAvantisPair(pos.pair ?? "");
        if (posPair !== poll.pairNorm) continue;
        if (pos.side !== poll.side) continue;
        if (pos.leverage !== poll.leverage) continue;
        const coll = parseFloat(String(pos.collateral ?? pos.collateralRaw ?? "0"));
        if (!Number.isFinite(coll) || !Number.isFinite(poll.collateralApprox)) continue;
        if (Math.abs(coll - poll.collateralApprox) / poll.collateralApprox > 0.15) continue;

        clearAvantisPerpPoll(conversationId);
        console.log(
          `✅ Avantis perp confirm fallback tradeIndex=${pos.tradeIndex} conv=${conversationId.slice(0, 8)}`,
        );
        await finalizeSignedTransactionRef?.(ctx as MessageContext<unknown>, null);
        return;
      }
    } catch (err) {
      console.warn("⚠️ Avantis perp confirm poll failed:", err);
    }
  };

  poll.intervalId = setInterval(() => {
    void tryConfirm();
  }, 15_000);
  poll.timeoutId = setTimeout(() => clearAvantisPerpPoll(conversationId), 4 * 60_000);
  pendingAvantisPerpPoll.set(conversationId, poll);
  setTimeout(() => {
    void tryConfirm();
  }, 35_000);
}

/** Match basemate.app/txn/0x… or basescan explorer links pasted after a sign. */
const TX_HASH_FROM_URL_RE =
  /(?:basemate\.app\/txn\/|explorer\.base\.org\/tx\/)(0x[a-fA-F0-9]{64})/i;

/**
 * When a group member taps "Different Amount" on a Copy Trade button, we store the
 * original CopyTradeContext here and wait for them to type a dollar amount.
 * Key: pendingUserKey(inboxId, conversationId).
 */

/**
 * Detects a compound "swap X → Y and deposit/stake on PROTOCOL" intent in a single
 * user message. Returns the target asset symbol and protocol name, or null if this
 * is a normal single-action message.
 */
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

  // Extract the target token: look for "to SYMBOL" or "into SYMBOL" before
  // the "and" connector. We require 2-10 uppercase-starting chars to avoid
  // matching common words like "a", "the", "it".
  const toMatch = message.match(/\b(?:to|into)\s+([A-Z][A-Za-z0-9]{1,9})\b/);
  if (!toMatch) return null;

  const toAsset = toMatch[1].toUpperCase();
  // Skip if the matched token is actually a protocol or connector word.
  const skip = new Set(["MORPHO", "MOONWELL", "AAVE", "THE", "IT", "THEM", "A", "AN"]);
  if (skip.has(toAsset)) return null;

  return { toAsset, protocol };
}

/** Track users who have already been shown the Basemate Community card this session. */
const shownCommunityCardTo = new Set<string>();

const BASEMATE_COMMUNITY_GROUP_ID =
  process.env.BASEMATE_COMMUNITY_GROUP_ID?.trim() || "e5102c26967d6d370dbab7de0b3b0810";

/**
 * Send the Basemate Community group card to a user — once per session.
 * The best moment is right after their first confirmed transaction.
 */
async function maybeSendCommunityCard(
  conversation: Parameters<typeof sendActions>[0],
  inboxId: string,
  walletAddress?: string,
): Promise<void> {
  // DM-only: never surface the community card in group chats (it would nag every
  // member after their first trade). Returning before the dedupe set below means a
  // group trade doesn't consume the user's one-time slot, so they still get the
  // card the next time they trade in a DM.
  if (filter.isGroup(conversation as any)) return;

  // Skip wallets listed in COMMUNITY_CARD_SKIP_WALLETS (comma-separated, for dev/testing)
  const skipWallets = (process.env.COMMUNITY_CARD_SKIP_WALLETS ?? "")
    .toLowerCase()
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);
  if (walletAddress && skipWallets.includes(walletAddress.toLowerCase())) return;

  if (shownCommunityCardTo.has(inboxId)) return;
  shownCommunityCardTo.add(inboxId);
  try {
    const { NSGroupAdapter: Adapter } = await import("@/discovery/adapters/index.js");
    const group = await Adapter.getGroupById(BASEMATE_COMMUNITY_GROUP_ID);
    if (!group) return;
    const memberCount = group.total_members ?? 0;
    const memberNote = memberCount > 0 ? `${memberCount} members` : "";
    await sendActions(conversation, {
      id: `community_card_${BASEMATE_COMMUNITY_GROUP_ID}`,
      description: `Basemate also has a Community Group Chat — jump in 👇`,
      actions: [
        {
          id: `join_${BASEMATE_COMMUNITY_GROUP_ID.slice(0, 8)}_group`,
          label: "Join Community",
          style: "primary" as const,
          imageUrl: group.image_url || undefined,
        },
      ],
    });
  } catch {
    // non-critical — don't let this break anything
  }
}

function swapProtocolVolume(
  dex: "uniswap" | "aerodrome",
  amountUsdc: number,
  token?: string,
): Omit<PendingProtocolVolume, "inboxId"> | undefined {
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) return undefined;
  return {
    protocol: dex,
    action: "swap",
    token,
    amountUsdc,
  };
}

/** DM-only PerpMate profile setup (tier + default USDC). */

/**
 * Tracks conversations waiting for a free-form reply after a user taps
 * "✏️ Custom" inside the guided perp wizard. Key: inboxId:conversationId. The intercept
 * at the top of onText validates the typed number against the per-token
 * threshold (leverage ≤ maxLev, collateral ≥ ceil(minPos/lev)) and either
 * re-prompts or advances the wizard with the augmented state.
 */

/** Mid-wizard state so typed symbols (e.g. COIN) advance the flow without hitting the LLM. */




// PERP_QUICK_PICKS → handlers/perpWizard.handler.ts
// pendingStrategyPrompt, improveInFlight → handlers/discovery.stateKeys.ts
// registerPendingInteractionChecker, PENDING_TTL_MS, touchPending,
// clearPendingIfExpired, activePendingLabel → handlers/discovery.stateKeys.ts






// sendWalletSendCalls, sendTrackedWalletCalls → handlers/discovery.walletSend.ts






/** Route Avantis closes: Basemate server wallet via CDP, user wallets via wallet_sendCalls. */
async function dispatchAvantisTransaction(
  ctx: MessageContext<string>,
  resp: Extract<AIResponse, { type: "transaction" }>,
  senderAddr: string,
): Promise<void> {
  if (resp.forceServerWallet && resp.serverAccountName) {
    try {
      const { hashes } = await sendCalls({ accountName: resp.serverAccountName, calls: resp.calls });
      const txHash = hashes[hashes.length - 1] ?? hashes[0];
      await ctx.conversation.send(`${resp.text}\n\nClosed.`);
      if (txHash) await sendPerpManageLink(ctx, { signing: "server" });
    } catch (err) {
      console.error("❌ Basemate server wallet close failed:", err);
      await ctx.conversation.send("couldn't close that position — try again in a moment");
    }
    return;
  }

  const isAvantisPerpOpen =
    resp.protocolVolume?.protocol === "avantis" &&
    resp.protocolVolume.action === "perp_open" &&
    resp.copyTradeCtx?.type === "perp";

  if (isAvantisPerpOpen) {
    let baselineTradeIndices: number[] = [];
    let baselineOk = false;
    try {
      const before = await fetchAvantisUserData(senderAddr);
      baselineTradeIndices = before.positions.map((p) => p.tradeIndex);
      baselineOk = true;
    } catch (err) {
      console.warn("⚠️ Avantis perp poll skipped — baseline fetch failed:", err);
    }

    await sendTrackedWalletCalls(
      ctx,
      resp.calls,
      resp.chainId,
      resp.text,
      senderAddr,
      resp.followUp,
      resp.protocolVolume,
    );

    if (baselineOk) {
      const ct = resp.copyTradeCtx;
      if (ct?.type === "perp") {
        scheduleAvantisPerpConfirmPoll(
          ctx,
          senderAddr,
          {
            pair: ct.pair,
            side: ct.side,
            leverage: ct.leverage,
            collateral: ct.collateral,
            orderType: ct.orderType === "limit" ? "limit" : "market",
          },
          baselineTradeIndices,
        );
      }
    }
  } else {
    await sendTrackedWalletCalls(
      ctx,
      resp.calls,
      resp.chainId,
      resp.text,
      senderAddr,
      resp.followUp,
      resp.protocolVolume,
    );
  }

  // In group conversations, register copy trade context so the transactionReference
  // handler can offer a "Copy Trade" button to other members.
  if (filter.isGroup(ctx.conversation) && resp.copyTradeCtx) {
    const ctx_ = resp.copyTradeCtx;
    const label =
      ctx_.type === "swap"
        ? `Swap ${ctx_.amount} ${ctx_.fromSymbol} → ${ctx_.toSymbol}`
        : `${ctx_.leverage}x ${ctx_.side} ${ctx_.pair}`;
    await stateSet(XK.pendingGroupCopyTrade(ctx.conversation.id), {
      ...ctx_,
      label,
      originInboxId: ctx.message.senderInboxId,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
  }
}

export class DiscoveryPlugin extends XMTPServicePlugin {
  metadata: PluginMetadata = {
    name: "DiscoveryPlugin",
    version: "1.0.0",
    priority: 60,
    description: "Community discovery on Base",
  };

  declare client: Client<any>;
  ai = new DiscoveryAI();
  capabilitiesConfig: AppConfig | null = null;

  private get launchDeps(): LaunchWizardDeps {
    return { ai: this.ai, xk: XK };
  }

  constructor() {
    super();
    this.onText = this.onText.bind(this);
    this.onGroup = this.onGroup.bind(this);
    this.onMessage = this.onMessage.bind(this);
    this.onAttachment = this.onAttachment.bind(this);
  }

  async onInit(): Promise<void> {
    this.capabilitiesConfig = createCapabilitiesConfig(
      {
        startPromptStrategy: (ctx) => this.startPromptStrategy(ctx),
        listOpenStrategies: (ctx) => this.listOpenStrategies(ctx),
        listOpenPositions: (ctx) => this.listOpenPositions(ctx),
        showWalletBalance: (ctx) => this.showServerWalletBalance(ctx),
        startSayLess: (ctx) => this.startSayLess(ctx),
        startLaunchWizard: (ctx) => this.renderLaunchStep(ctx, defaultLaunchState()),
        showNewPairs: (ctx) => this.showNewPairs(ctx),
        showCheckTokenHelp: async (ctx) => {
          await ctx.conversation.send(
            "paste a base app trading feed link or a contract address (0x…) and i'll pull dexscreener stats — price, liquidity, volume — and can offer buy buttons after",
          );
        },
        showTrendingTokens: (ctx) => this.runTrendingTokens(ctx),
        startYieldCompare: (ctx) => this.startYieldComparePicker(ctx),
      },
      AVANTIS_ENABLED,
    );
    initializeAppFromConfig(this.capabilitiesConfig);
    finalizeSignedTransactionRef = (ctx, ref) =>
      this.handleSignedTransactionReference(ctx, ref);

    // Loss-streak nudge: DM the creator to tap Improve. Message only, no auto-apply.
    setLossStreakNotifier(async (notice) => {
      const wallet = notice.creatorWallet;
      if (!wallet || !this.client) return;
      try {
        const dm: any = await this.client.conversations.newDmWithIdentifier({
          identifier: wallet as `0x${string}`,
          identifierKind: 0,
        });
        if (typeof dm.sync === "function") await dm.sync();
        await dm.send(
          `"${notice.strategyName}" just hit ${notice.losses} losses in a row 💙 tap Improve in My Strategies — i've been tracking what's happening and can suggest a fix.`,
        );
      } catch (err) {
        console.warn(`⚠️ loss-streak DM failed: ${(err as Error)?.message || err}`);
      }
    });

    // Funding-failure nudge: a live strategy tried to trade but its Basemate
    // wallet is out of USDC (or ETH for gas). Fires once per failure state.
    setStrategyExecFailureNotifier(async (notice) => {
      const wallet = notice.creatorWallet;
      if (!wallet || !this.client) return;
      // With CDP paymaster, gas is sponsored — don't nag users about ETH.
      if (notice.issue === "no_gas" && isStrategyPaymasterEnabled()) return;
      const margin = Math.max(1, Math.ceil(notice.marginUsdc));
      const body =
        notice.issue === "no_gas"
          ? `"${notice.strategyName}" is ready to trade but your ${BASEMATE_WALLET_LABEL} has no ETH for gas — send a little ETH on Base to get it going 💙`
          : `"${notice.strategyName}" tried to enter a trade but your ${BASEMATE_WALLET_LABEL} doesn't have enough USDC — top up at least $${margin} to keep it running 💙`;
      try {
        const dm: any = await this.client.conversations.newDmWithIdentifier({
          identifier: wallet as `0x${string}`,
          identifierKind: 0,
        });
        if (typeof dm.sync === "function") await dm.sync();
        await dm.send(body);
        if (notice.walletAddress) {
          await dm.send(
            `${BASEMATE_WALLET_LABEL}: ${notice.walletAddress}`,
          );
        }
      } catch (err) {
        console.warn(`⚠️ exec-failure DM failed: ${(err as Error)?.message || err}`);
      }
    });

    console.log("✅ DiscoveryPlugin initialized");
  }

  /** Base App posts a transactionReference after the user signs wallet_sendCalls. */
  async onMessage(ctx: MessageContext<unknown>): Promise<EventResult> {
    const ref = parseTransactionReference(ctx.message.content);
    if (!ref || ref.networkId.toLowerCase() !== BASE_NETWORK_ID) return;
    await this.handleSignedTransactionReference(ctx, ref);
    return true;
  }

  /**
   * Post-sign handler: log protocol volume, send confirmation link, run follow-ups.
   * Called from onMessage (native transactionReference), onText (JSON text / pasted txn URLs),
   * and the Avantis position poll fallback when Base App omits transactionReference.
   */
  private async handleSignedTransactionReference(
    ctx: MessageContext<unknown>,
    ref: ParsedTransactionReference | null,
  ): Promise<void> {
    clearAvantisPerpPoll(ctx.conversation.id);

    const hadPending =
      await stateHas(XK.pendingProtocolVolume(ctx.conversation.id)) ||
      await stateHas(XK.pendingTxConfirmLink(ctx.conversation.id)) ||
      await stateHas(XK.pendingYieldFollowUp(ctx.conversation.id)) ||
      await stateHas(XK.pendingDopplerLaunch(ctx.conversation.id)) ||
      await stateHas(XK.pendingB20Launch(ctx.conversation.id));

    const lastFinalized = await stateGet<number>(XK.recentlyFinalized(ctx.conversation.id));
    if (
      !hadPending &&
      lastFinalized != null &&
      Date.now() - lastFinalized < POST_SIGN_DEDUPE_MS
    ) {
      console.log(
        `⏭️ Skipping duplicate post-sign confirm conv=${ctx.conversation.id.slice(0, 8)}`,
      );
      return;
    }

    if (ref?.txHash) {
      console.log(
        `✅ transactionReference ${ref.txHash.slice(0, 10)}… conv=${ctx.conversation.id.slice(0, 8)}`,
      );
    } else {
      console.log(`✅ post-sign confirm (no tx ref) conv=${ctx.conversation.id.slice(0, 8)}`);
    }

    // B20 / Doppler stock-paired launch: community group after user signs.
    try {
      const b20Done = await finalizePendingB20Launch(
        ctx as MessageContext,
        ref?.txHash,
      );
      if (b20Done) {
        await stateSet(XK.recentlyFinalized(ctx.conversation.id), Date.now());
        return;
      }
      const dopplerDone = await finalizePendingDopplerLaunch(
        ctx as MessageContext,
        ref?.txHash,
      );
      if (dopplerDone) {
        await stateSet(XK.recentlyFinalized(ctx.conversation.id), Date.now());
        return;
      }
    } catch (err) {
      console.warn("⚠️ stock-pair launch finalize failed:", err);
    }

    const followUpText = await stateGet<string>(XK.pendingYieldFollowUp(ctx.conversation.id));
    if (followUpText) {
      await stateDelete(XK.pendingYieldFollowUp(ctx.conversation.id));
      try {
        await ctx.conversation.send(followUpText);
      } catch (err) {
        console.warn("⚠️ yield follow-up send failed:", err);
      }
    }

    const pendingVol = await stateGet<PendingProtocolVolume>(XK.pendingProtocolVolume(ctx.conversation.id));
    if (pendingVol) {
      await stateDelete(XK.pendingProtocolVolume(ctx.conversation.id));
      try {
        await ProtocolVolumeAdapter.record({
          inboxId: pendingVol.inboxId,
          protocol: pendingVol.protocol,
          action: pendingVol.action,
          token: pendingVol.token,
          amountUsdc: pendingVol.amountUsdc,
          notionalUsdc: pendingVol.notionalUsdc,
          txHash: ref?.txHash ?? null,
        });
        const notionalNote =
          pendingVol.notionalUsdc != null && pendingVol.notionalUsdc > 0
            ? ` / $${pendingVol.notionalUsdc} notional`
            : "";
        const txNote = ref?.txHash ? ` (${ref.txHash.slice(0, 10)}…)` : "";
        console.log(
          `📊 Protocol volume logged: ${pendingVol.protocol} $${pendingVol.amountUsdc}${notionalNote}${txNote}`,
        );
        if (pendingVol.protocol === "bankr") {
          invalidateBankrMarketStatsCache();
        }
      } catch (err) {
        console.warn("⚠️ protocol volume log failed:", err);
      }
    }

    const confirmLink =
      await stateGet<TxConfirmLink>(XK.pendingTxConfirmLink(ctx.conversation.id)) ??
      (pendingVol?.protocol === "avantis" ? "avantis" : "basemate");
    await stateDelete(XK.pendingTxConfirmLink(ctx.conversation.id));

    const senderWallet = await resolveSenderWalletAddress(ctx as any).catch(() => undefined);
    await maybeSendCommunityCard(ctx.conversation, ctx.message.senderInboxId, senderWallet ?? undefined).catch(
      () => {},
    );

    const postTx = await stateGet<{ toAsset: string; protocol: string; inboxId: string }>(XK.pendingPostTxActionXmtp(ctx.conversation.id));
    if (postTx) {
      await stateDelete(XK.pendingPostTxActionXmtp(ctx.conversation.id));
      this.executePostTxDeposit(ctx, postTx, senderWallet ?? "").catch((err) => {
        console.warn("⚠️ post-tx deposit action failed:", err);
      });
    }

    if (filter.isGroup(ctx.conversation)) {
      const copyCtx = await stateGet<CopyTradeContext>(XK.pendingGroupCopyTrade(ctx.conversation.id));
      if (copyCtx && copyCtx.expiresAt > Date.now()) {
        await stateDelete(XK.pendingGroupCopyTrade(ctx.conversation.id));
        const msgId = ctx.message.id.slice(0, 8);
        const actionId = `copy_trade_${msgId}`;
        registerAction(actionId, (actionCtx: MessageContext) =>
          this.handleCopyTradeButton(actionCtx, copyCtx),
        );
        if (copyCtx.type === "swap" && ref?.txHash) {
          await ctx.conversation
            .send(basemateTxLink(ref.txHash))
            .catch((err) => console.warn("⚠️ tx confirmation send failed:", err));
        }
        await sendActions(ctx.conversation, {
          id: `copy_trade_menu_${msgId}`,
          description: `✅ ${copyCtx.label} confirmed — want to copy this trade?`,
          actions: [{ id: actionId, label: "Copy Trade", style: "primary" as const }],
          expiresAt: new Date(copyCtx.expiresAt).toISOString(),
        }).catch((err) => console.warn("⚠️ Copy Trade button send failed:", err));
        return;
      }
    }

    if (confirmLink === "basemate" && ref?.txHash) {
      await ctx.conversation
        .send(basemateTxLink(ref.txHash))
        .catch((err) => console.warn("⚠️ tx confirmation send failed:", err));
    } else if (confirmLink === "avantis" || !ref?.txHash) {
      const avantisLinkAlreadySent =
        followUpText != null && followUpText.includes(AVANTIS_MINI_APP_URL);
      if (!avantisLinkAlreadySent) {
        await ctx.conversation
          .send(AVANTIS_MINI_APP_URL)
          .catch((err) => console.warn("⚠️ avantis confirmation send failed:", err));
      }
    }

    if (hadPending) {
      await stateSet(XK.recentlyFinalized(ctx.conversation.id), Date.now());
    }
  }

  /**
   * After a swap confirms, wait briefly for chain indexing, fetch the received
   * token balance, then automatically prepare the deposit transaction card.
   */
  private async executePostTxDeposit(
    ctx: MessageContext<unknown>,
    action: { toAsset: string; protocol: string; inboxId: string },
    walletAddress: string,
  ): Promise<void> {
    if (!walletAddress) return;

    // Wait for the chain to index the new balance.
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    let depositAmount: string | undefined;
    try {
      const token = await resolveTokenAsync(action.toAsset);
      if (token.resolved && token.address !== "ETH") {
        const balance = await fetchErc20TokenBalance(token.address, walletAddress, token.decimals);
        if (balance > 0) {
          // Round to 6 significant figures to avoid floating-point noise.
          depositAmount = String(parseFloat(balance.toPrecision(6)));
          console.log(
            `🔗 Post-swap balance: ${depositAmount} ${action.toAsset} — preparing ${action.protocol} deposit`,
          );
        }
      }
    } catch (err) {
      console.warn("⚠️ post-tx balance fetch failed:", err);
    }

    const verb = action.protocol === "moonwell" || action.protocol === "aave" ? "supply" : "deposit";
    const depositMsg = depositAmount
      ? `${verb} ${depositAmount} ${action.toAsset} on ${action.protocol}`
      : `${verb} ${action.toAsset} on ${action.protocol}`;

    try {
      const aiCtx = aiRespondCtx(
        ctx as MessageContext<string>,
        walletAddress,
        depositMsg,
      );
      aiCtx.inboxId = action.inboxId;
      const resp = await this.ai.respond(depositMsg, aiCtx);
      await this.dispatchAiResponse(ctx as MessageContext<string>, resp, walletAddress);
    } catch (err) {
      console.warn("⚠️ post-tx deposit ai.respond failed:", err);
    }
  }

  // ─── Copy Trade ──────────────────────────────────────────────────────────────

  /**
   * Fired when a group member taps the "Copy Trade" button shown after another
   * member's swap or perp open. Shows two follow-up options: Same Amount or
   * Different Amount.
   */
  private async handleCopyTradeButton(
    ctx: MessageContext,
    copyCtx: CopyTradeContext,
  ): Promise<void> {
    const senderInboxId = ctx.message.senderInboxId;

    // Prevent the original trader from copying their own trade.
    if (senderInboxId === copyCtx.originInboxId) {
      await ctx.conversation.send("that's your own trade — copy is for other group members 😄");
      return;
    }

    const msgId = ctx.message.id.slice(0, 8);
    const sameId = `copy_same_${msgId}`;
    const diffId = `copy_diff_${msgId}`;

    registerAction(sameId, async (actionCtx: MessageContext) => {
      await this.executeCopyTrade(actionCtx, copyCtx, copyCtx.type === "swap" ? copyCtx.amount : copyCtx.collateral);
    });

    registerAction(diffId, async (actionCtx: MessageContext) => {
      const key = pendingUserKey(actionCtx.message.senderInboxId, actionCtx.conversation.id);
      await stateSet(XK.pendingCopyTradeAmount(key), copyCtx);
      await actionCtx.conversation.send("how much USDC do you want to spend?");
    });

    await sendActions(ctx.conversation, {
      id: `copy_amount_${msgId}`,
      description: `Copy — ${copyCtx.label}. Use the same amount or enter your own?`,
      actions: [
        { id: sameId, label: "Same Amount", style: "primary" as const },
        { id: diffId, label: "Different Amount" },
      ],
      expiresAt: new Date(copyCtx.expiresAt).toISOString(),
    }).catch((err) => console.warn("⚠️ Copy Trade amount buttons failed:", err));
  }

  /**
   * Execute the copy trade for a group member with the given USDC amount.
   * For swaps: re-builds the route for the clicker's wallet.
   * For perps: calls submitAvantisPerpTrade with the stored params.
   */
  private async executeCopyTrade(
    ctx: MessageContext,
    copyCtx: CopyTradeContext,
    amount: string,
  ): Promise<void> {
    const senderAddr = (await resolveSenderWalletAddress(ctx as any)) || "";
    if (!senderAddr) {
      await ctx.conversation.send("connect your wallet in Base App before copying a trade");
      return;
    }

    if (copyCtx.type === "swap") {
      await ctx.conversation.send(`Getting best price for ${copyCtx.fromSymbol} → ${copyCtx.toSymbol}…`);
      try {
        const swap = await buildRoutedSwap(
          copyCtx.fromAddress,
          copyCtx.fromSymbol,
          copyCtx.fromDecimals,
          copyCtx.toAddress,
          copyCtx.toSymbol,
          amount,
          senderAddr,
        );
        if (!swap) {
          await ctx.conversation.send(
            `Couldn't build a swap route for ${copyCtx.fromSymbol} → ${copyCtx.toSymbol}. Try again in a moment.`,
          );
          return;
        }
        const swapVolumeUsdc = await resolveProtocolVolumeUsdc({
          usdAmount: amount,
          isUsd: copyCtx.fromSymbol.toUpperCase() === "USDC",
          tokenAmount: amount,
          symbol: copyCtx.fromSymbol,
          tokenAddress: copyCtx.fromAddress,
        });
        await sendTrackedWalletCalls(
          ctx as MessageContext<string>,
          swap.calls,
          "0x2105",
          swap.label,
          senderAddr,
          undefined,
          swapVolumeUsdc != null && swapVolumeUsdc > 0
            ? swapProtocolVolume(
                swap.dex,
                swapVolumeUsdc,
                `${copyCtx.fromSymbol}/${copyCtx.toSymbol}`,
              )
            : undefined,
        );
      } catch (err) {
        console.warn("⚠️ Copy Trade swap build failed:", err);
        await ctx.conversation.send("couldn't prepare that swap — try again in a moment");
      }
    } else {
      await this.submitAvantisPerpTrade(ctx as MessageContext<string>, senderAddr, {
        pair: copyCtx.pair,
        side: copyCtx.side,
        leverage: copyCtx.leverage,
        collateral: amount,
        orderType: (copyCtx.orderType === "limit" ? "limit" : "market") as "market" | "limit",
      });
    }
  }

  /**
   * Decrypt XMTP remote attachments during the launch wizard image step.
   * Does not require a group @mention — only active when pendingLaunch.kind === "image".
   */
  async onAttachment(ctx: MessageContext<unknown>): Promise<EventResult> {
    if (filter.fromSelf(ctx.message, ctx.client)) return;

    const pendingKey = pendingUserKey(ctx.message.senderInboxId, ctx.conversation.id);
    const pendingLnch = await stateGet<{ kind: "name" | "symbol" | "image" | "pair"; state: LaunchState; token?: LaunchToken; walletAddress?: string; createdAt?: number; txConfirmUrl?: string }>(XK.pendingLaunch(pendingKey));
    if (!pendingLnch || pendingLnch.kind !== "image") return;

    if (!this.agent) {
      await ctx.conversation.send("can't process that image right now — try again in a sec");
      return true;
    }

    try {
      const received = await downloadRemoteAttachment(
        ctx.message.content as RemoteAttachment,
        this.agent,
      );
      const mimeType = received.mimeType ?? "";
      const data = received.data;
      const filename = received.filename ?? "launch-image.jpg";

      if (!isLaunchImageMime(mimeType)) {
        await ctx.conversation.send("send a photo (jpg or png) for the token image, or reply skip");
        return true;
      }
      if (!isLaunchImageSizeOk(data.byteLength)) {
        await ctx.conversation.send("that image is too large — use something under 5mb, or reply skip");
        return true;
      }

      await ctx.conversation.send("got it — uploading your token image…");
      const imageUrl = await uploadLaunchImage(data, filename, mimeType);
      if (!imageUrl) {
        await ctx.conversation.send(
          "couldn't upload that image (cloudinary not configured or upload failed) — try another photo or reply skip",
        );
        return true;
      }

      await stateDelete(XK.pendingLaunch(pendingKey));
      await this.renderLaunchStep(ctx, {
        ...pendingLnch.state,
        imageUrl,
        imagePromptDone: true,
      });
      return true;
    } catch (err) {
      console.warn("⚠️ launch image attachment failed:", err);
      await ctx.conversation.send("couldn't read that image — try sending it again or reply skip");
      return true;
    }
  }

  getActions(): Map<string, ActionHandler> {
    const actions = new Map<string, ActionHandler>();

    actions.set("trending_groups", async (ctx) => {
      console.log("🔥 Discovery button clicked");
      try {
        const { TrendingService } = await import("@/discovery/services/trending.js");
        const trendingService = new TrendingService();
        const slots = await trendingService.getTrendingSlots(3);

        if (slots.length > 0) {
          const trendingGroups = slots.map((s) => s.group);
          console.log(`📊 Discovery: ${slots.map((s) => `[${s.slot}] ${s.group.name} (${s.source})`).join(", ")}`);

          const joinActions: ActionsContent = {
            id: "trending_results",
            description: `🔥 Top ${trendingGroups.length} Communities:`,
            actions: trendingGroups.map((g) => ({
              id: `join_${g.groupId.slice(0, 8)}_group`,
              label: g.name.length > 25 ? g.name.slice(0, 22) + "..." : g.name,
              imageUrl: g.imageUrl || DISCOVERY_IMG,
              style: "primary" as const,
            })),
          };
          await sendActions(ctx.conversation, joinActions);
          console.log(`✅ Sent top ${trendingGroups.length} trending groups`);
        } else {
          await ctx.conversation.send("No trending groups found at the moment.");
        }
      } catch (err: any) {
        console.error("❌ Error fetching trending:", err);
        await ctx.conversation.send("❌ Error loading trending groups. Please try again.");
      }
    });

    actions.set("show_main_menu", async (ctx) => {
      await this.showCapabilitiesMenu(ctx);
      console.log("✅ Main menu sent");
    });

    actions.set("end_conversation", async (ctx) => {
      await this.showCapabilitiesMenu(ctx);
    });

    actions.set("join_*", async (ctx) => {
      const baseActionId = (ctx as any).__baseActionId as string;
      if (!baseActionId?.startsWith("join_") || !baseActionId?.endsWith("_group")) return;

      const groupIdPrefix = baseActionId.replace("join_", "").replace("_group", "");
      console.log(`🔍 Join group - prefix: ${groupIdPrefix}`);

      try {
        const { NSGroupAdapter } = await import("@/discovery/adapters/index.js");
        const group = await NSGroupAdapter.getGroupByIdPrefix(groupIdPrefix);
        if (!group) {
          console.log(`❌ No group in DB with prefix: ${groupIdPrefix}`);
          await ctx.conversation.send("❌ Could not find the group.");
          return;
        }

        console.log(`✅ Found in DB: "${group.name}" (${group.group_id})`);

        let targetGroup: any = null;
        try {
          targetGroup = await ctx.client.conversations.getConversationById(group.group_id);
          if (targetGroup) {
            console.log(`✅ Found group in XMTP: ${group.group_id}`);
          } else {
            console.log(`⚠️ Group not in local DB: ${group.group_id}`);
          }
        } catch (e: any) {
          console.log(`⚠️ getConversationById failed: ${e.message}`);
        }

        if (targetGroup) {
          try {
            await targetGroup.addMembers([ctx.message.senderInboxId]);
            await ctx.conversation.send(`✅ Welcome to "${group.name}"! You can find it in your group chats.`);
            console.log(`✅ Added user to: ${group.name}`);
          } catch (e: any) {
            console.log(`⚠️ addMembers failed: ${e.message}`);
            if (e.message?.includes("verify") || e.message?.includes("already")) {
              await ctx.conversation.send(`✅ You're already in "${group.name}"! Check your group chats.`);
            } else {
              await ctx.conversation.send(`❌ Could not add you to "${group.name}". Please try again.`);
            }
          }
        } else {
          // Agent isn't a member of this group anymore (kicked, wallet change,
          // etc). Mark it as such so discovery stops surfacing it and the next
          // user doesn't hit this same dead button.
          await NSGroupAdapter.updateAgentInGroup(group.group_id, false);
          NSGroupAdapter.invalidateAgentGroupIdSet();
          console.log(
            `🔁 join_*: cleared agent_in_group for "${group.name}" (${group.group_id.slice(0, 8)}...)`,
          );
          await ctx.conversation.send(
            `Sorry, "${group.name}" isn't available right now. An admin will need to re-add Basemate before users can join through me.`,
          );
        }
      } catch (err: any) {
        console.error("❌ Error joining group:", err);
        await ctx.conversation.send(`❌ Error joining group: ${err.message}`);
      }
    });

    return actions;
  }

  private trackNonEngagedGroupMessage(
    ctx: MessageContext<string>,
    messageContent: string,
  ): void {
    const senderInboxId = ctx.message.senderInboxId;
    GroupAdapter.incrementGroupMessage(ctx.conversation.id).catch(() => {});

    import("@/discovery/adapters/index.js").then(({ NSGroupAdapter }) =>
      NSGroupAdapter.incrementMessageCount(ctx.conversation.id, senderInboxId)
    ).catch(() => {});

    resolveSenderWalletAddress(ctx as any)
      .then(async (walletAddress) => {
        const wallet = walletAddress || null;
        try {
          if (wallet) {
            const { findBestKeywordMatch } = await import("@/shared/keyword-matcher.js");
            const { KeywordAdapter } = await import("@/discovery/adapters/keyword.adapter.js");
            const { RecommendationAdapter } = await import(
              "@/discovery/adapters/recommendation.adapter.js"
            );

            const kwMatch = await findBestKeywordMatch(messageContent, {
              sourcePlatform: "xmtp",
            });

            if (kwMatch?.keyword.target_group_type === "base") {
              const { NSGroupAdapter: _NS } = await import(
                "@/discovery/adapters/nsGroup.adapter.js"
              );
              const memberIds = await _NS.getAgentGroupIdSet();
              if (!memberIds.has(kwMatch.keyword.target_group_id)) {
                console.log(
                  `⚠️ Skipping keyword rec — agent not in target group ${kwMatch.keyword.target_group_id.slice(0, 8)}...`,
                );
                return;
              }

              const cost = parseFloat(kwMatch.keyword.bid_usdc);
              const consumed = await KeywordAdapter.tryConsumeImpression({
                keywordId: kwMatch.keyword.id,
                platform: "xmtp",
                sourceGroupId: ctx.conversation.id,
                userId: senderInboxId,
                matchedText: messageContent,
                costUsdc: cost,
              });
              if (consumed) {
                const inserted = await RecommendationAdapter.insert({
                  senderInboxId,
                  senderWalletAddress: wallet,
                  sourceGroupId: ctx.conversation.id,
                  targetGroupId: kwMatch.keyword.target_group_id,
                  targetGroupName: kwMatch.keyword.target_group_name ?? "Community",
                  targetGroupImageUrl: DISCOVERY_IMG,
                  score: Math.round((kwMatch.similarity ?? 1) * 100),
                  reasoning: `keyword:${kwMatch.matchType}`,
                  detectedInterests: [],
                });
                if (inserted) {
                  console.log(
                    `📣 Keyword ad queued: ${kwMatch.keyword.keyword} → ${kwMatch.keyword.target_group_name}`,
                  );
                  return;
                }
                console.warn(
                  `⚠️ Keyword spend without queue (duplicate?): ${kwMatch.keyword.id}`,
                );
                return;
              }
            }
          }

          const { scoreMessage } = await import("@/discovery/services/scorer.js");
          await scoreMessage({
            messageContent,
            senderInboxId,
            senderWalletAddress: wallet,
            sourceGroupId: ctx.conversation.id,
          });
        } catch (err: any) {
          console.error("⚠️ Scorer / keyword error:", err?.message || err);
        }
      })
      .catch(() => {});
  }

  /**
   * Mid perp wizard typed replies → DiscoveryAI.respond() with wizard context
   * instead of local number/symbol parsers (Phase 3).
   */
  private async tryHandlePerpWizardViaModel(
    ctx: MessageContext<string>,
    cleanContent: string,
    senderAddress: string,
  ): Promise<boolean> {
    const convId = ctx.conversation.id;
    const senderInboxId = ctx.message.senderInboxId;
    const pendingKey = pendingUserKey(senderInboxId, convId);

    const pendingPerp = await stateGet<PendingPerpInput>(XK.pendingPerpInput(pendingKey));
    let wizardCtx: PerpWizardContext | undefined;

    if (pendingPerp) {
      wizardCtx = {
        state: pendingPerp.state,
        awaiting: perpWizardAwaitingFromInputKind(pendingPerp.kind),
        constraints: {
          maxLev: pendingPerp.maxLev,
          minColl: pendingPerp.minColl,
          refPrice: pendingPerp.refPrice,
          tpslSide: pendingPerp.tpslSide,
        },
      };
    } else {
      const perpDraft = await stateGet<PerpState>(XK.activePerpWizard(pendingKey));
      if (perpDraft?.dir && !perpDraft.tok) {
        if (shouldAbandonPendingWizard(cleanContent, "perp_token")) {
          await stateDelete(XK.activePerpWizard(pendingKey));
          await stateDelete(XK.pendingActivityAt(pendingKey));
          logTextHandler({
            convId,
            inboxId: senderInboxId,
            pending: "perp",
            action: "wizard_abandon",
            msg: cleanContent,
          });
          return false;
        }
        wizardCtx = { state: perpDraft, awaiting: "token" };
      }
    }

    if (!wizardCtx || !cleanContent.trim()) return false;

    const profile = await PerpProfileAdapter.getProfile(senderInboxId);
    if (!PerpProfileAdapter.isComplete(profile)) {
      await stateDelete(XK.pendingPerpInput(pendingKey));
      await stateDelete(XK.activePerpWizard(pendingKey));
      if (!(await this.ensurePerpProfileOrRedirect(ctx))) return true;
      return true;
    }

    await stateDelete(XK.pendingPerpInput(pendingKey));
    await stateDelete(XK.activePerpWizard(pendingKey));

    logTextHandler({
      convId,
      inboxId: senderInboxId,
      pending: pendingPerp ? "perp_input" : "perp",
      action: "wizard_model_route",
      msg: cleanContent,
    });

    const resp = await this.ai.respond(cleanContent, {
      ...aiRespondCtx(ctx, senderAddress, cleanContent),
      perpWizard: wizardCtx,
    });
    await this.dispatchAiResponse(ctx as MessageContext<string>, resp, senderAddress);
    return true;
  }

  private async tryPendingIntercepts(
    ctx: MessageContext<string>,
    cleanContent: string,
  ): Promise<boolean> {
    const senderInboxId = ctx.message.senderInboxId;
    const convId = ctx.conversation.id;
    const pendingKey = pendingUserKey(senderInboxId, convId);
    if (await clearPendingIfExpired(pendingKey)) return false;

    const senderAddress = (await resolveSenderWalletAddress(ctx)) || "";

    // Explicit swap buys must not be hijacked by perp setup / wizard intercepts.
    if (parseSimpleUsdBuy(cleanContent)) {
      await stateDelete(XK.pendingPerpInput(pendingKey));
      await stateDelete(XK.activePerpWizard(pendingKey));
      return false;
    }

    const pendingBuy = await stateGet<{ tokenAddress: string; tokenSymbol: string; walletAddress: string }>(XK.pendingCustomBuy(pendingKey));
    if (pendingBuy) {
      const rawAmount = cleanContent.replace(/[^0-9.]/g, "").trim();
      const parsed = parseFloat(rawAmount);
      if (!isNaN(parsed) && parsed > 0 && parsed <= 10000) {
        await stateDelete(XK.pendingCustomBuy(pendingKey));
        await ctx.conversation.send(`Getting best price for $${pendingBuy.tokenSymbol}…`);
        const swap = await buildRoutedSwap(
          USDC_ADDRESS, "USDC", 6,
          pendingBuy.tokenAddress, pendingBuy.tokenSymbol,
          rawAmount,
          senderAddress,
        );
        if (!swap) {
          await ctx.conversation.send(
            `Couldn't build a swap for $${pendingBuy.tokenSymbol}. The token may not have a Uniswap pool yet.`
          );
        } else {
          await sendTrackedWalletCalls(
            ctx as MessageContext<string>,
            swap.calls,
            "0x2105",
            swap.label,
            senderAddress,
            undefined,
            swapProtocolVolume(
              swap.dex,
              parseFloat(rawAmount),
              pendingBuy.tokenSymbol,
            ),
          );
          invalidateBankrMarketStatsCache();
        }
        return true;
      }
      if (rawAmount) {
        await stateDelete(XK.pendingCustomBuy(pendingKey));
      }
    }

    const pendingSetup = await stateGet<{ state: PerpSetupState }>(XK.pendingPerpSetupInput(pendingKey));
    if (pendingSetup?.state.tier) {
      const numMatch = cleanContent.trim().replace(/^\$/, "").match(/^([0-9]*\.?[0-9]+)/);
      const parsed = numMatch ? parseFloat(numMatch[1]) : NaN;
      const minColl = minCollateralForTier(pendingSetup.state.tier);
      if (!isNaN(parsed) && parsed > 0) {
        if (parsed < minColl) {
          const lev = resolveLeverageForTier(
            pendingSetup.state.tier,
            PERP_SETUP_REFERENCE_MAX_LEVERAGE,
          );
          await ctx.conversation.send(
            `at your tier (${lev}x) margin must be at least $${minColl} for about $100 min notional — try $${minColl} or more`,
          );
          return true;
        }
        await stateDelete(XK.pendingPerpSetupInput(pendingKey));
        await this.finishPerpProfileSetup(
          ctx,
          pendingSetup.state.tier,
          String(parsed),
          pendingSetup.state.mode === "update",
          pendingSetup.state.backMenuId,
        );
        return true;
      }
      if (cleanContent.trim()) {
        await stateDelete(XK.pendingPerpSetupInput(pendingKey));
      }
    }

    const pendingDep = await stateGet<{ asset: string; protocol: "moonwell" | "morpho" | "aave" }>(XK.pendingCustomDeposit(pendingKey));
    if (pendingDep) {
      const trimmed = cleanContent.trim();
      const isUsd = trimmed.startsWith("$");
      const numMatch = trimmed.replace(/^\$/, "").match(/^([0-9]*\.?[0-9]+)/);
      const parsed = numMatch ? parseFloat(numMatch[1]) : NaN;

      // Detect "all", "max", "everything", or "all <TOKEN>" — resolve to actual balance.
      const isAllKeyword = /^(all|max|everything|all\s+\w+)$/i.test(trimmed);

      if (isAllKeyword && senderAddress) {
        await stateDelete(XK.pendingCustomDeposit(pendingKey));
        const verb =
          pendingDep.protocol === "moonwell" || pendingDep.protocol === "aave"
            ? "supply"
            : "deposit";
        const venue = pendingDep.protocol;
        let resolvedAmount: string | undefined;
        try {
          const token = await resolveTokenAsync(pendingDep.asset);
          if (token.resolved && token.address !== "ETH") {
            const balance = await fetchErc20TokenBalance(token.address, senderAddress, token.decimals);
            if (balance > 0) {
              resolvedAmount = String(parseFloat(balance.toPrecision(6)));
              console.log(`💰 "all" resolved to ${resolvedAmount} ${pendingDep.asset} for ${venue}`);
            }
          }
        } catch (err) {
          console.warn("⚠️ balance fetch for 'all' failed:", err);
        }
        const explicitMsg = resolvedAmount
          ? `${verb} ${resolvedAmount} ${pendingDep.asset} on ${venue}`
          : `${verb} ${pendingDep.asset} on ${venue}`;
        console.log(`🤖 Custom-deposit intercept (all) → "${explicitMsg}"`);
        const next = await this.ai.respond(explicitMsg, aiRespondCtx(ctx, senderAddress, explicitMsg));
        await this.dispatchAiResponse(ctx as MessageContext<string>, next, senderAddress);
        return true;
      }

      if (!isNaN(parsed) && parsed > 0) {
        await stateDelete(XK.pendingCustomDeposit(pendingKey));
        const verb =
          pendingDep.protocol === "moonwell" || pendingDep.protocol === "aave"
            ? "supply"
            : "deposit";
        const venue = pendingDep.protocol;
        const explicitMsg = isUsd
          ? `${verb} $${parsed} of ${pendingDep.asset} on ${venue}`
          : `${verb} ${parsed} ${pendingDep.asset} on ${venue}`;
        console.log(`🤖 Custom-deposit intercept → "${explicitMsg}"`);
        const next = await this.ai.respond(explicitMsg, aiRespondCtx(ctx, senderAddress, explicitMsg));
        await this.dispatchAiResponse(ctx as MessageContext<string>, next, senderAddress);
        return true;
      }
      if (trimmed) {
        await stateDelete(XK.pendingCustomDeposit(pendingKey));
      }
    }

    const improveFeedback = await stateGet<{ strategyId: string }>(XK.pendingImproveFeedback(pendingKey));
    if (improveFeedback) {
      await stateDelete(XK.pendingImproveFeedback(pendingKey));
      await ctx.conversation.send("paper trading and automated strategies are off.");
      return true;
    }

    const pendingTopUp = await stateGet<{ walletAddress: string }>(XK.pendingCustomPerpTopUp(pendingKey));
    if (pendingTopUp) {
      const trimmed = cleanContent.trim();
      const numMatch = trimmed.replace(/^\$/, "").match(/^([0-9]*\.?[0-9]+)/);
      const parsed = numMatch ? parseFloat(numMatch[1]!) : NaN;

      if (!isNaN(parsed) && parsed > 0) {
        await stateDelete(XK.pendingCustomPerpTopUp(pendingKey));
        await this.dispatchPerpTopUpSend(
          ctx as MessageContext<string>,
          pendingTopUp.walletAddress,
          "USDC",
          String(parsed),
        );
        return true;
      }
      if (trimmed) {
        await stateDelete(XK.pendingCustomPerpTopUp(pendingKey));
      }
    }

    if (pendingCustomYieldToken.has(pendingKey)) {
      const symbol = cleanContent.trim().replace(/^\$/, "").match(/^([A-Za-z][A-Za-z0-9]{1,11})$/)?.[1];
      if (symbol) {
        pendingCustomYieldToken.delete(pendingKey);
        await this.runYieldCompareForToken(ctx, symbol.toUpperCase());
        return true;
      }
      if (cleanContent.trim()) {
        pendingCustomYieldToken.delete(pendingKey);
      }
    }

    if (pendingStrategyPrompt.has(pendingKey)) {
      pendingStrategyPrompt.delete(pendingKey);
      await stateDelete(XK.lastStrategyPrompt(pendingKey));
      await ctx.conversation.send("paper trading and automated strategies are off.");
      return true;
    }

    if (await this.tryHandlePerpWizardViaModel(ctx, cleanContent, senderAddress)) {
      return true;
    }

    const pendingTpslUpd = await stateGet<PendingTpslUpdateInput>(XK.pendingTpslUpdateInput(pendingKey));
    if (pendingTpslUpd) {
      const numMatch = cleanContent.trim().replace(/^\$/, "").match(/^([0-9]*\.?[0-9]+)/);
      const parsed = numMatch ? parseFloat(numMatch[1]) : NaN;
      const isZero = parsed === 0;

      if (!isNaN(parsed) && (parsed > 0 || isZero)) {
        const ref = pendingTpslUpd.refPrice;
        const tpslKind = pendingTpslUpd.kind === "takeProfit" ? "tp" as const : "sl" as const;
        if (
          !isZero &&
          ref != null &&
          !isValidTpslPrice({
            price: parsed,
            refPrice: ref,
            side: pendingTpslUpd.state.side,
            kind: tpslKind,
          })
        ) {
          await ctx.conversation.send(tpslValidationHint(pendingTpslUpd.state.side, tpslKind));
          return true;
        }
        const priceText = normalizeTpslUserPrice(cleanContent.trim());
        await stateDelete(XK.pendingTpslUpdateInput(pendingKey));
        const stored = isZero ? "0" : (priceText ?? String(parsed));
        if (pendingTpslUpd.kind === "takeProfit") {
          await this.renderTpslUpdateStep(ctx, { ...pendingTpslUpd.state, tp: stored });
        } else {
          await this.renderTpslUpdateStep(ctx, { ...pendingTpslUpd.state, sl: stored });
        }
        return true;
      }
      if (cleanContent.trim()) {
        await stateDelete(XK.pendingTpslUpdateInput(pendingKey));
      }
    }

    const pendingCopy = await stateGet<CopyTradeContext>(XK.pendingCopyTradeAmount(pendingKey));
    if (pendingCopy) {
      const numMatch = cleanContent.trim().replace(/^\$/, "").match(/^([0-9]*\.?[0-9]+)/);
      const parsed = numMatch ? parseFloat(numMatch[1]) : NaN;
      if (!isNaN(parsed) && parsed > 0) {
        await stateDelete(XK.pendingCopyTradeAmount(pendingKey));
        await this.executeCopyTrade(ctx, pendingCopy, String(parsed));
        return true;
      }
      if (cleanContent.trim()) {
        await ctx.conversation.send("enter a valid USDC amount to copy the trade, e.g. 50");
      }
      return true;
    }

    return false;
  }

  private async handleUserMessage(
    ctx: MessageContext<string>,
    messageContent: string,
  ): Promise<EventResult> {
    try {
      const senderInboxId = ctx.message.senderInboxId;
      const isGroup = filter.isGroup(ctx.conversation);

      if (isGroup) {
        if (await isReplyToAgent(ctx)) {
          console.log("↩️ Reply to agent in group, will respond");
        } else {
          console.log("👋 Mentioned in group, will respond");
        }
      } else {
        console.log("💬 DM received, will respond");
      }

      const queueKey = pendingUserKey(senderInboxId, ctx.conversation.id);
      return runSerialized(queueKey, () =>
        this.processIncomingUserText(ctx, messageContent, senderInboxId, isGroup),
      );
    } catch (err) {
      console.error("❌ Error processing message:", err);
      return true;
    }
  }

  private async processIncomingUserText(
    ctx: MessageContext<string>,
    messageContent: string,
    senderInboxId: string,
    isGroup: boolean,
  ): Promise<EventResult> {
    try {
      const cleanContent = isGroup ? removeMention(messageContent) : messageContent;

      // Resolve once — used throughout this handler for both the AI context and tx signing.
      // resolveSenderWalletAddress tries: getSenderAddress() → inboxStateFromInboxIds(network) → members()
      const senderAddress = (await resolveSenderWalletAddress(ctx)) || "";
      if (senderAddress) {
        console.log(`🔑 Resolved sender wallet: ${senderAddress}`);
      } else {
        console.warn(`⚠️ Could not resolve wallet address for inboxId=${senderInboxId}`);
      }

      // Track user
      UserAdapter.incrementMessageCount({
        inboxId: senderInboxId,
        walletAddress: senderAddress,
        isGroup,
      }).catch(() => {});

      const convId = ctx.conversation.id;
      const pendingKey = pendingUserKey(senderInboxId, convId);
      clearPendingIfExpired(pendingKey);

      logTextHandler({
        convId,
        inboxId: senderInboxId,
        pending: await activePendingLabel(pendingKey),
        action: "ai",
        msg: cleanContent,
      });

      console.log(`🤖 Processing: "${cleanContent}"`);

      const existingSweep = await stateGet<{ destination: string; inboxId: string }>(XK.pendingSweepXmtp(pendingKey));
      if (existingSweep) {
        if (isCancelText(cleanContent)) {
          await stateDelete(XK.pendingSweepXmtp(pendingKey));
          await stateDelete(XK.pendingActivityAt(pendingKey));
          await sendAgentText(ctx, "okay, cancelled — nothing was submitted.");
          return true;
        }
        if (isConfirmText(cleanContent)) {
          await stateDelete(XK.pendingSweepXmtp(pendingKey));
          await stateDelete(XK.pendingActivityAt(pendingKey));
          const result = await sweepCustodialWallets({
            platform: "xmtp",
            userKey: existingSweep.inboxId,
            destination: existingSweep.destination,
          });
          await sendAgentText(ctx, formatSweepResult(result));
          return true;
        }
        await sendAgentText(ctx, 'reply "confirm" to run the sweep, or "cancel".');
        return true;
      }

      if (isSweepIntentText(cleanContent)) {
        const destination = extractDestinationAddress(cleanContent) ||
          (senderAddress && isAddress(senderAddress) ? getAddress(senderAddress) : null);
        if (!destination) {
          await sendAgentText(ctx, "where should i sweep the funds? send `sweep to 0x...` with the destination wallet.");
          return true;
        }
        const targets = await resolveCustodialSweepWallets({
          platform: "xmtp",
          userKey: senderInboxId,
        });
        if (targets.length === 0) {
          await sendAgentText(ctx, "i couldn't find any Basemate server wallets to sweep.");
          return true;
        }
        await stateSet(XK.pendingSweepXmtp(pendingKey), { destination, inboxId: senderInboxId });
        touchPending(pendingKey);
        await sendAgentText(ctx, formatSweepPreview(targets, destination));
        return true;
      }

      if (
        !hasPendingInteraction(pendingKey) &&
        !await stateHas(XK.pendingPerpSetupInput(pendingKey)) &&
        isMenuNavigationIntent(cleanContent)
      ) {
        await this.showCapabilitiesMenu(ctx);
        return true;
      }

      const aiStarted = Date.now();
      const linkedWallets = await resolveAllWalletsForUser(
        "xmtp",
        senderInboxId,
        senderAddress,
      );
      const aiResponse = await this.ai.respond(
        cleanContent,
        aiRespondCtx(ctx, senderAddress, messageContent, linkedWallets),
      );
      const preview = "text" in aiResponse && aiResponse.text ? aiResponse.text.slice(0, 80) : aiResponse.type;
      console.log(
        `🤖 AIResponse type=${aiResponse.type} (${Date.now() - aiStarted}ms): "${preview}..."`,
      );

      if (aiResponse.type === "communities" && aiResponse.groups.length > 0) {
        const joinActions: ActionsContent = {
          id: "ai_community_results",
          description: aiResponse.text,
          actions: aiResponse.groups.map((g) => ({
            id: `join_${g.group_id.slice(0, 8)}_group`,
            label: g.name.length > 25 ? g.name.slice(0, 22) + "..." : g.name,
            imageUrl: g.image_url || DISCOVERY_IMG,
            style: "primary" as const,
          })),
        };
        await sendActions(ctx.conversation, joinActions);
        return true;
      }

      if (aiResponse.type === "launches" && aiResponse.tokens.length > 0) {
        // Register buy and amount-selection action handlers for each token
        const msgId = ctx.message.id.slice(0, 8);
        const BUY_AMOUNTS = ["10", "25", "50", "100"];

        const buyActions = aiResponse.tokens.slice(0, 8).map((token: LaunchToken) => {
          const tokenKey = `${token.symbol.toLowerCase()}_${msgId}`;

          // Register per-amount swap handlers for this token
          BUY_AMOUNTS.forEach((amount) => {
            const amtActionId = `amt_${amount}_${tokenKey}`;
            registerAction(amtActionId, async (actionCtx: MessageContext) => {
              if (!token.address || token.address === "unknown") {
                await actionCtx.conversation.send(
                  `${token.symbol} doesn't have a verified contract address yet — can't build the swap.`
                );
                return;
              }

              const buyerAddress = (await resolveSenderWalletAddress(actionCtx as any)) || "";
              await actionCtx.conversation.send(`Getting best price for ${token.symbol}…`);

              const swap = await buildRoutedSwap(
                USDC_ADDRESS, "USDC", 6,
                token.address, token.symbol,
                amount,
                buyerAddress,
              );

              if (!swap) {
                await actionCtx.conversation.send(
                  `Couldn't build a swap for ${token.symbol}. The token may not have a Uniswap pool yet.`
                );
                return;
              }

          await sendTrackedWalletCalls(
            actionCtx as MessageContext<string>,
            swap.calls,
            "0x2105",
            swap.label,
            buyerAddress,
            undefined,
            swapProtocolVolume(swap.dex, parseFloat(amount), token.symbol),
          );
          invalidateBankrMarketStatsCache();
            });
          });

          // Register the "Custom" amount handler — prompts user to type a number
          const customActionId = `amt_custom_${tokenKey}`;
          registerAction(customActionId, async (actionCtx: MessageContext) => {
            const buyerAddr = (await resolveSenderWalletAddress(actionCtx as any)) || "";
            await stateSet(XK.pendingCustomBuy(
            pendingUserKey(actionCtx.message.senderInboxId, actionCtx.conversation.id)),
              {
              tokenAddress: token.address,
              tokenSymbol: token.symbol,
              walletAddress: buyerAddr,
            });
            await actionCtx.conversation.send(
              `How much USDC do you want to spend on ${token.symbol}? Reply with a number (e.g. 50)`
            );
          });

          // Register the "Buy $TOKEN" button — shows amount options instead of swapping immediately
          const buyActionId = `buy_${tokenKey}`;
          registerAction(buyActionId, async (actionCtx: MessageContext) => {
            const amountMenu: ActionsContent = {
              id: `buy_amt_${tokenKey}`,
              description: `How much USDC to buy ${token.symbol}? (Actual fill may be lower for thin pools)`,
              actions: [
                ...BUY_AMOUNTS.map((amount) => ({
                  id: `amt_${amount}_${tokenKey}`,
                  label: `${amount}`,
                  style: "primary" as const,
                })),
                {
                  id: customActionId,
                  label: "✏️ Custom",
                  style: "secondary" as const,
                },
              ],
            };
            await sendActions(actionCtx.conversation, amountMenu);
          });

          const pct =
            token.priceChange24h != null
              ? `${token.priceChange24h >= 0 ? "+" : ""}${Math.abs(token.priceChange24h) >= 100 ? token.priceChange24h.toFixed(0) : token.priceChange24h.toFixed(1)}%`
              : null;
          const label = pct
            ? `${token.symbol.toUpperCase()} ${pct}`
            : `Buy ${token.symbol.toUpperCase()}`;

          return {
            id: buyActionId,
            label: label.length > 50 ? `Buy ${token.symbol.toUpperCase()}` : label,
            style: "primary" as const,
          };
        });

        const menu: ActionsContent = {
          id: `bankr_buy_${msgId}`,
          description: aiResponse.text,
          actions: buyActions,
        };
        await sendActions(ctx.conversation, menu);
        return true;
      }

      if (aiResponse.type === "transaction") {
        await dispatchAvantisTransaction(ctx, aiResponse, senderAddress);
        return true;
      }

      if (aiResponse.type === "disambiguate") {
        await this.renderYieldDisambiguate(ctx, aiResponse);
        return true;
      }

      if (aiResponse.type === "amount_select") {
        await this.renderAmountSelect(ctx, aiResponse);
        return true;
      }

      if (aiResponse.type === "perp_guide") {
        await this.dispatchAiResponse(ctx as MessageContext<string>, aiResponse, senderAddress);
        return true;
      }

      if (aiResponse.type === "perp_min_fix") {
        await this.renderPerpMinFix(ctx, aiResponse);
        return true;
      }

      if (aiResponse.type === "perp_setup_redirect") {
        await this.dispatchAiResponse(ctx as MessageContext<string>, aiResponse, senderAddress);
        return true;
      }

      if (aiResponse.type === "tpsl_update_guide") {
        if (aiResponse.text) await ctx.conversation.send(aiResponse.text);
        await this.renderTpslUpdateStep(ctx, {
          ...aiResponse.state,
          ownerInboxId: aiResponse.state.ownerInboxId ?? ctx.message.senderInboxId,
        });
        return true;
      }

      if (aiResponse.type === "launch_guide") {
        await this.renderLaunchStep(ctx, aiResponse.state);
        return true;
      }

      if (aiResponse.type === "worldcup_matches" || aiResponse.type === "worldcup_bet_wizard") {
        const wc = getWorldCupRenderer();
        if (wc) {
          await dispatchWorldCupAiResponse(
            ctx as MessageContext<string>,
            aiResponse,
            wc,
          );
          return true;
        }
      }

      if (aiResponse.type === "approve") {
        await ctx.conversation.send(`${aiResponse.text}\n\n${aiResponse.approveUrl}`);
        return true;
      }

      if (aiResponse.type === "menu") {
        await this.showCapabilitiesMenu(ctx, aiResponse.description);
        return true;
      }

      if (aiResponse.type === "pnl_card_ready" || aiResponse.type === "pnl_position_picker") {
        await this.dispatchAiResponse(ctx as MessageContext<string>, aiResponse, senderAddress);
        return true;
      }

      if (aiResponse.type === "markdown") {
        await sendMarkdownOrText(ctx, aiResponse.text);
        return true;
      }

      if (aiResponse.type === "wallet_info") {
        await sendAgentText(ctx, aiResponse.text);
        await ctx.conversation.send(aiResponse.address);
        if (aiResponse.portfolioViewUrl) {
          await sendMarkdownOrText(ctx, formatPortfolioViewMarkdown(aiResponse.portfolioViewUrl));
        }
        return true;
      }

      if (aiResponse.type === "text") {
        await this.sendTextMaybeMenu(ctx, aiResponse);
        return true;
      }

      // communities with empty groups / other text-like fallbacks
      if ("text" in aiResponse && aiResponse.text) {
        await sendAgentText(ctx, aiResponse.text);
      }
      return true;
    } catch (err) {
      console.error("❌ Error processing message:", err);
      return true;
    }
  }

  onReply = async (ctx: MessageContext<any>): Promise<EventResult> => {
    try {
      const text = extractReplyText(ctx);
      if (!text.trim()) return false;

      const isGroup = filter.isGroup(ctx.conversation);

      if (isGroup && !(await shouldEngageInGroup(ctx, text))) {
        console.log("↩️ Reply ignored — parent message is not from the agent");
        this.trackNonEngagedGroupMessage(ctx as MessageContext<string>, text);
        return;
      }

      console.log(`↩️ Reply engaged: "${text.trim()}"`);

      return this.processEngagedMessage(ctx as MessageContext<string>, text);
    } catch (err) {
      console.error("❌ Error processing reply:", err);
      return true;
    }
  };

  /** Launch wizard + pending flows + AI — only after group mention/reply gate passes. */
  private async processEngagedMessage(
    ctx: MessageContext<string>,
    messageContent: string,
  ): Promise<EventResult> {
    const senderInboxId = ctx.message.senderInboxId;
    const isGroup = filter.isGroup(ctx.conversation);
    const cleanContent = isGroup ? removeMention(messageContent) : messageContent;
    const pendingKey = pendingUserKey(senderInboxId, ctx.conversation.id);

    if (await this.tryHandlePendingLaunchText(ctx, pendingKey, cleanContent)) {
      return true;
    }

    if (await this.tryPendingIntercepts(ctx, cleanContent)) {
      return true;
    }

    // Detect compound swap+deposit intent (e.g. "swap USDC to MXNB and stake on Morpho").
    // Store the follow-up deposit action so it runs automatically after the swap confirms.
    const compound = detectCompoundSwapDeposit(cleanContent);
    if (compound) {
      await stateSet(XK.pendingPostTxActionXmtp(ctx.conversation.id), {
        toAsset: compound.toAsset,
        protocol: compound.protocol,
        inboxId: senderInboxId,
      });
      console.log(
        `🔗 Compound intent detected: swap → ${compound.toAsset}, then deposit on ${compound.protocol}`,
      );
    }

    return this.handleUserMessage(ctx, messageContent);
  }

  async onText(ctx: MessageContext<string>): Promise<EventResult> {
    try {
      const messageContent = ctx.message.content;
      const isGroup = filter.isGroup(ctx.conversation);

      // Base App often delivers transactionReference as JSON text (onMessage skips text).
      const ref = parseTransactionReference(messageContent);
      if (ref?.networkId.toLowerCase() === BASE_NETWORK_ID) {
        try {
          const { tryConfirmDepositFromTx } = await import("@/worldcup/deposit.js");
          const wcHandled = await tryConfirmDepositFromTx({
            conversationId: ctx.conversation.id,
            txHash: ref.txHash,
            fromAddress: ref.fromAddress,
          });
          if (wcHandled) {
            console.log(
              `⚽ World Cup deposit confirmed via text transactionReference (${ref.txHash.slice(0, 10)}…)`,
            );
            return true;
          }
        } catch (err) {
          console.warn("⚠️ World Cup text transactionReference handler failed:", err);
        }

        await this.handleSignedTransactionReference(ctx, ref);
        return true;
      }

      const txFromUrl = messageContent.match(TX_HASH_FROM_URL_RE)?.[1];
      if (txFromUrl) {
        const wallet = await resolveSenderWalletAddress(ctx as any);
        await this.handleSignedTransactionReference(ctx, {
          txHash: txFromUrl as ParsedTransactionReference["txHash"],
          fromAddress: wallet ? (wallet as ParsedTransactionReference["fromAddress"]) : null,
          networkId: BASE_NETWORK_ID,
        });
        return true;
      }

      if (isGroup && !(await shouldEngageInGroup(ctx, messageContent))) {
        this.trackNonEngagedGroupMessage(ctx, messageContent);
        return;
      }

      return this.processEngagedMessage(ctx, messageContent);
    } catch (err) {
      console.error("❌ Error processing message:", err);
      return true;
    }
  }

  private async showCapabilitiesMenu(
    ctx: MessageContext,
    description?: string,
  ): Promise<void> {
    if (!this.capabilitiesConfig) {
      console.warn("⚠️ capabilities menu unavailable — config not initialized");
      return;
    }
    await showMenu(ctx, this.capabilitiesConfig, "main-menu", description);
    console.log("📋 Capabilities menu sent");
  }

  private async sendTextMaybeMenu(
    ctx: MessageContext,
    resp: Extract<AIResponse, { type: "text" }>,
  ): Promise<void> {
    await sendTextWithPortfolioLink(ctx, resp.text, resp.portfolioViewUrl);
  }

  private async runTrendingTokens(ctx: MessageContext): Promise<void> {
    const senderAddr = (await resolveSenderWalletAddress(ctx as any)) || "";
    const resp = await this.ai.runTrendingTokens(
      aiRespondCtx(ctx as MessageContext<string>, senderAddr, "trending"),
    );
    await this.dispatchAiResponse(ctx as MessageContext<string>, resp, senderAddr);
  }

  private async runYieldCompareForToken(
    ctx: MessageContext,
    token: string,
  ): Promise<void> {
    const senderAddr = (await resolveSenderWalletAddress(ctx as any)) || "";
    const resp = await this.ai.runYieldCompare(
      token,
      aiRespondCtx(ctx as MessageContext<string>, senderAddr, `earn on ${token}`),
    );
    await this.dispatchAiResponse(ctx as MessageContext<string>, resp, senderAddr);
  }

  private async startYieldComparePicker(ctx: MessageContext): Promise<void> {
    const msgId = ctx.message.id.slice(0, 8);
    const picks = [
      { label: "USDC", token: "USDC" },
      { label: "ETH", token: "WETH" },
      { label: "cbBTC", token: "cbBTC" },
    ] as const;

    const actions = picks.map(({ label, token }) => {
      const id = `yield_tok_${token.toLowerCase()}_${msgId}`;
      registerAction(id, async (actionCtx: MessageContext) => {
        await this.runYieldCompareForToken(actionCtx, token);
      });
      return { id, label, style: "primary" as const };
    });

    const otherId = `yield_tok_other_${msgId}`;
    registerAction(otherId, async (actionCtx: MessageContext) => {
      const pendingKey = pendingUserKey(
        actionCtx.message.senderInboxId,
        actionCtx.conversation.id,
      );
      pendingCustomYieldToken.add(pendingKey);
      touchPending(pendingKey);
      await actionCtx.conversation.send(
        "reply with a token symbol — e.g. AERO, MAMO, WETH",
      );
    });

    await sendActions(ctx.conversation, {
      id: `yield_pick_${msgId}`,
      description: "which token do you want to compare yield for?",
      actions: [
        ...actions,
        { id: otherId, label: "✏️ Other", style: "secondary" as const },
      ],
    });
  }

  private async renderYieldDisambiguate(
    ctx: MessageContext<string>,
    aiResponse: Extract<AIResponse, { type: "disambiguate" }>,
  ): Promise<void> {
    const { token, amountToken, options, text } = aiResponse;
    const msgId = ctx.message.id.slice(0, 8);

    const actionButtons = options.map((opt) => {
      const actionId = `dis_${opt.protocol}_${token.toLowerCase()}_${msgId}`;

      const handler: ActionHandler = async (actionCtx: MessageContext) => {
        const senderAddr = (await resolveSenderWalletAddress(actionCtx as any)) || "";
        const amtPrefix = amountToken ? `${amountToken} ` : "";
        const explicitMsg =
          opt.protocol === "moonwell"
            ? `supply ${amtPrefix}${token} on moonwell`
            : opt.protocol === "morpho"
              ? `deposit ${amtPrefix}${token} to morpho`
              : opt.protocol === "aave"
                ? `supply ${amtPrefix}${token} on aave`
                : `add ${amtPrefix}${token} liquidity on aerodrome`;

        const resp = await this.ai.respond(
          explicitMsg,
          aiRespondCtx(actionCtx as MessageContext<string>, senderAddr, explicitMsg),
        );

        await this.dispatchAiResponse(actionCtx as MessageContext<string>, resp, senderAddr);
      };

      registerAction(actionId, handler);

      const label = opt.label.length > 50 ? opt.label.slice(0, 47) + "..." : opt.label;
      return { id: actionId, label, style: "primary" as const };
    });

    await sendActions(ctx.conversation, {
      id: `yield_cmp_${msgId}`,
      description: text,
      actions: actionButtons,
    });
  }

  /**
   * Render an `amount_select` response — inline action buttons for preset USD
   * amounts plus a hint that custom token amounts can still be typed. Tapping
   * a preset sends a fully-specified message back through `ai.respond()` and
   * the result is dispatched recursively via `dispatchAiResponse`.
   */
  private async renderAmountSelect(
    ctx: MessageContext<string>,
    resp: Extract<AIResponse, { type: "amount_select" }>,
  ): Promise<void> {
    const { asset, protocol, presetsUsd, text } = resp;
    const msgId = ctx.message.id.slice(0, 8);

    const buttons = presetsUsd.map((usd) => {
      const actionId = `amt_${protocol}_${asset.toLowerCase()}_${usd}_${msgId}`;

      const handler: ActionHandler = async (actionCtx: MessageContext) => {
        const senderAddr = (await resolveSenderWalletAddress(actionCtx as any)) || "";
        // Re-enter the prepare tool with a USD-quoted amount. The AI prompt
        // already routes "$N of X on PROTOCOL" correctly with isUsd=true.
        const explicitMsg =
          protocol === "moonwell"
            ? `supply $${usd} of ${asset} on moonwell`
            : protocol === "morpho"
              ? `deposit $${usd} of ${asset} on morpho`
              : `supply $${usd} of ${asset} on aave`;

        const next = await this.ai.respond(
          explicitMsg,
          aiRespondCtx(actionCtx as MessageContext<string>, senderAddr, explicitMsg),
        );

        await this.dispatchAiResponse(actionCtx as MessageContext<string>, next, senderAddr);
      };

      registerAction(actionId, handler);
      return { id: actionId, label: `$${usd}`, style: "primary" as const };
    });

    // ── Custom amount button ────────────────────────────────────────────────
    // Sets a pending entry keyed by conversationId; the next plain-text
    // message is intercepted at the top of onText and routed back through
    // the prepare tool. Supports both USD ("$5") and token ("0.01 WETH")
    // entries so the user picks their preferred denomination.
    const customActionId = `amt_${protocol}_${asset.toLowerCase()}_custom_${msgId}`;
    registerAction(customActionId, async (actionCtx: MessageContext) => {
      await stateSet(XK.pendingCustomDeposit(
            pendingUserKey(actionCtx.message.senderInboxId, actionCtx.conversation.id)),
        { asset, protocol },
      );
      const verb = protocol === "moonwell" || protocol === "aave" ? "supply" : "deposit";
      await actionCtx.conversation.send(
        `how much do you want to ${verb}? ` +
          `reply with a dollar amount (e.g. "$5") or a token amount (e.g. "0.01 ${asset}")`,
      );
    });

    await sendActions(ctx.conversation, {
      id: `amt_sel_${msgId}`,
      description: text,
      actions: [
        ...buttons,
        { id: customActionId, label: "✏️ Custom", style: "secondary" as const },
      ],
    });
  }

  /**
   * Inline-action menu for TP or SL: % presets from reference price, plus No TP/SL and Custom.
   */
  private async renderTpslPresetMenu(
    ctx: MessageContext,
    opts: {
      kind: "tp" | "sl";
      refPrice: number | null;
      side: "long" | "short";
      symbol: string;
      msgId: string;
      menuIdPrefix: string;
      guardState?: PerpState | TpslUpdateGuideState;
      guardKind?: "perp" | "tpsl_update";
      onPick: (price: string) => Promise<void>;
      onCustom: () => Promise<void>;
    },
  ): Promise<void> {
    return perpRenderTpslPresetMenu(this, ctx, opts);
  }

  /**
   * Render the guided Avantis perp wizard one step at a time. Given the state
   * carried so far, it renders only the FIRST missing field (direction → token
   * → leverage → amount) as an inline-action menu. Each button advances the
   * state and re-enters this same method; once all four fields are known it
   * builds the trade. The minimum position-size threshold is enforced at the
   * leverage and amount steps so the final trade always clears it.
   */
  async startPerpWizard(ctx: MessageContext): Promise<void> {
    return perpStartPerpWizard(this, ctx);
  }

  /** PerpMate menu -> "Prompt a Strategy": arm free-text capture for the next message (DM only). */
  private async startPromptStrategy(ctx: MessageContext): Promise<void> {
    return stratStartPromptStrategy(this, ctx);
  }

  private async sendPromptStrategyDm(ctx: MessageContext, inboxId: string): Promise<void> {
    return stratSendPromptStrategyDm(this, ctx, inboxId);
  }

  private async armPromptStrategyOnConversation(
    conversation: Parameters<typeof sendActions>[0],
    inboxId: string,
    messageId: string,
  ): Promise<void> {
    return stratArmPromptStrategyOnConversation(this, conversation, inboxId, messageId);
  }

  /** Clear strategy authoring state and return to PerpMate menu. */
  private async cancelStrategyPrompt(ctx: MessageContext): Promise<void> {
    return stratCancelStrategyPrompt(this, ctx);
  }

  /** Inline ← Back action that returns to the PerpMate menu. */
  async sendPerpBackActions(
    ctx: MessageContext,
    description = "what's next?",
    suffix = "",
  ): Promise<void> {
    return perpSendPerpBackActions(this, ctx, description, suffix);
  }

  private registerPerpBackAction(backId: string): void {
    registerAction(backId, async (actionCtx: MessageContext) => {
      if (this.capabilitiesConfig) {
        await showMenu(actionCtx, this.capabilitiesConfig, "menu_perps");
      }
    });
  }

  private registerSetupBackAction(
    backMenuId: PerpSetupState["backMenuId"],
    backId: string,
  ): { id: string; label: string; style: "secondary" } | null {
    if (!backMenuId || !this.capabilitiesConfig) return null;
    registerAction(backId, async (actionCtx: MessageContext) => {
      if (this.capabilitiesConfig) {
        await showMenu(actionCtx, this.capabilitiesConfig, backMenuId);
      }
    });
    return { id: backId, label: "← Back", style: "secondary" };
  }


  /** VibeTrading menu → My Strategies. Paper trading and live strategies as separate sections. */
  private async listOpenStrategies(ctx: MessageContext): Promise<void> {
    return stratListOpenStrategies(this, ctx);
  }

  private async closeOpenPosition(
    ctx: MessageContext,
    inboxId: string,
    target: AvantisPositionWalletTarget,
    trade: AvantisUserTrade,
  ): Promise<void> {
    return perpCloseOpenPosition(this, ctx, inboxId, target, trade);
  }

  private async showOpenPositionDetail(
    ctx: MessageContext,
    inboxId: string,
    item: {
      target: AvantisPositionWalletTarget;
      trade: AvantisUserTrade;
      attribution?: StrategyTradeAttribution;
    },
  ): Promise<void> {
    return perpShowOpenPositionDetail(this, ctx, inboxId, item);
  }

  /** PerpMate menu → open Avantis positions with one-tap close buttons. */
  private async listOpenPositions(ctx: MessageContext): Promise<void> {
    return perpListOpenPositions(this, ctx);
  }

  /** Send USDC/ETH from the user's Base wallet to their perp server wallet. */
  private async dispatchPerpTopUpSend(
    ctx: MessageContext,
    walletAddress: string,
    asset: "USDC" | "ETH",
    amount: string,
  ): Promise<void> {
    return perpDispatchPerpTopUpSend(this, ctx, walletAddress, asset, amount);
  }

  /** $25 USDC + $1 ETH (gas) in one wallet_sendCalls. */
  private async dispatchPerpTopUpBundle(
    ctx: MessageContext,
    walletAddress: string,
  ): Promise<void> {
    return perpDispatchPerpTopUpBundle(this, ctx, walletAddress);
  }

  /** Base App: preset buttons to send USDC/ETH from the user's wallet to the perp wallet. */
  async renderPerpWalletTopUp(
    ctx: MessageContext,
    walletAddress: string,
  ): Promise<void> {
    return perpRenderPerpWalletTopUp(this, ctx, walletAddress);
  }

  /** PerpMate menu → server wallet USDC balance + unrealized PnL summary. */
  private async showServerWalletBalance(ctx: MessageContext): Promise<void> {
    return perpShowServerWalletBalance(this, ctx);
  }

  /**
   * Cashout liquid USDC + ETH from the Basemate server wallet to the user's Base
   * App wallet. Blocks if open Avantis positions exist — user must close those in
   * Live Positions first (we never auto-close to fund a cashout).
   */
  private async renderPerpWalletCashout(
    ctx: MessageContext,
    walletName: string,
    walletAddress: string,
  ): Promise<void> {
    return perpRenderPerpWalletCashout(this, ctx, walletName, walletAddress);
  }

  private async showStrategyDetail(ctx: MessageContext, row: StrategyRow): Promise<void> {
    return stratShowStrategyDetail(this, ctx, row);
  }

  /**
   * Paper-strategy detail actions. Go Live checks the Basemate server wallet's USDC:
   * funded → "Go Live" (promote to real trading); unfunded → "Go live with USDC"
   * (routes to top-up first). OFF stops the paper run.
   */
  private async sendPaperStrategyActions(
    ctx: MessageContext,
    row: StrategyRow,
    shortId: string,
    msgId: string,
  ): Promise<void> {
    return stratSendPaperStrategyActions(this, ctx, row, shortId, msgId);
  }

  private async formatStrategyDetailLines(row: StrategyRow): Promise<string[]> {
    return stratFormatStrategyDetailLines(row);
  }

  /**
   * Run the Opus authoring flow on a free-text prompt: elevate -> clamp ->
   * persist a draft -> explain it back. Re-arms capture so the user can refine
   * ("riskier", "eth only") or say it's good to lock it in. Never throws.
   */
  private async runPromptStrategy(
    ctx: MessageContext,
    message: string,
    senderAddr: string,
  ): Promise<void> {
    return stratRunPromptStrategy(this, ctx, message, senderAddr);
  }

  /**
   * Sequential decision chain for a freshly authored strategy:
   *   1. exit recommendation (keep yours / use safe)  — optional, shown first
   *   2. min-notional fix (keep leverage / keep margin) — mandatory
   *   3. capability confirm (build it / tweak it)      — only when nothing else to decide
   *   4. final card
   * Mandatory limits (can't-read conditions, reinterpretations) ride along as
   * context on whichever card shows first, then are suppressed via infoShown.
   */
  private async presentBuiltStrategy(
    ctx: MessageContext,
    draftId: string | null,
    prompt: string,
    authored: AuthoredStrategy,
    opts: { resolvedExits?: "keep" | "recommend"; infoShown?: boolean } = {},
  ): Promise<void> {
    return stratPresentBuiltStrategy(this, ctx, draftId, prompt, authored, opts);
  }

  /** Mandatory capability context (can't-read conditions, reinterpretations) as bullet lines. */
  private capabilityInfoLines(authored: AuthoredStrategy): string[] {
    return stratCapabilityInfoLines(authored);
  }

  /**
   * Re-finalize with the user's resolved choices, persist, and render the final
   * card (spec, behavior notes, exit note, explanation) + actions.
   */
  private async renderFinalStrategyCard(
    ctx: MessageContext,
    strategyId: string | null,
    prompt: string,
    authored: AuthoredStrategy,
    resolveOpts: {
      resolveExits?: "keep" | "recommend";
      resolveChoice?: "keepLeverage" | "keepMargin";
    },
  ): Promise<void> {
    return stratRenderFinalStrategyCard(this, ctx, strategyId, prompt, authored, resolveOpts);
  }

  /**
   * Exit recommendation fork: the user's stated TP/SL differ from the
   * leverage-safe band. Offer to keep their exact exits (honored within absolute
   * rails) or take our tighter recommendation. Nothing is applied until they pick.
   */
  private async sendExitChoice(
    ctx: MessageContext,
    strategyId: string,
    prompt: string,
    authored: AuthoredStrategy,
    infoLines: string[],
  ): Promise<void> {
    return stratSendExitChoice(this, ctx, strategyId, prompt, authored, infoLines);
  }

  /**
   * Min-notional fork: the position is below Avantis's ~$100 minimum and the
   * user stated explicit sizing. Ask which fix they want — never silently bump.
   * Threads through any already-resolved exit choice so the final card is correct.
   */
  private async sendMinNotionalChoice(
    ctx: MessageContext,
    strategyId: string,
    prompt: string,
    authored: AuthoredStrategy,
    opts: { resolvedExits?: "keep" | "recommend"; infoLines?: string[] } = {},
  ): Promise<void> {
    return stratSendMinNotionalChoice(this, ctx, strategyId, prompt, authored, opts);
  }

  /**
   * Capability confirm: nothing numeric to decide, but there ARE hard limits
   * (can't-read conditions / a reinterpretation). Show them and ask to proceed.
   */
  private async sendCapabilityConfirm(
    ctx: MessageContext,
    strategyId: string,
    prompt: string,
    authored: AuthoredStrategy,
    infoLines: string[],
    resolvedExits?: "keep" | "recommend",
  ): Promise<void> {
    return stratSendCapabilityConfirm(this, ctx, strategyId, prompt, authored, infoLines, resolvedExits);
  }

  /**
   * Data-driven Improve: read the strategy's wiki (compiled from real trades),
   * have Opus diagnose what went wrong and propose a targeted config tweak, then
   * present it as a fresh draft. Unlike Remix, this reasons from actual trade
   * outcomes — not a text prompt. An optional observation steers the analysis.
   */
  /**
   * Remix on a traded strategy: tell the user we'll learn from its trade wiki,
   * and ask for their own direction to combine with it. Their next message is
   * captured (pendingImproveFeedback) and fed into the wiki analysis. A "Use wiki
   * only" button lets them skip giving direction and let the agent decide.
   */
  private async startWikiRemix(ctx: MessageContext, strategy: StrategyRow): Promise<void> {
    return stratStartWikiRemix(this, ctx, strategy);
  }

  private async runImproveStrategy(
    ctx: MessageContext,
    strategy: StrategyRow,
    senderAddr: string,
    observation?: string,
  ): Promise<void> {
    return stratRunImproveStrategy(this, ctx, strategy, senderAddr, observation);
  }

  private async runImproveStrategyInner(
    ctx: MessageContext,
    strategy: StrategyRow,
    senderAddr: string,
    observation?: string,
  ): Promise<void> {
    return stratRunImproveStrategyInner(this, ctx, strategy, senderAddr, observation);
  }

  /**
   * Apply / keep buttons for an Improve proposal. Apply updates the EXISTING
   * strategy's config in place (same id) and bumps a visible version on its name
   * so the change is obviously live — it never creates a new strategy.
   */
  private async sendImproveActions(
    ctx: MessageContext,
    strategyId: string,
    versionedName: string,
    newConfig: StrategyConfig,
    changes: string[],
  ): Promise<void> {
    return stratSendImproveActions(this, ctx, strategyId, versionedName, newConfig, changes);
  }

  /** Execute + Build-another buttons shown under a finished strategy. */
  private async sendStrategyActions(
    ctx: MessageContext,
    strategyId: string | null,
    name: string,
  ): Promise<void> {
    return stratSendStrategyActions(this, ctx, strategyId, name);
  }

  /** Main menu → Say Less tier + default margin wizard. */
  private async startSayLess(ctx: MessageContext): Promise<void> {
    return perpStartSayLess(this, ctx);
  }

  /** Change tier + default margin (DM wizard; groups get a DM). */
  private async startPerpSettingsUpdate(
    ctx: MessageContext,
    initial: Partial<PerpSetupState> = {},
  ): Promise<void> {
    return perpStartPerpSettingsUpdate(this, ctx, initial);
  }

  private async ensurePerpProfileOrRedirect(ctx: MessageContext): Promise<boolean> {
    return perpEnsurePerpProfileOrRedirect(this, ctx);
  }

  private async sendPerpSetupDm(
    ctx: MessageContext,
    inboxId: string,
    state: PerpSetupState = {},
  ): Promise<void> {
    return perpSendPerpSetupDm(this, ctx, inboxId, state);
  }

  private async renderPerpSetupStep(ctx: MessageContext, state: PerpSetupState): Promise<void> {
    return perpRenderPerpSetupStep(this, ctx, state);
  }

  private async renderPerpSetupOnConversation(
    conversation: Parameters<typeof sendActions>[0],
    ownerInboxId: string,
    _client: MessageContext["client"],
    messageId: string,
    state: PerpSetupState,
  ): Promise<void> {
    return perpRenderPerpSetupOnConversation(this, conversation, ownerInboxId, _client, messageId, state);
  }

  private async finishPerpProfileSetup(
    ctx: MessageContext,
    tier: PerpRiskTier,
    collateral: string,
    isUpdate = false,
    backMenuId?: PerpSetupState["backMenuId"],
  ): Promise<void> {
    return perpFinishPerpProfileSetup(this, ctx, tier, collateral, isUpdate, backMenuId);
  }

  private async renderPerpStep(ctx: MessageContext, state: PerpState): Promise<void> {
    return perpRenderPerpStep(this, ctx, state);
  }

  /**
   * Finalize the wizard by building Avantis calldata directly from carried
   * state. This avoids a second model pass reinterpreting a limit setup as a
   * market order after the user has already confirmed the wizard fields.
   */
  private async buildPerpTrade(
    ctx: MessageContext,
    state: PerpState,
    profile?: PerpProfile | null,
  ): Promise<void> {
    return perpBuildPerpTrade(this, ctx, state, profile);
  }

  private async submitAvantisPerpTrade(
    ctx: MessageContext,
    senderAddr: string,
    trade: PerpMinFixTrade,
  ): Promise<void> {
    return perpSubmitAvantisPerpTrade(this, ctx, senderAddr, trade);
  }

  private async renderPerpMinFix(
    ctx: MessageContext,
    fix: Extract<AIResponse, { type: "perp_min_fix" }>,
  ): Promise<void> {
    return perpRenderPerpMinFix(this, ctx, fix);
  }

  /** Button wizard to set TP/SL on an existing open Avantis position. */
  private async renderTpslUpdateStep(
    ctx: MessageContext,
    state: TpslUpdateGuideState,
  ): Promise<void> {
    return perpRenderTpslUpdateStep(this, ctx, state);
  }

  private async submitTpslUpdate(
    ctx: MessageContext,
    state: TpslUpdateGuideState,
  ): Promise<void> {
    return perpSubmitTpslUpdate(this, ctx, state);
  }

  /**
   * Plain-text steps for the launch wizard (name, ticker, image skip).
   * Only reached after the group @mention or quote-reply gate in onText/onReply.
   */
  private async tryHandlePendingLaunchText(
    ctx: MessageContext<string>,
    pendingKey: string,
    rawContent: string,
  ): Promise<boolean> {
    return launchTryHandleText(this.launchDeps, ctx, pendingKey, rawContent);
  }

  /**
   * Render the guided token-launch wizard one step at a time. Given the state
   * so far, it renders only the FIRST missing field (name → ticker → image).
   * When complete it shows a review + "🚀 Launch" confirm. NOTHING deploys until
   * confirm — deployment runs in executeLaunch (optional image URL for Bankr).
   */
  private async renderLaunchStep(ctx: MessageContext, state: LaunchState): Promise<void> {
    return launchRenderStep(this.launchDeps, ctx, state);
  }

  private async showNewPairs(ctx: MessageContext): Promise<void> {
    const { listStockTokens } = await import("@/discovery/doppler/stockRegistry.js");
    const stocks = listStockTokens();
    if (stocks.length === 0) {
      await ctx.conversation.send(
        "new B20 / stock pairs will show up here once Coinbase equity tokens are configured — set STOCK_TOKENS_JSON, then launch from the menu",
      );
      return;
    }
    const lines = stocks.map((s) => `• $${s.symbol}${s.name ? ` — ${s.name}` : ""}`).join("\n");
    await ctx.conversation.send(
      `live Coinbase B20 stocks you can pair against:\n\n${lines}\n\n` +
        `tap Launch to create a B20 token and seed a Uniswap V4 pool against one of these.`,
    );
  }

  /**
   * Deploy the token after the user taps "🚀 Launch". Resolves the tapper's
   * wallet as the fee recipient (creator fees flow there), calls deployBankrToken,
   * and posts the verifiable result: the Basescan token page (NOT DexScreener,
   * which 404s until trading volume exists).
   */
  private async executeLaunch(ctx: MessageContext, state: LaunchState): Promise<void> {
    return launchExecute(this.launchDeps, ctx, state);
  }

  /**
   * Generate a PnL card PNG and send it as an encrypted XMTP remote attachment.
   * Falls back to a short text line if generation fails.
   */
  private async sendPnlCard(ctx: MessageContext, position: PnlCardInput): Promise<boolean> {
    try {
      console.log(
        "🎴 pnl card: generating for",
        position.pair,
        position.side,
        position.leverage + "x",
      );
      const png = await generatePnlCardPng(position);
      console.log("🎴 pnl card: png size:", png.length, "bytes");

      const encrypted = await encryptAttachment({
        data: new Uint8Array(png),
        filename: "pnl-card.png",
        mimeType: "image/png",
      });
      const url = await uploadEncryptedAttachment(encrypted.content.payload);
      if (!url) throw new Error("Cloudinary upload failed — set CLOUDINARY env vars");
      const remoteAttachment = createRemoteAttachment(encrypted, url);
      await ctx.conversation.send(remoteAttachment, ContentTypeRemoteAttachment);
      console.log("🎴 pnl card: remote attachment sent ✓");
      return true;
    } catch (err) {
      console.warn("⚠️ pnl card send failed:", err);
      return false;
    }
  }

  scheduleAvantisPerpConfirmPoll(
    ctx: MessageContext<string>,
    trader: string,
    trade: PerpMinFixTrade,
    knownTradeIndices: number[],
  ): void {
    scheduleAvantisPerpConfirmPoll(ctx, trader, trade, knownTradeIndices);
  }

  /**
   * Dispatch any AIResponse type in the context of an inline-action button
   * click. Mirrors the main `onText` switch so a button click can produce a
   * follow-up button menu (e.g. yield_compare → disambiguate → amount_select
   * → transaction) without losing UI affordances.
   */
  async dispatchAiResponse(
    ctx: MessageContext<string>,
    resp: AIResponse,
    senderAddr: string,
  ): Promise<void> {
    if (resp.type === "menu") {
      await this.showCapabilitiesMenu(ctx, resp.description);
      return;
    }
    if (resp.type === "transaction") {
      await dispatchAvantisTransaction(ctx, resp, senderAddr);
      return;
    }
    if (resp.type === "amount_select") {
      await this.renderAmountSelect(ctx, resp);
      return;
    }
    if (resp.type === "perp_setup_redirect") {
      if (resp.text) await ctx.conversation.send(resp.text);
      const inboxId = ctx.message.senderInboxId;
      const profile = await PerpProfileAdapter.getProfile(inboxId);
      const setupState: PerpSetupState = PerpProfileAdapter.isComplete(profile)
        ? { mode: "update", ownerInboxId: inboxId }
        : {};
      if (filter.isGroup(ctx.conversation)) {
        await this.sendPerpSetupDm(ctx, inboxId, setupState);
      } else {
        await this.renderPerpSetupStep(ctx, setupState);
      }
      return;
    }
    if (resp.type === "perp_guide") {
      if (filter.isGroup(ctx.conversation)) {
        const profile = await PerpProfileAdapter.getProfile(ctx.message.senderInboxId);
        if (!PerpProfileAdapter.isComplete(profile)) {
          await ctx.conversation.send(
            "perps need a quick one-time setup — check your dm with me",
          );
          await this.sendPerpSetupDm(ctx, ctx.message.senderInboxId);
          return;
        }
      }
      if (resp.text) await ctx.conversation.send(resp.text);
      await this.renderPerpStep(ctx, resp.state);
      return;
    }
    if (resp.type === "perp_min_fix") {
      await this.renderPerpMinFix(ctx, resp);
      return;
    }
    if (resp.type === "tpsl_update_guide") {
      if (resp.text) await ctx.conversation.send(resp.text);
      await this.renderTpslUpdateStep(ctx, {
        ...resp.state,
        ownerInboxId: resp.state.ownerInboxId ?? ctx.message.senderInboxId,
      });
      return;
    }
    if (resp.type === "launch_guide") {
      await this.renderLaunchStep(ctx, resp.state);
      return;
    }
    if (resp.type === "worldcup_matches" || resp.type === "worldcup_bet_wizard") {
      const wc = getWorldCupRenderer();
      if (wc) {
        await dispatchWorldCupAiResponse(ctx, resp, wc);
        return;
      }
    }
    if (resp.type === "withdraw_result") {
      await ctx.conversation.send(resp.text.split("\n")[0] ?? resp.text);
      await ctx.conversation.send(basemateTxLink(resp.transactionHash));
      return;
    }
    if (resp.type === "approve") {
      await ctx.conversation.send(`${resp.text}\n\n${resp.approveUrl}`);
      return;
    }
    if (resp.type === "pnl_card_ready") {
      const sent = await this.sendPnlCard(ctx, resp.position);
      if (!sent && resp.text) await sendMarkdownOrText(ctx, resp.text);
      return;
    }
    if (resp.type === "pnl_position_picker") {
      const msgId = ctx.message.id.slice(0, 8);
      const actions = resp.positions.map((pos, i) => {
        const id = `pnl_pick_${i}_${msgId}`;
        registerAction(id, async (actionCtx: MessageContext) => {
          await this.sendPnlCard(actionCtx, pos);
        });
        const pctSign = pos.pnlPct >= 0 ? "+" : "";
        const pctStr = `${pctSign}${(pos.pnlPct * 100).toFixed(1)}%`;
        return { id, label: `${pos.label} · ${pctStr}`, style: "primary" as const };
      });
      try {
        await sendActions(ctx.conversation, {
          id: `pnl_picker_${msgId}`,
          description: "you have multiple open positions — pick one for your PnL card:",
          actions,
        });
      } catch {
        await sendMarkdownOrText(ctx, resp.text);
      }
      return;
    }
    if (resp.type === "markdown") {
      await sendMarkdownOrText(ctx, resp.text);
      return;
    }
    if (resp.type === "wallet_info") {
      await sendAgentText(ctx, resp.text);
      await ctx.conversation.send(resp.address);
      if (resp.portfolioViewUrl) {
        await sendMarkdownOrText(ctx, formatPortfolioViewMarkdown(resp.portfolioViewUrl));
      }
      this.ai.recordTurn(ctx.conversation.id, undefined, resp.text);
      return;
    }
    if (resp.type === "text") {
      await this.sendTextMaybeMenu(ctx, resp);
      this.ai.recordTurn(ctx.conversation.id, undefined, resp.text);
      return;
    }
    if (resp.type === "disambiguate") {
      await this.renderYieldDisambiguate(ctx, resp);
      return;
    }
    // communities, launches → send description text.
    if ("text" in resp && resp.text) {
      await sendAgentText(ctx, resp.text);
      this.ai.recordTurn(ctx.conversation.id, undefined, resp.text);
    }
  }

  async onGroup(ctx: any): Promise<EventResult> {
    try {
      const conversationId = ctx.conversation.id;
      const groupName = ctx.conversation.name || "Unnamed Group";
      const groupImageUrl = ctx.conversation.imageUrl || "";

      const { NSGroupAdapter } = await import("@/discovery/adapters/index.js");

      const exists = await GroupAdapter.checkGroupExists(conversationId);
      if (!exists) {
        let memberCount = 0;
        try { const members = await ctx.conversation.members(); memberCount = members?.length || 0; } catch {}
        await GroupAdapter.insertGroupDetails({
          groupId: conversationId, groupName, groupType: "activity", createdBy: undefined,
          memberCount, description: `Activity group for ${groupName}`, originalGroupId: conversationId,
          totalMessages: 0, totalMentionedMessages: 0, totalLeaves: 0, metadata: {},
        });
      }

      const existingNSGroup = await NSGroupAdapter.getGroupById(conversationId);
      if (existingNSGroup?.agent_in_group) {
        let memberCount = existingNSGroup.total_members || 0;
        try { await ctx.conversation.sync(); const members = await ctx.conversation.members(); memberCount = members?.length || 0; } catch {}

        // Refresh count + record accurate join/leave delta + snapshot (floored
        // at distinct chatters so sync lag can't under-report).
        const { reconcileMemberCount } = await import("@/discovery/services/memberCount.js");
        await reconcileMemberCount(conversationId, memberCount).catch(() => {});

        if (!existingNSGroup.image_url && groupImageUrl) {
          await NSGroupAdapter.upsertGroup({ group_id: conversationId, name: existingNSGroup.name, image_url: groupImageUrl });
        }
        return;
      }

      console.log(`🎯 New group detected: "${groupName}"`);

      if (/^(test\s*group|test)(\s*\d*)?$/i.test(groupName.trim())) return;

      let memberCount = existingNSGroup?.total_members || 0;
      try { await ctx.conversation.sync(); const members = await ctx.conversation.members(); memberCount = members?.length || 0; } catch {}

      const isSuggestable = memberCount >= 5;

      await NSGroupAdapter.upsertGroup({
        group_id: conversationId, name: groupName,
        description: existingNSGroup?.description || "Community group",
        ai_generated_tags: existingNSGroup?.ai_generated_tags || [],
        is_suggestable: isSuggestable, agent_in_group: true,
        tags: existingNSGroup?.tags || [],
        total_messages: existingNSGroup?.total_messages || 0, total_members: memberCount,
        image_url: groupImageUrl || existingNSGroup?.image_url,
      });

      console.log(`✅ Group "${groupName}" indexed — suggestable: ${isSuggestable}`);

      if (!existingNSGroup) {
        const recheck = await NSGroupAdapter.getGroupById(conversationId);
        if (recheck && recheck.agent_in_group) return;

        const setupUrl = "https://app.basemate.app";
        const welcomeMessage = memberCount >= 5
          ? `Hey! I'm Basemate, your community discovery agent.\n\n"${groupName}" is now in the discovery pipeline. Head to ${setupUrl} to set interest tags and boost for priority placement.\n\nTo remove me, just kick me from the group.`
          : `Hey! I'm Basemate, your community discovery agent.\n\nHead to ${setupUrl} to set interest tags and boost for priority placement.`;
        await ctx.conversation.send(welcomeMessage);
      }
    } catch (err: any) {
      console.error("❌ Error indexing group:", err.message);
    }
    return;
  }

  /**
   * Fired on group membership/metadata changes. Use it to keep
   * ns_groups.agent_in_group in sync with reality so discovery never
   * recommends a group we were just removed from (or surfaces one we
   * were just re-added to after a wallet change).
   */
  async onGroupUpdate(ctx: any): Promise<EventResult> {
    try {
      const conversationId = ctx?.conversation?.id;
      if (!conversationId) return;

      const { NSGroupAdapter } = await import("@/discovery/adapters/index.js");
      const myInboxId: string | undefined = ctx?.client?.inboxId;

      let isMember = false;
      let liveMemberCount = 0;
      try {
        await ctx.conversation.sync();
        const members = await ctx.conversation.members();
        liveMemberCount = Array.isArray(members) ? members.length : 0;
        if (myInboxId && Array.isArray(members)) {
          isMember = members.some((m: any) => m?.inboxId === myInboxId);
        } else {
          // If we can't identify ourselves, fall back to "members > 0" — if
          // we can read members at all we're still in the group.
          isMember = Array.isArray(members) && members.length > 0;
        }
      } catch (err: any) {
        // members() throwing typically means we're no longer in the group.
        console.log(
          `⚠️ onGroupUpdate: members() failed for ${conversationId.slice(0, 8)} — treating as removed: ${err?.message || err}`,
        );
        isMember = false;
      }

      const existing = await NSGroupAdapter.getGroupById(conversationId);
      if (!existing) {
        // Group isn't indexed yet; only flip if we're actually in it. onGroup
        // will pick up the full upsert on its own.
        if (isMember) {
          await NSGroupAdapter.updateAgentInGroup(conversationId, true);
          NSGroupAdapter.invalidateAgentGroupIdSet();
        }
        return;
      }

      if (Boolean(existing.agent_in_group) !== isMember) {
        await NSGroupAdapter.updateAgentInGroup(conversationId, isMember);
        NSGroupAdapter.invalidateAgentGroupIdSet();
        console.log(
          `🔁 onGroupUpdate: agent_in_group ${existing.agent_in_group} -> ${isMember} for "${existing.name}"`,
        );
      }

      // Membership changed and we're still in the group → refresh the stored
      // member count + record the join/leave delta + snapshot today's count.
      // This is the lightweight, per-group "on join" update; the daily syncAll
      // job reconciles anything this misses.
      if (isMember) {
        const { reconcileMemberCount } = await import("@/discovery/services/memberCount.js");
        const res = await reconcileMemberCount(conversationId, liveMemberCount).catch(() => null);
        if (res && res.delta !== 0) {
          console.log(
            `👥 onGroupUpdate: "${existing.name}" members ${res.previous} -> ${res.current} (${res.delta > 0 ? "+" : ""}${res.delta})${res.flooredUp ? " [floored]" : ""}`,
          );
        }
      }
    } catch (err: any) {
      console.error("❌ onGroupUpdate error:", err?.message || err);
    }
    return;
  }
}
