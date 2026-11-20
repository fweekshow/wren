import type { StrategyConfig } from "@basemate/shared";

import { StrategyAdapter } from "@/discovery/adapters/strategy.adapter.js";
import { authorAndPaperDeploy } from "@/discovery/strategy/authoring.js";
import { getStrategyPnlSnapshot } from "@/discovery/strategy/pnlSync.js";
import { promotePaperToLive } from "@/discovery/strategy/runner.js";
import { resolveCanonicalStrategyOwner } from "@/discovery/strategy/owner.js";
import { resolveCreatorExecutionWallet } from "@/discovery/strategy/wallet.js";
import { isStrategyLiveTradingPaused, LIVE_TRADING_PAUSED_MESSAGE } from "@/discovery/strategy/liveTrading.js";
import { patchStrategyFromPrompt } from "@/discovery/strategy/strategyPatch.js";
import {
  buildStrategyTechnicals,
  formatPairTechnicalsLine,
} from "@/discovery/strategy/strategyTechnicals.js";
import { improveStrategyFromWiki } from "@/discovery/strategy/strategyWiki.js";
import { BASE_USDC_ADDRESS, getBalances, isStrategyPaymasterEnabled } from "@/wallet/cdp.js";
import { convKey, stateDelete, stateGet, stateHas, stateSet } from "@/state/conversationState.store.js";
import { logger } from "@/utils/logger.js";

import {
  answerCallbackQuery,
  editMessageText,
  sendChatAction,
  sendMessage,
  type TgInlineKeyboard,
} from "./api.js";
import { TelegramCallbackAdapter } from "./callbackStore.js";
import {
  CALLBACK_FAILURE_COPY,
  goLiveConfirmView,
  homeLinkedView,
  modifyPreviewView,
  myStrategiesView,
  remixPreviewView,
  strategyCardView,
  strategyTechnicalsView,
  type TgButton,
  type TgView,
  walletView,
} from "./ux.js";
import { createTelegramFundUrl } from "./walletFunding.js";
import { getTelegramBotIdentity } from "./botIdentity.js";
import {
  isPrivateTelegramChat,
  normalizeGroupMessageText,
  shouldRespondInGroup,
  type TelegramMessageEntity,
} from "./groupGate.js";
import { isVisibleStrategy, toCardVM, toListItemVM } from "./viewModel.js";

/** Minimal Telegram update shape (message + callback_query only). */
export interface TelegramUpdate {
  message?: {
    message_id: number;
    from?: { id: number };
    chat: { id: number; type: string };
    text?: string;
    entities?: TelegramMessageEntity[];
    reply_to_message?: {
      from?: { id: number; is_bot?: boolean };
    };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number; type: string } };
    data?: string;
  };
}

const PLATFORM = "telegram" as const;

function cardViewOpts() {
  return { livePaused: isStrategyLiveTradingPaused() };
}
/** Owner key stored in strategies.creator_inbox_id for a Telegram-native owner. */
function ownerKeyFor(userId: string): string {
  const owner = resolveCanonicalStrategyOwner({ platform: "telegram", userKey: userId });
  return owner.ok ? owner.ownerKey : `tg:${userId}`;
}
const authoringPendingKey = (userId: string) => convKey(PLATFORM, userId, "awaitingStrategyPrompt");
const modifyPendingKey = (userId: string) => convKey(PLATFORM, userId, "awaitingStrategyModify");
const AUTHORING_TTL_S = 600;
/** Holds a proposed remix config until the user taps Apply. */
const remixProposalKey = (strategyId: string) => convKey(PLATFORM, strategyId, "remixProposal");
const modifyProposalKey = (strategyId: string) => convKey(PLATFORM, strategyId, "modifyProposal");
const REMIX_TTL_S = 900;

/** Convert a pure TgView into a Telegram inline keyboard, minting opaque callbacks. */
async function toInlineKeyboard(
  view: TgView,
  ctx: { telegramUserId: string; chatId: string; ownerInboxId: string },
): Promise<TgInlineKeyboard> {
  const rows: TgInlineKeyboard = [];
  for (const row of view.keyboard) {
    const outRow = [] as TgInlineKeyboard[number];
    for (const btn of row as TgButton[]) {
      if (btn.url) {
        outRow.push({ text: btn.text, url: btn.url });
        continue;
      }
      if (!btn.action) continue;
      const id = await TelegramCallbackAdapter.mint({
        telegramUserId: ctx.telegramUserId,
        chatId: ctx.chatId,
        ownerInboxId: ctx.ownerInboxId,
        strategyId: btn.action.strategyId ?? null,
        version: btn.action.version ?? null,
        action: btn.action.action,
        params: btn.action.params ?? {},
      });
      outRow.push({ text: btn.text, callback_data: id });
    }
    if (outRow.length) rows.push(outRow);
  }
  return rows;
}

async function sendView(
  view: TgView,
  ctx: { telegramUserId: string; chatId: string; ownerInboxId: string },
): Promise<void> {
  const keyboard = await toInlineKeyboard(view, ctx);
  await sendMessage({ chatId: ctx.chatId, text: view.text, keyboard });
}

async function editView(
  view: TgView,
  ctx: { telegramUserId: string; chatId: string; ownerInboxId: string; messageId: number },
): Promise<void> {
  const keyboard = await toInlineKeyboard(view, ctx);
  await editMessageText({ chatId: ctx.chatId, messageId: ctx.messageId, text: view.text, keyboard });
}

/** Entry point for a verified inbound update (called after webhook auth). */
export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  if (update.callback_query) return handleCallback(update.callback_query);
  if (update.message) return handleMessage(update.message);
}

async function runAuthoring(args: {
  chatId: string;
  userId: string;
  ownerKey: string;
  prompt: string;
}): Promise<void> {
  await sendChatAction(args.chatId, "typing");
  await sendMessage({ chatId: args.chatId, text: "Building your strategy…" });
  try {
    const result = await authorAndPaperDeploy({ ownerKey: args.ownerKey, prompt: args.prompt });
    if (!result.ok) {
      await sendMessage({ chatId: args.chatId, text: result.error });
      return;
    }
    const fresh = await StrategyAdapter.getById(result.strategy.id);
    const row = fresh ?? result.strategy;
    await sendView(strategyCardView(toCardVM(row, await getStrategyPnlSnapshot(row.id)), cardViewOpts()), {
      telegramUserId: args.userId,
      chatId: args.chatId,
      ownerInboxId: args.ownerKey,
    });
  } catch (err) {
    logger.warn(`[Telegram] authoring failed: ${(err as Error).message}`);
    await sendMessage({ chatId: args.chatId, text: "Something went wrong building that — try again." });
  }
}

async function handleMessage(message: NonNullable<TelegramUpdate["message"]>): Promise<void> {
  const chatId = String(message.chat.id);
  const userId = message.from ? String(message.from.id) : "";
  if (!userId) return;

  const isPrivate = isPrivateTelegramChat(message.chat.type);
  const bot = await getTelegramBotIdentity();

  if (!isPrivate && !shouldRespondInGroup(message, bot)) {
    return; // Ignore ambient group chatter — no reply.
  }

  let text = (message.text ?? "").trim();
  if (!isPrivate) {
    text = normalizeGroupMessageText(text, message.entities, bot);
  }

  const ownerKey = ownerKeyFor(userId);
  const [awaitingPrompt, awaitingModify] = await Promise.all([
    stateHas(authoringPendingKey(userId)).catch(() => false),
    stateGet<{ strategyId: string }>(modifyPendingKey(userId)).catch(() => null),
  ]);

  if (awaitingModify?.strategyId && text && !text.startsWith("/")) {
    await stateDelete(modifyPendingKey(userId)).catch(() => undefined);
    await runModify({ chatId, userId, ownerKey, strategyId: awaitingModify.strategyId, prompt: text });
    return;
  }

  if (awaitingPrompt && text && !text.startsWith("/")) {
    await stateDelete(authoringPendingKey(userId)).catch(() => undefined);
    await runAuthoring({ chatId, userId, ownerKey, prompt: text });
    return;
  }

  await sendHome(userId, chatId);
}

async function sendHome(userId: string, chatId: string): Promise<void> {
  await sendView(homeLinkedView({ killSwitchOn: isStrategyLiveTradingPaused() }), {
    telegramUserId: userId,
    chatId,
    ownerInboxId: ownerKeyFor(userId),
  });
}

async function handleCallback(cq: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
  const chatId = cq.message ? String(cq.message.chat.id) : "";
  const userId = String(cq.from.id);
  const messageId = cq.message?.message_id;

  const redeemed = await TelegramCallbackAdapter.redeem({ id: cq.data ?? "", telegramUserId: userId, chatId });
  if (!redeemed.ok) {
    await answerCallbackQuery({
      callbackQueryId: cq.id,
      text: CALLBACK_FAILURE_COPY[redeemed.reason] ?? CALLBACK_FAILURE_COPY.expired,
      showAlert: true,
    });
    return;
  }

  const { payload } = redeemed;
  const ctx = { telegramUserId: userId, chatId, ownerInboxId: payload.ownerInboxId, messageId: messageId ?? 0 };

  try {
    switch (payload.action) {
      case "my_strategies":
        await renderMyStrategies(ctx);
        break;
      case "open_detail":
        await renderDetail(ctx, payload.strategyId);
        break;
      case "go_live_confirm":
        await renderGoLiveConfirm(ctx, payload.strategyId, payload.version);
        break;
      case "go_live":
        await doGoLive(ctx, payload.strategyId, payload.version, cq.id);
        return; // doGoLive answers the callback itself
      case "stop":
        await doStop(ctx, payload.strategyId);
        break;
      case "remix":
        await doRemix(ctx, payload.strategyId);
        break;
      case "remix_apply":
        await doRemixApply(ctx, payload.strategyId);
        break;
      case "modify":
        await doModifyStart(ctx, payload.strategyId);
        break;
      case "modify_apply":
        await doModifyApply(ctx, payload.strategyId, payload.version);
        break;
      case "technicals":
        await renderTechnicals(ctx, payload.strategyId);
        break;
      case "new_strategy":
        await stateSet(authoringPendingKey(userId), true, AUTHORING_TTL_S).catch(() => undefined);
        await sendMessage({
          chatId,
          text: 'Describe your strategy — e.g. "scalp ETH when it pumps, 5x, tight stop" or "steady SOL income". I\'ll build it and start it in paper.',
        });
        break;
      case "wallet":
        await renderWallet(ctx);
        break;
      case "home":
        await sendHome(userId, chatId);
        break;
      default:
        await sendMessage({ chatId, text: CALLBACK_FAILURE_COPY.expired! });
    }
    await answerCallbackQuery({ callbackQueryId: cq.id });
  } catch (err) {
    logger.warn(`[Telegram] callback ${payload.action} failed: ${(err as Error).message}`);
    await answerCallbackQuery({ callbackQueryId: cq.id, text: "Something went wrong — try again.", showAlert: true });
  }
}

async function renderMyStrategies(ctx: {
  telegramUserId: string;
  chatId: string;
  ownerInboxId: string;
  messageId: number;
}): Promise<void> {
  const rows = (await StrategyAdapter.listByCreator(ctx.ownerInboxId)).filter(isVisibleStrategy);
  const items = await Promise.all(
    rows.map(async (row) => toListItemVM(row, await getStrategyPnlSnapshot(row.id))),
  );
  await editView(myStrategiesView(items), ctx);
}

async function renderDetail(
  ctx: { telegramUserId: string; chatId: string; ownerInboxId: string; messageId: number },
  strategyId: string | null,
): Promise<void> {
  const row = strategyId ? await StrategyAdapter.getById(strategyId) : null;
  if (!row || row.creator_inbox_id !== ctx.ownerInboxId) {
    await sendMessage({ chatId: ctx.chatId, text: CALLBACK_FAILURE_COPY.expired! });
    return;
  }
  await editView(strategyCardView(toCardVM(row, await getStrategyPnlSnapshot(row.id)), cardViewOpts()), ctx);
}

async function renderGoLiveConfirm(
  ctx: { telegramUserId: string; chatId: string; ownerInboxId: string; messageId: number },
  strategyId: string | null,
  version: number | null,
): Promise<void> {
  const row = strategyId ? await StrategyAdapter.getById(strategyId) : null;
  if (!row || row.creator_inbox_id !== ctx.ownerInboxId) {
    await sendMessage({ chatId: ctx.chatId, text: CALLBACK_FAILURE_COPY.expired! });
    return;
  }
  if (isStrategyLiveTradingPaused()) {
    await sendMessage({ chatId: ctx.chatId, text: LIVE_TRADING_PAUSED_MESSAGE });
    await renderDetail(ctx, strategyId);
    return;
  }
  if ((row.config.version ?? null) !== version) {
    await sendMessage({ chatId: ctx.chatId, text: CALLBACK_FAILURE_COPY.stale_version! });
    await renderDetail(ctx, strategyId);
    return;
  }
  await editView(goLiveConfirmView(toCardVM(row, await getStrategyPnlSnapshot(row.id))), ctx);
}

async function doGoLive(
  ctx: { telegramUserId: string; chatId: string; ownerInboxId: string; messageId: number },
  strategyId: string | null,
  version: number | null,
  callbackQueryId: string,
): Promise<void> {
  const row = strategyId ? await StrategyAdapter.getById(strategyId) : null;
  if (!row || row.creator_inbox_id !== ctx.ownerInboxId) {
    await answerCallbackQuery({ callbackQueryId, text: CALLBACK_FAILURE_COPY.expired, showAlert: true });
    return;
  }
  if ((row.config.version ?? null) !== version) {
    await answerCallbackQuery({ callbackQueryId, text: CALLBACK_FAILURE_COPY.stale_version, showAlert: true });
    return;
  }
  // Money mutation goes through the vetted, kill-switch-aware path. The owner is
  // the canonical XMTP inbox, so the same isolated cp- wallet is reused.
  const result = await promotePaperToLive(strategyId!, ctx.ownerInboxId);
  if (result.ok) {
    await answerCallbackQuery({ callbackQueryId, text: "Live." });
    await renderDetail(ctx, strategyId);
    if (result.walletAddress) {
      const margin =
        row.default_collateral_usdc != null
          ? Number(row.default_collateral_usdc)
          : row.config.defaultCollateralUsdc;
      const gasLine = isStrategyPaymasterEnabled()
        ? "USDC only — gas is covered by Basemate."
        : "You'll also need a little ETH on Base for gas.";
      await sendMessage({
        chatId: ctx.chatId,
        text:
          `<b>You're live</b>\n\n` +
          `Fund your Basemate strategy wallet on Base:\n<code>${result.walletAddress}</code>\n\n` +
          `Keep at least ~$${Math.max(1, Math.ceil(margin))} USDC in it for each trade.\n${gasLine}`,
      });
    }
  } else {
    await answerCallbackQuery({ callbackQueryId, text: result.error ?? "Couldn't go live.", showAlert: true });
  }
}

async function doStop(
  ctx: { telegramUserId: string; chatId: string; ownerInboxId: string; messageId: number },
  strategyId: string | null,
): Promise<void> {
  const row = strategyId ? await StrategyAdapter.getById(strategyId) : null;
  if (!row || row.creator_inbox_id !== ctx.ownerInboxId) {
    await sendMessage({ chatId: ctx.chatId, text: CALLBACK_FAILURE_COPY.expired! });
    return;
  }
  await StrategyAdapter.updateStatus(row.id, "archived");
  await renderMyStrategies(ctx);
}

async function doRemix(
  ctx: { telegramUserId: string; chatId: string; ownerInboxId: string; messageId: number },
  strategyId: string | null,
): Promise<void> {
  const row = strategyId ? await StrategyAdapter.getById(strategyId) : null;
  if (!row || row.creator_inbox_id !== ctx.ownerInboxId) {
    await sendMessage({ chatId: ctx.chatId, text: CALLBACK_FAILURE_COPY.expired! });
    return;
  }
  // The improve engine runs the compiled trade wiki through the Tactical Alpha
  // brain. Needs real trades first — the wiki worker compiles closed paper/live
  // trades into the wiki.
  const wiki = await StrategyAdapter.getLatestWiki(row.id);
  if (!wiki) {
    await sendMessage({
      chatId: ctx.chatId,
      text: "Not enough trades yet to remix — tap Modify for quick TP/SL or sizing tweaks, or let it run and I'll tune from your results 💙",
    });
    return;
  }
  await sendChatAction(ctx.chatId, "typing");
  await sendMessage({ chatId: ctx.chatId, text: "Analyzing your trades against Tactical Alpha…" });
  const { authored, diagnosis } = await improveStrategyFromWiki(row, wiki);
  // Stash the proposal; Apply commits it. Never silently change the user's config.
  await stateSet(remixProposalKey(row.id), authored.config, REMIX_TTL_S).catch(() => undefined);
  const previewRow = { ...row, config: authored.config };
  const vm = toCardVM(previewRow, await getStrategyPnlSnapshot(row.id));
  await sendView(remixPreviewView(vm, diagnosis), ctx);
}

async function doRemixApply(
  ctx: { telegramUserId: string; chatId: string; ownerInboxId: string; messageId: number },
  strategyId: string | null,
): Promise<void> {
  const row = strategyId ? await StrategyAdapter.getById(strategyId) : null;
  if (!row || row.creator_inbox_id !== ctx.ownerInboxId) {
    await sendMessage({ chatId: ctx.chatId, text: CALLBACK_FAILURE_COPY.expired! });
    return;
  }
  const proposed = await stateGet<StrategyConfig>(remixProposalKey(row.id));
  if (!proposed) {
    await sendMessage({ chatId: ctx.chatId, text: "That tweak expired — tap Remix again." });
    return;
  }
  await StrategyAdapter.updateConfig(row.id, proposed);
  await stateDelete(remixProposalKey(row.id)).catch(() => undefined);
  const fresh = (await StrategyAdapter.getById(row.id)) ?? row;
  await sendMessage({ chatId: ctx.chatId, text: "Applied 💙" });
  await sendView(strategyCardView(toCardVM(fresh, await getStrategyPnlSnapshot(fresh.id)), cardViewOpts()), ctx);
}

async function doModifyStart(
  ctx: { telegramUserId: string; chatId: string; ownerInboxId: string; messageId: number },
  strategyId: string | null,
): Promise<void> {
  const row = strategyId ? await StrategyAdapter.getById(strategyId) : null;
  if (!row || row.creator_inbox_id !== ctx.ownerInboxId) {
    await sendMessage({ chatId: ctx.chatId, text: CALLBACK_FAILURE_COPY.expired! });
    return;
  }
  await stateDelete(authoringPendingKey(ctx.telegramUserId)).catch(() => undefined);
  await stateSet(modifyPendingKey(ctx.telegramUserId), { strategyId: row.id }, AUTHORING_TTL_S).catch(
    () => undefined,
  );
  await sendMessage({
    chatId: ctx.chatId,
    text:
      "What should I change?\n\n" +
      "• <b>Size</b> — $ collateral per trade (e.g. $25)\n" +
      "• <b>Leverage</b> — multiplier on size (e.g. 50x → $10 at 50x = $500 notional)\n" +
      "• <b>TP/SL</b> — e.g. tighten SL, 1% stop\n" +
      "• Pairs, direction — e.g. add BTC, long only ETH",
  });
}

async function runModify(args: {
  chatId: string;
  userId: string;
  ownerKey: string;
  strategyId: string;
  prompt: string;
}): Promise<void> {
  const row = await StrategyAdapter.getById(args.strategyId);
  if (!row || row.creator_inbox_id !== args.ownerKey) {
    await sendMessage({ chatId: args.chatId, text: CALLBACK_FAILURE_COPY.expired! });
    return;
  }
  await sendChatAction(args.chatId, "typing");
  const patch = await patchStrategyFromPrompt(row, args.prompt);
  if (!patch.ok || !patch.config) {
    await sendMessage({ chatId: args.chatId, text: patch.error ?? "Couldn't parse that tweak." });
    return;
  }
  await stateSet(modifyProposalKey(row.id), patch.config, REMIX_TTL_S).catch(() => undefined);
  const previewRow = { ...row, config: patch.config };
  const vm = toCardVM(previewRow, await getStrategyPnlSnapshot(row.id));
  await sendView(modifyPreviewView(vm, patch.summary ?? "config updated"), {
    telegramUserId: args.userId,
    chatId: args.chatId,
    ownerInboxId: args.ownerKey,
  });
}

async function doModifyApply(
  ctx: { telegramUserId: string; chatId: string; ownerInboxId: string; messageId: number },
  strategyId: string | null,
  version: number | null,
): Promise<void> {
  const row = strategyId ? await StrategyAdapter.getById(strategyId) : null;
  if (!row || row.creator_inbox_id !== ctx.ownerInboxId) {
    await sendMessage({ chatId: ctx.chatId, text: CALLBACK_FAILURE_COPY.expired! });
    return;
  }
  if ((row.config.version ?? null) !== version) {
    await sendMessage({ chatId: ctx.chatId, text: CALLBACK_FAILURE_COPY.stale_version! });
    await renderDetail(ctx, strategyId);
    return;
  }
  const proposed = await stateGet<StrategyConfig>(modifyProposalKey(row.id));
  if (!proposed) {
    await sendMessage({ chatId: ctx.chatId, text: "That tweak expired — tap Modify again." });
    return;
  }
  await StrategyAdapter.updateConfig(row.id, proposed);
  await stateDelete(modifyProposalKey(row.id)).catch(() => undefined);
  const fresh = (await StrategyAdapter.getById(row.id)) ?? row;
  await sendMessage({ chatId: ctx.chatId, text: "Applied 💙" });
  await sendView(strategyCardView(toCardVM(fresh, await getStrategyPnlSnapshot(fresh.id)), cardViewOpts()), ctx);
}

async function renderTechnicals(
  ctx: { telegramUserId: string; chatId: string; ownerInboxId: string; messageId: number },
  strategyId: string | null,
): Promise<void> {
  const row = strategyId ? await StrategyAdapter.getById(strategyId) : null;
  if (!row || row.creator_inbox_id !== ctx.ownerInboxId) {
    await sendMessage({ chatId: ctx.chatId, text: CALLBACK_FAILURE_COPY.expired! });
    return;
  }
  const diag = await buildStrategyTechnicals(row);
  await editView(
    strategyTechnicalsView({
      name: diag.name,
      status: diag.status,
      lastEvalAgeSec: diag.lastEvalAgeSec,
      tradeCount: diag.tradeCount,
      pairLines: diag.pairs.map(formatPairTechnicalsLine),
      configSpec: diag.configSpec,
      direction: diag.direction,
      antiChop: diag.antiChop,
      marginUsdc: diag.marginUsdc,
      leverage: diag.leverage,
      tpPercent: diag.tpPercent,
      slPercent: diag.slPercent,
      effectiveSlPercent: diag.effectiveSlPercent,
      slCapped: diag.slCapped,
      riskPerTradePct: diag.riskPerTradePct,
      dailyDrawdownStopPct: diag.dailyDrawdownStopPct,
      lossStreakCooldown: diag.lossStreakCooldown,
      strategyId: row.id,
      version: row.config.version ?? null,
    }),
    ctx,
  );
}

async function renderWallet(ctx: {
  telegramUserId: string;
  chatId: string;
  ownerInboxId: string;
  messageId: number;
}): Promise<void> {
  const wallet = await resolveCreatorExecutionWallet(ctx.ownerInboxId);
  if (!wallet) {
    await sendMessage({
      chatId: ctx.chatId,
      text: "<b>Basemate strategy wallet</b>\n\nWallets aren't configured on this server yet.",
    });
    return;
  }

  const raw = await getBalances(wallet.walletAddress).catch(() => []);
  const usdc = raw.find((b) => b.contractAddress === BASE_USDC_ADDRESS);
  const balances = [{ symbol: "USDC", formatted: usdc?.formatted ?? "0" }];

  const fundUrl = await createTelegramFundUrl(ctx.ownerInboxId, wallet.walletAddress);
  await sendView(
    walletView({ walletAddress: wallet.walletAddress, balances, fundUrl }),
    { telegramUserId: ctx.telegramUserId, chatId: ctx.chatId, ownerInboxId: ctx.ownerInboxId },
  );
}
