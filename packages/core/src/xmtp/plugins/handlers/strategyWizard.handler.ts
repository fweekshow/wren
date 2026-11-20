/**
 * strategyWizard.handler — strategy authoring, listing, detail, improve, and
 * execute flows.
 *
 * Extracted from discovery.plugin.ts (was private methods at lines ~2766-4611).
 * Covers: startPromptStrategy, sendPromptStrategyDm, armPromptStrategyOnConversation,
 * cancelStrategyPrompt, LIVE/OPEN_STRATEGY_STATUSES, listOpenStrategies,
 * showStrategyDetail, sendPaperStrategyActions, formatStrategyDetailLines,
 * runPromptStrategy, presentBuiltStrategy, capabilityInfoLines,
 * renderFinalStrategyCard, sendExitChoice, sendMinNotionalChoice,
 * sendCapabilityConfirm, startWikiRemix, runImproveStrategy,
 * runImproveStrategyInner, sendImproveActions, sendStrategyActions.
 *
 * Injection surface:
 *   `StrategyWizardDeps` — the minimum surface of DiscoveryPlugin needed here.
 *   DiscoveryPlugin satisfies this interface structurally when `this` is passed.
 */

import { filter, type MessageContext } from "@xmtp/agent-sdk";

import type { DiscoveryAI } from "@/discovery/ai/core.js";
import type { AIResponse } from "@/discovery/ai.js";
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
} from "@/discovery/strategy/strategyWiki.js";
import { PUBLISH_MIN_CLOSED_TRADES } from "@/discovery/strategy/publishGate.js";
import {
  isStrategyLiveTradingPaused,
  LIVE_TRADING_PAUSED_MESSAGE,
} from "@/discovery/strategy/liveTrading.js";
import {
  deployPaperStrategy,
  deployStrategy,
  promotePaperToLive,
} from "@/discovery/strategy/runner.js";
import {
  syncCreatorStrategyPnls,
  syncStrategyWalletPnl,
} from "@/discovery/strategy/pnlSync.js";
import { ORACLE_MIN_SAMPLES } from "@/discovery/strategy/signals.js";
import {
  BASEMATE_WALLET_LABEL,
  resolveBasemateServerWallet,
  shortAddress,
} from "@/discovery/strategy/wallet.js";
import {
  StrategyAdapter,
  type StrategyRow,
  type StrategyStatus,
} from "@/discovery/adapters/index.js";
import type { StrategyConfig } from "@basemate/shared";
import {
  sendActions,
  registerAction,
  showMenu,
  type AppConfig,
} from "@/xmtp/content-types/inline-actions/index.js";
import { sendMarkdownOrText } from "@/xmtp/core/utils.js";
import { resolveSenderWalletAddress } from "@/xmtp/core/index.js";
import {
  XK,
  pendingStrategyPrompt,
  improveInFlight,
  touchPending,
  pendingUserKey,
} from "@/xmtp/plugins/handlers/discovery.stateKeys.js";
import {
  stateGet,
  stateSet,
  stateDelete,
} from "@/state/conversationState.store.js";
import {
  bumpStrategyVersion,
  formatConfigChanges,
  humanJoin,
  formatStrategyListLabel,
  isStrategyAffirmation,
  isStrategyCancel,
  formatSignedUsdShort,
} from "@/xmtp/plugins/discovery.utils.js";
import { resolveBasename } from "@/discovery/services/basename.util.js";
import { getBalances, BASE_USDC_ADDRESS } from "@/wallet/cdp.js";

// ── Deps interface ────────────────────────────────────────────────────────────

/** Minimum surface of DiscoveryPlugin needed by the strategy wizard. */
export interface StrategyWizardDeps {
  ai: Pick<DiscoveryAI, "respond" | "recordTurn">;
  client: {
    conversations: {
      newDmWithIdentifier: (opts: {
        identifier: `0x${string}`;
        identifierKind: number;
      }) => Promise<any>;
    };
  };
  capabilitiesConfig: AppConfig | null;
  dispatchAiResponse: (
    ctx: MessageContext<string>,
    resp: AIResponse,
    senderAddr: string,
  ) => Promise<void>;
  sendPerpBackActions: (
    ctx: MessageContext,
    description?: string,
    suffix?: string,
  ) => Promise<void>;
  startPerpWizard: (ctx: MessageContext) => Promise<void>;
  renderPerpWalletTopUp: (
    ctx: MessageContext,
    walletAddress: string,
  ) => Promise<void>;
}

// ── Module-level constants ────────────────────────────────────────────────────

export const LIVE_STRATEGY_STATUSES: StrategyStatus[] = [
  "testing",
  "published",
  "publishable",
];

export const OPEN_STRATEGY_STATUSES: StrategyStatus[] = [
  "paper",
  "testing",
  "published",
  "publishable",
];

// ── Local helpers ─────────────────────────────────────────────────────────────

/** Register a ← Back button that navigates to the PerpMate menu. */
function registerPerpBackAction(
  plugin: StrategyWizardDeps,
  backId: string,
): void {
  registerAction(backId, async (actionCtx: MessageContext) => {
    if (plugin.capabilitiesConfig) {
      await showMenu(actionCtx, plugin.capabilitiesConfig, "menu_perps");
    }
  });
}

function formatTradePnlLine(
  trade: Awaited<ReturnType<typeof StrategyAdapter.listTradePnlRows>>[number],
  index: number,
): string {
  const base = trade.pair.split("-")[0]?.replace(/USD$/i, "") ?? trade.pair;
  const pnl = trade.is_open ? (trade.last_unrealized_usd ?? 0) : trade.pnl_usd;
  const status = trade.is_open ? "open" : (trade.exit_reason ?? "closed");
  const mode = trade.mode ? ` · ${trade.mode.replace(/_/g, " ")}` : "";
  return `#${index + 1} ${base} ${trade.side} ${formatSignedUsdShort(pnl)} (${status})${mode}`;
}

// ── Exported handler functions ────────────────────────────────────────────────

export async function startPromptStrategy(
  _plugin: StrategyWizardDeps,
  ctx: MessageContext,
): Promise<void> {
  await ctx.conversation.send("paper trading and automated strategies are off.");
}

export async function sendPromptStrategyDm(
  plugin: StrategyWizardDeps,
  ctx: MessageContext,
  inboxId: string,
): Promise<void> {
  const wallet = await resolveSenderWalletAddress(ctx as any);
  if (!wallet) return;
  try {
    const dm: any = await plugin.client.conversations.newDmWithIdentifier({
      identifier: wallet as `0x${string}`,
      identifierKind: 0,
    });
    if (typeof dm.sync === "function") {
      await dm.sync();
    }
    await armPromptStrategyOnConversation(plugin, dm, inboxId, `dm_${Date.now()}`);
  } catch (err) {
    console.warn("⚠️ sendPromptStrategyDm failed:", err);
  }
}

export async function armPromptStrategyOnConversation(
  _plugin: StrategyWizardDeps,
  conversation: Parameters<typeof sendActions>[0],
  _inboxId: string,
  _messageId: string,
): Promise<void> {
  await conversation.send("paper trading and automated strategies are off.");
}

/** Clear strategy authoring state and return to PerpMate menu. */
export async function cancelStrategyPrompt(
  plugin: StrategyWizardDeps,
  ctx: MessageContext,
): Promise<void> {
  const key = pendingUserKey(ctx.message.senderInboxId, ctx.conversation.id);
  pendingStrategyPrompt.delete(key);
  await stateDelete(XK.lastStrategyPrompt(key));
  await ctx.conversation.send("no problem 💙");
  if (plugin.capabilitiesConfig) {
    await showMenu(ctx, plugin.capabilitiesConfig, "menu_perps");
  }
}

/** VibeTrading menu → My Strategies. Paper trading and live strategies as separate sections. */
export async function listOpenStrategies(
  plugin: StrategyWizardDeps,
  ctx: MessageContext,
): Promise<void> {
  const inboxId = ctx.message.senderInboxId;
  const livePaused = isStrategyLiveTradingPaused();
  // Filter by status in SQL — otherwise a backlog of drafts/archived fills the
  // row limit and pushes live strategies out (the "only paper shows" bug).
  const rows = await StrategyAdapter.listByCreatorStatuses(
    inboxId,
    OPEN_STRATEGY_STATUSES,
    30,
  );

  if (!rows.length) {
    await ctx.conversation.send(
      filter.isGroup(ctx.conversation)
        ? "no strategies yet — build one in our dm (VibeTrading → New Strategy) 💙"
        : "no strategies yet — tap New Strategy to build one 💙",
    );
    return;
  }

  // Render instantly from last-known DB pnl; refresh wallets on-chain in the
  // BACKGROUND so the menu never blocks on RPC round-trips. The detail view
  // pulls fresh PnL when the user taps a specific strategy.
  void syncCreatorStrategyPnls(inboxId, LIVE_STRATEGY_STATUSES).catch(
    () => undefined,
  );

  const paperRows = rows.filter((r) => r.status === "paper");
  const liveRows = rows.filter((r) => r.status !== "paper");
  const msgId = ctx.message.id.slice(0, 8);

  const buildAction = async (row: StrategyRow, isPaper: boolean) => {
    const shortId = row.id.replace(/-/g, "").slice(0, 12);
    const id = `strat_open_${shortId}_${msgId}`;
    const pnl = isPaper
      ? (await StrategyAdapter.summarizeTradePnl(row.id, new Map(), { paperOnly: true })).total
      : row.realized_pnl_usd;
    const baseLabel = formatStrategyListLabel(row.name, pnl);
    const label = isPaper ? `paper · ${baseLabel}` : baseLabel;
    registerAction(id, async (actionCtx: MessageContext) => {
      const strategy = await StrategyAdapter.getById(row.id);
      if (!strategy || strategy.creator_inbox_id !== actionCtx.message.senderInboxId) {
        await actionCtx.conversation.send(
          "that strategy menu belongs to someone else — open **My Strategies** from your VibeTrading menu",
        );
        return;
      }
      await showStrategyDetail(plugin, actionCtx, strategy);
    });
    return { id, label, style: "primary" as const };
  };

  const MAX_ACTIONS = 10;

  if (liveRows.length) {
    const visible = liveRows.slice(0, MAX_ACTIONS);
    await sendActions(ctx.conversation, {
      id: `strat_list_live_${msgId}`,
      description: livePaused
        ? `Live strategies (${liveRows.length}) — paused, tap for details:`
        : `Live strategies (${liveRows.length}) — tap for details:`,
      actions: await Promise.all(visible.map((r) => buildAction(r, false))),
    });
  }

  if (paperRows.length) {
    const visible = paperRows.slice(0, MAX_ACTIONS);
    const hiddenCount = paperRows.length - visible.length;
    const description =
      hiddenCount > 0
        ? `Paper trading (${paperRows.length}, showing ${MAX_ACTIONS}) — tap for details:`
        : `Paper trading (${paperRows.length}) — tap for details:`;
    await sendActions(ctx.conversation, {
      id: `strat_list_paper_${msgId}`,
      description,
      actions: await Promise.all(visible.map((r) => buildAction(r, true))),
    });
  }

  await plugin.sendPerpBackActions(ctx, "head back to VibeTrading:", `list_${msgId}`);
}

export async function showStrategyDetail(
  plugin: StrategyWizardDeps,
  ctx: MessageContext,
  row: StrategyRow,
): Promise<void> {
  const livePaused = isStrategyLiveTradingPaused();
  // Refresh on-chain PnL in the BACKGROUND so the card renders instantly from
  // last-known DB values instead of blocking on RPC round-trips + fee settlement.
  if (row.execution_wallet_address) {
    void syncStrategyWalletPnl(row.execution_wallet_address).catch(() => undefined);
  }
  const lines = await formatStrategyDetailLines(row);
  await sendMarkdownOrText(ctx as MessageContext<string>, lines.join("\n"));

  const msgId = ctx.message.id.slice(0, 8);
  const shortId = row.id.replace(/-/g, "").slice(0, 12);

  if (row.status === "paper") {
    await sendPaperStrategyActions(plugin, ctx, row, shortId, msgId);
    return;
  }

  const offId = `strat_off_${shortId}_${msgId}`;
  registerAction(offId, async (actionCtx: MessageContext) => {
    const strategy = await StrategyAdapter.getById(row.id);
    if (!strategy || strategy.creator_inbox_id !== actionCtx.message.senderInboxId) {
      await actionCtx.conversation.send(
        "that strategy menu belongs to someone else — open **My Strategies** from your VibeTrading menu",
      );
      return;
    }
    await StrategyAdapter.updateStatus(row.id, "archived");
    await actionCtx.conversation.send(
      `"${strategy.name}" is off — no new trades will run.`,
    );
    await plugin.sendPerpBackActions(actionCtx, "strategy turned off");
  });

  const saveId = `strat_save_${shortId}_${msgId}`;
  registerAction(saveId, async (actionCtx: MessageContext) => {
    const strategy = await StrategyAdapter.getById(row.id);
    if (!strategy || strategy.creator_inbox_id !== actionCtx.message.senderInboxId) {
      await actionCtx.conversation.send(
        "that strategy menu belongs to someone else — open **My Strategies** from your VibeTrading menu",
      );
      return;
    }
    if (strategy.status === "published") {
      await actionCtx.conversation.send(`"${strategy.name}" is saved and still running.`);
      await plugin.sendPerpBackActions(actionCtx, "strategy saved");
      return;
    }
    if (strategy.status === "testing" || strategy.status === "publishable") {
      if (isStrategyLiveTradingPaused()) {
        await actionCtx.conversation.send(LIVE_TRADING_PAUSED_MESSAGE);
        await plugin.sendPerpBackActions(actionCtx, "live trading paused");
        return;
      }
      // Don't list a strategy publicly until it has a real track record —
      // a 0-trade "published" strategy is misleading to anyone who follows it.
      const closed = await StrategyAdapter.listClosedTrades(row.id, PUBLISH_MIN_CLOSED_TRADES);
      if (closed.length < PUBLISH_MIN_CLOSED_TRADES) {
        await actionCtx.conversation.send(
          `"${strategy.name}" is still running 💙 — it'll be ready to publish after ${PUBLISH_MIN_CLOSED_TRADES} closed trades (has ${closed.length}) so followers can see real performance.`,
        );
        await plugin.sendPerpBackActions(actionCtx, "publish needs track record");
        return;
      }
      await StrategyAdapter.updateStatus(row.id, "published");
      await actionCtx.conversation.send(
        `"${strategy.name}" saved — still running on your ${BASEMATE_WALLET_LABEL}.`,
      );
      await plugin.sendPerpBackActions(actionCtx, "strategy saved");
      return;
    }
    await actionCtx.conversation.send(`"${strategy.name}" saved.`);
    await plugin.sendPerpBackActions(actionCtx, "strategy saved");
  });

  // Remix: traded strategies remix off the trade wiki + the user's direction;
  // un-traded ones remix off the prompt (no wiki yet).
  const hasTrades = row.trade_count > 0;
  const tuneId = `strat_${hasTrades ? "improve" : "remix"}_${shortId}_${msgId}`;
  registerAction(tuneId, async (actionCtx: MessageContext) => {
    const strategy = await StrategyAdapter.getById(row.id);
    if (!strategy || strategy.creator_inbox_id !== actionCtx.message.senderInboxId) {
      await actionCtx.conversation.send(
        "that strategy menu belongs to someone else — open **My Strategies** from your VibeTrading menu",
      );
      return;
    }
    if (hasTrades) {
      await startWikiRemix(plugin, actionCtx, strategy);
      return;
    }
    const k = pendingUserKey(actionCtx.message.senderInboxId, actionCtx.conversation.id);
    await stateSet(XK.lastStrategyPrompt(k), strategy.prompt);
    await stateSet(XK.lastStrategyConfig(k), strategy.config);
    pendingStrategyPrompt.add(k);
    touchPending(k);
    await actionCtx.conversation.send(
      `remixing "${strategy.name}" into a new strategy 💙 what should i change? e.g. "riskier", "eth only", "tighter stop"`,
    );
  });

  const detailBackId = `strat_detail_back_${shortId}_${msgId}`;
  registerPerpBackAction(plugin, detailBackId);

  await sendActions(ctx.conversation, {
    id: `strat_detail_${shortId}_${msgId}`,
    description: livePaused ? "manage this paused live strategy:" : "manage this strategy:",
    actions: [
      { id: offId, label: "OFF", style: "secondary" },
      { id: tuneId, label: "Remix", style: "secondary" },
      ...(livePaused ? [] : [{ id: saveId, label: "Save", style: "primary" as const }]),
      { id: detailBackId, label: "← Back", style: "secondary" },
    ],
  });
}

/**
 * Paper-strategy detail actions. Go Live checks the Basemate server wallet's USDC:
 * funded → "Go Live" (promote to real trading); unfunded → "Go live with USDC"
 * (routes to top-up first). OFF stops the paper run.
 */
export async function sendPaperStrategyActions(
  plugin: StrategyWizardDeps,
  ctx: MessageContext,
  row: StrategyRow,
  shortId: string,
  msgId: string,
): Promise<void> {
  const inboxId = ctx.message.senderInboxId;
  const margin = row.default_collateral_usdc ?? row.config.defaultCollateralUsdc ?? 25;
  const livePaused = isStrategyLiveTradingPaused();

  const wallet = livePaused
    ? null
    : await resolveBasemateServerWallet("xmtp", inboxId).catch(() => null);
  let funded = false;
  if (wallet) {
    const balances = await getBalances(wallet.walletAddress).catch(
      () => [] as Awaited<ReturnType<typeof getBalances>>,
    );
    const usdc = Number(
      balances.find((b) => b.contractAddress === BASE_USDC_ADDRESS)?.formatted ?? "0",
    );
    funded = usdc >= margin;
  }

  const goLiveId = `strat_golive_${shortId}_${msgId}`;
  registerAction(goLiveId, async (actionCtx: MessageContext) => {
    const strategy = await StrategyAdapter.getById(row.id);
    if (!strategy || strategy.creator_inbox_id !== actionCtx.message.senderInboxId) {
      await actionCtx.conversation.send(
        "that strategy belongs to someone else — open **My Strategies** from your VibeTrading menu",
      );
      return;
    }

    if (!funded) {
      await actionCtx.conversation.send(
        `fund your ${BASEMATE_WALLET_LABEL} with at least $${margin} USDC, then come back and tap Go Live 💙`,
      );
      if (wallet) {
        await plugin.renderPerpWalletTopUp(actionCtx, wallet.walletAddress);
      } else {
        await plugin.sendPerpBackActions(actionCtx, "go live — needs funding");
      }
      return;
    }

    await actionCtx.conversation.send("going live — settling paper trades and binding your wallet 💙");
    const deployed = await promotePaperToLive(row.id, actionCtx.message.senderInboxId);
    if (!deployed.ok) {
      if (deployed.blockedStrategy) {
        await sendMarkdownOrText(
          actionCtx as MessageContext<string>,
          `you're at the live limit — turn one off in My Strategies first (e.g. "${deployed.blockedStrategy.name}").`,
        );
      } else {
        await actionCtx.conversation.send(
          deployed.error ?? "couldn't go live — try again in a minute.",
        );
      }
      await plugin.sendPerpBackActions(actionCtx, "go live failed");
      return;
    }

    await sendMarkdownOrText(
      actionCtx as MessageContext<string>,
      [
        `🔵 **${row.name}** is live`,
        "",
        `markets: ${row.config.pairs.join(", ")}`,
        `direction: ${resolveStrategyDirection(row.config, row.prompt)}`,
        `margin: $${margin} per trade`,
        `leverage: ${row.config.maxLeverage}x`,
        "",
        "open trades: 0 · waiting for entry conditions — your money isn't in a position yet.",
      ].join("\n"),
    );
    await plugin.sendPerpBackActions(actionCtx, "went live");
  });

  const offId = `strat_paper_off_${shortId}_${msgId}`;
  registerAction(offId, async (actionCtx: MessageContext) => {
    const strategy = await StrategyAdapter.getById(row.id);
    if (!strategy || strategy.creator_inbox_id !== actionCtx.message.senderInboxId) {
      await actionCtx.conversation.send(
        "that strategy belongs to someone else — open **My Strategies** from your VibeTrading menu",
      );
      return;
    }
    await StrategyAdapter.updateStatus(row.id, "archived");
    await actionCtx.conversation.send(`"${strategy.name}" paper run stopped.`);
    await plugin.sendPerpBackActions(actionCtx, "paper stopped");
  });

  // Remix: traded strategies remix off the trade wiki + the user's direction;
  // un-traded ones remix off the prompt (no wiki yet).
  const hasTrades = row.trade_count > 0;
  const tuneId = `strat_${hasTrades ? "improve" : "remix"}_${shortId}_${msgId}`;
  registerAction(tuneId, async (actionCtx: MessageContext) => {
    const strategy = await StrategyAdapter.getById(row.id);
    if (!strategy || strategy.creator_inbox_id !== actionCtx.message.senderInboxId) {
      await actionCtx.conversation.send(
        "that strategy belongs to someone else — open **My Strategies** from your VibeTrading menu",
      );
      return;
    }
    if (hasTrades) {
      await startWikiRemix(plugin, actionCtx, strategy);
      return;
    }
    const k = pendingUserKey(actionCtx.message.senderInboxId, actionCtx.conversation.id);
    await stateSet(XK.lastStrategyPrompt(k), strategy.prompt);
    await stateSet(XK.lastStrategyConfig(k), strategy.config);
    pendingStrategyPrompt.add(k);
    touchPending(k);
    await actionCtx.conversation.send(
      `remixing "${strategy.name}" into a new strategy 💙 what should i change? e.g. "riskier", "eth only", "tighter stop"`,
    );
  });

  const backId = `strat_paper_back_${shortId}_${msgId}`;
  registerPerpBackAction(plugin, backId);

  await sendActions(ctx.conversation, {
    id: `strat_paper_detail_${shortId}_${msgId}`,
    description: livePaused
      ? "paper strategy — live trading paused, watching live prices:"
      : "paper strategy — watching live prices, no real funds:",
    actions: [
      ...(livePaused
        ? []
        : [{ id: goLiveId, label: funded ? "Go Live" : "Go live with USDC", style: "primary" as const }]),
      { id: tuneId, label: "Remix", style: "secondary" },
      { id: offId, label: "OFF", style: "secondary" },
      { id: backId, label: "← Back", style: "secondary" },
    ],
  });
}

export async function formatStrategyDetailLines(row: StrategyRow): Promise<string[]> {
  // DB-only snapshot (last-known unrealized from the trade rows) — no on-chain
  // calls here; the fresh sync runs in the background from showStrategyDetail.
  // paperOnly tracks the strategy's mode so a live strategy never shows its
  // paper-trade profit (and vice-versa).
  const snapshot = await StrategyAdapter.summarizeTradePnl(row.id, new Map(), {
    paperOnly: row.status === "paper",
  });
  const tradePnlRows = await StrategyAdapter.listTradePnlRows(row.id, {
    paperOnly: row.status === "paper",
  });
  const fmt = (n: number) => formatSignedUsdShort(n);
  const pairs = row.config.pairs.join(", ");
  const isPaper = row.status === "paper";
  const userSpecifiedSize =
    row.default_collateral_usdc != null || row.config.defaultCollateralUsdc != null;
  const sizeFallback = isPaper ? 100 : 25;
  const sizeUsdc = row.default_collateral_usdc ?? row.config.defaultCollateralUsdc ?? sizeFallback;
  const sizeLabel = Number.isInteger(sizeUsdc) ? String(sizeUsdc) : sizeUsdc.toFixed(2);
  // Show "(demo size)" when we bumped to $100 — keeps the paper result honest
  const sizeSuffix = isPaper && !userSpecifiedSize ? " (demo size)" : "";
  const closedLine =
    snapshot.closedCount > 0
      ? `closed: ${snapshot.closedCount} (${snapshot.wins}W / ${snapshot.losses}L)`
      : null;

  const header = isPaper ? `**${row.name}** · paper` : `**${row.name}**`;
  const lines = [
    header,
    "",
    `size: $${sizeLabel}${sizeSuffix}`,
    `leverage: ${row.config.maxLeverage}x`,
    `direction: ${resolveStrategyDirection(row.config, row.prompt)}`,
    `markets: ${pairs}`,
    `trades: ${row.trade_count}`,
    "",
    ...(closedLine ? [closedLine] : []),
    ...(tradePnlRows.length
      ? ["", "trade pnls:", ...tradePnlRows.map(formatTradePnlLine)]
      : []),
    "",
    `realized: ${fmt(snapshot.realized)}`,
    `unrealized (${snapshot.openCount} open): ${fmt(snapshot.unrealized)}`,
    `**total pnl: ${fmt(snapshot.total)}**`,
  ];
  return lines;
}

/**
 * Run the Opus authoring flow on a free-text prompt: elevate -> clamp ->
 * persist a draft -> explain it back. Re-arms capture so the user can refine
 * ("riskier", "eth only") or say it's good to lock it in. Never throws.
 */
export async function runPromptStrategy(
  plugin: StrategyWizardDeps,
  ctx: MessageContext,
  message: string,
  senderAddr: string,
): Promise<void> {
  const key = pendingUserKey(ctx.message.senderInboxId, ctx.conversation.id);
  const prior = await stateGet<string>(XK.lastStrategyPrompt(key));

  if (isStrategyCancel(message)) {
    await cancelStrategyPrompt(plugin, ctx);
    return;
  }

  // "can we do another?" / "start over" — begin a FRESH strategy, don't refine.
  const wordCount = message.trim().split(/\s+/).length;
  if (
    wordCount <= 6 &&
    /\b(another|new one|start over|fresh|different one|do another|make another|again)\b/i.test(message)
  ) {
    await stateDelete(XK.lastStrategyPrompt(key));
    pendingStrategyPrompt.add(key);
    touchPending(key);
    await ctx.conversation.send(
      "let's do it 💙 describe your next strategy and i'll build it — go as simple or as wild as you want.",
    );
    return;
  }

  if (prior && isStrategyAffirmation(message)) {
    await stateDelete(XK.lastStrategyPrompt(key));
    pendingStrategyPrompt.delete(key);
    await ctx.conversation.send(
      isStrategyLiveTradingPaused()
        ? "love it — locked in as a draft 💙 paper trade it whenever you're ready, or open New Strategy again to build another."
        : "love it — locked in as a draft 💙 tap Execute on it whenever you're ready, or open New Strategy again to build another.",
    );
    return;
  }

  // Initial prompt only — refinements like "riskier" or "eth only" stay short.
  if (!prior && wordCount < 3) {
    await ctx.conversation.send(
      'give me a little more to work with — like "scalp eth when it pumps" or "steady sol income" 💙',
    );
    pendingStrategyPrompt.add(key);
    touchPending(key);
    return;
  }

  // Refinement: feed the prior prompt + the new instruction so Opus adjusts.
  const isRefinement = Boolean(prior);
  const effectivePrompt = prior ? `${prior}\n\nuser refinement: ${message}` : message;
  // Carry the already-resolved sizing so a refinement tweaks the FINAL strategy,
  // not the messy original (no re-litigating min-notional / unreadable conditions).
  const baseConfig = isRefinement
    ? await stateGet<StrategyConfig>(XK.lastStrategyConfig(key))
    : undefined;

  await ctx.conversation.send("on it — designing your strategy 💙");
  const authored = await buildStrategyFromPrompt(
    effectivePrompt,
    baseConfig ? { baseConfig } : {},
  );

  let basename: string | null = null;
  try {
    basename = senderAddr ? await resolveBasename(senderAddr) : null;
  } catch {
    basename = null;
  }

  const draft = await StrategyAdapter.createDraft({
    name: authored.name,
    creatorInboxId: ctx.message.senderInboxId,
    creatorWallet: senderAddr || null,
    creatorBasename: basename,
    prompt: effectivePrompt,
    config: authored.config,
  });

  await stateSet(XK.lastStrategyPrompt(key), effectivePrompt);
  pendingStrategyPrompt.add(key);
  touchPending(key);

  // Orchestrate the decision chain: exit recommendation (a choice) first, then
  // the mandatory min-notional fix, then the final card. Nothing is applied
  // until the user picks — we never silently change their exits or sizing.
  // On refinements, the capability disclosure was already acknowledged, so we
  // suppress it (infoShown) and go straight to the tweak result.
  await presentBuiltStrategy(plugin, ctx, draft?.id ?? null, effectivePrompt, authored, {
    infoShown: isRefinement,
  });
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
export async function presentBuiltStrategy(
  plugin: StrategyWizardDeps,
  ctx: MessageContext,
  draftId: string | null,
  prompt: string,
  authored: AuthoredStrategy,
  opts: { resolvedExits?: "keep" | "recommend"; infoShown?: boolean } = {},
): Promise<void> {
  const infoLines = opts.infoShown ? [] : capabilityInfoLines(authored);

  // 1. Exit recommendation — a choice, presented before the mandatory fix.
  if (authored.exitChoice && !opts.resolvedExits && draftId) {
    await sendExitChoice(plugin, ctx, draftId, prompt, authored, infoLines);
    return;
  }

  // 2. Min-notional — mandatory when under $100 with user-stated sizing.
  if (authored.needsChoice && draftId) {
    await sendMinNotionalChoice(plugin, ctx, draftId, prompt, authored, {
      resolvedExits: opts.resolvedExits,
      infoLines,
    });
    return;
  }

  // 3. Nothing to decide but there ARE capability limits → confirm before building.
  if (infoLines.length && draftId) {
    await sendCapabilityConfirm(
      plugin,
      ctx,
      draftId,
      prompt,
      authored,
      infoLines,
      opts.resolvedExits,
    );
    return;
  }

  // 4. Final card.
  await renderFinalStrategyCard(plugin, ctx, draftId, prompt, authored, {
    resolveExits: opts.resolvedExits,
  });
}

/** Mandatory capability context (can't-read conditions, reinterpretations) as bullet lines. */
export function capabilityInfoLines(authored: AuthoredStrategy): string[] {
  const lines: string[] = [];
  if (authored.unsupported?.length) {
    const markets = authored.config.pairs
      .map((p) => p.replace(/-USD$/i, "").toLowerCase())
      .join(" / ");
    lines.push(
      `⚠️ i can't read ${humanJoin(authored.unsupported)} in v1 — i'd trade ${markets} on mark-price regimes (trend, breakouts, momentum fades) instead.`,
    );
  }
  if (authored.reinterpreted) lines.push(`🔁 ${authored.reinterpreted}`);
  return lines;
}

/**
 * Re-finalize with the user's resolved choices, persist, and render the final
 * card (spec, behavior notes, exit note, explanation) + actions.
 */
export async function renderFinalStrategyCard(
  plugin: StrategyWizardDeps,
  ctx: MessageContext,
  strategyId: string | null,
  prompt: string,
  authored: AuthoredStrategy,
  resolveOpts: {
    resolveExits?: "keep" | "recommend";
    resolveChoice?: "keepLeverage" | "keepMargin";
  },
): Promise<void> {
  let config = authored.config;
  let tpslNote = authored.tpslNote;
  let name = authored.name;

  if (strategyId && (resolveOpts.resolveExits || resolveOpts.resolveChoice)) {
    const row = await StrategyAdapter.getById(strategyId);
    if (row) {
      const fin = await finalizeStrategyConfig(prompt, row.config, resolveOpts);
      config = fin.config;
      tpslNote = fin.tpslNote;
      name = reconcileNameLeverage(authored.name, config.maxLeverage);
      await StrategyAdapter.updateConfig(strategyId, config, name);
    }
  }

  const k = pendingUserKey(ctx.message.senderInboxId, ctx.conversation.id);
  await stateSet(XK.lastStrategyPrompt(k), prompt);
  // Remember the resolved config so a later Remix refines THIS, not the original.
  await stateSet(XK.lastStrategyConfig(k), config);
  pendingStrategyPrompt.add(k);
  touchPending(k);

  const lines = [`🔵 ${name}`, "", formatStrategySpec(config)];
  if (authored.assumptions.length) {
    lines.push("", ...authored.assumptions.map((a) => `• ${a}`));
  }
  if (tpslNote) lines.push("", `• ${tpslNote}`);
  lines.push("", alignExplanationToConfig(config, authored.explanation));
  await sendMarkdownOrText(ctx as MessageContext<string>, lines.join("\n"));
  await sendStrategyActions(plugin, ctx, strategyId, name);
}

/**
 * Exit recommendation fork: the user's stated TP/SL differ from the
 * leverage-safe band. Offer to keep their exact exits (honored within absolute
 * rails) or take our tighter recommendation. Nothing is applied until they pick.
 */
export async function sendExitChoice(
  plugin: StrategyWizardDeps,
  ctx: MessageContext,
  strategyId: string,
  prompt: string,
  authored: AuthoredStrategy,
  infoLines: string[],
): Promise<void> {
  const msgId = ctx.message.id.slice(0, 8);
  const choice = authored.exitChoice!;
  const fmt = (n: number) =>
    Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, "");

  const pick = async (
    actionCtx: MessageContext,
    resolveExits: "keep" | "recommend",
  ): Promise<void> => {
    const row = await StrategyAdapter.getById(strategyId);
    if (!row || row.creator_inbox_id !== actionCtx.message.senderInboxId) {
      await actionCtx.conversation.send(
        "that strategy belongs to someone else — open My Strategies from your VibeTrading menu",
      );
      return;
    }
    // Continue the chain — exits resolved, capability info already shown.
    await presentBuiltStrategy(plugin, actionCtx, strategyId, prompt, authored, {
      resolvedExits: resolveExits,
      infoShown: true,
    });
  };

  const keepId = `strat_exit_keep_${msgId}`;
  registerAction(keepId, (actionCtx: MessageContext) => pick(actionCtx, "keep"));
  const recId = `strat_exit_rec_${msgId}`;
  registerAction(recId, (actionCtx: MessageContext) => pick(actionCtx, "recommend"));

  const desc = [`🔵 ${authored.name}`, ""];
  if (infoLines.length) desc.push(...infoLines, "");
  desc.push(
    `you asked for TP +${fmt(choice.originalTp)}% / SL -${fmt(choice.originalSl)}%. at ${authored.config.maxLeverage}x i'd recommend TP +${fmt(choice.recommendedTp)}% / SL -${fmt(choice.recommendedSl)}% for tighter risk on fast signals. which do you want?`,
  );

  const keepLabel = `keep mine (TP ${fmt(choice.originalTp)}% / SL ${fmt(choice.originalSl)}%)`;
  const recLabel = `use safe (TP ${fmt(choice.recommendedTp)}% / SL ${fmt(choice.recommendedSl)}%)`;
  await sendActions(ctx.conversation, {
    id: `strat_exit_fix_${msgId}`,
    description: desc.join("\n"),
    actions: [
      {
        id: keepId,
        label: keepLabel.length > 50 ? "keep my exits" : keepLabel,
        style: "primary",
      },
      {
        id: recId,
        label: recLabel.length > 50 ? "use recommended" : recLabel,
        style: "primary",
      },
    ],
  });
}

/**
 * Min-notional fork: the position is below Avantis's ~$100 minimum and the
 * user stated explicit sizing. Ask which fix they want — never silently bump.
 * Threads through any already-resolved exit choice so the final card is correct.
 */
export async function sendMinNotionalChoice(
  plugin: StrategyWizardDeps,
  ctx: MessageContext,
  strategyId: string,
  prompt: string,
  authored: AuthoredStrategy,
  opts: { resolvedExits?: "keep" | "recommend"; infoLines?: string[] } = {},
): Promise<void> {
  const msgId = ctx.message.id.slice(0, 8);
  const choice = authored.needsChoice!;
  const { originalCollateral, originalLeverage, keepLeverageMargin, keepMarginLeverage } = choice;
  const positionUsd = Math.round(originalCollateral * originalLeverage);

  const applyChoice = async (
    actionCtx: MessageContext,
    resolveChoice: "keepLeverage" | "keepMargin",
  ): Promise<void> => {
    const row = await StrategyAdapter.getById(strategyId);
    if (!row || row.creator_inbox_id !== actionCtx.message.senderInboxId) {
      await actionCtx.conversation.send(
        "that strategy belongs to someone else — open My Strategies from your VibeTrading menu",
      );
      return;
    }
    await renderFinalStrategyCard(plugin, actionCtx, strategyId, prompt, authored, {
      resolveExits: opts.resolvedExits,
      resolveChoice,
    });
  };

  const marginId = `strat_min_margin_${msgId}`;
  registerAction(marginId, (actionCtx: MessageContext) =>
    applyChoice(actionCtx, "keepLeverage"),
  );

  const levId = `strat_min_lev_${msgId}`;
  registerAction(levId, (actionCtx: MessageContext) =>
    applyChoice(actionCtx, "keepMargin"),
  );

  const desc = [`🔵 ${authored.name}`, ""];
  if (opts.infoLines?.length) desc.push(...opts.infoLines, "");
  desc.push(
    `$${originalCollateral} at ${originalLeverage}x is only a $${positionUsd} position — avantis needs at least a $100 position. pick a fix below 👇`,
  );

  const marginLabel = `Use $${keepLeverageMargin} margin (keep ${originalLeverage}x)`;
  const levLabel = `Use ${keepMarginLeverage}x (keep $${originalCollateral})`;
  await sendActions(ctx.conversation, {
    id: `strat_min_fix_${msgId}`,
    description: desc.join("\n"),
    actions: [
      {
        id: marginId,
        label: marginLabel.length > 50 ? `$${keepLeverageMargin} margin` : marginLabel,
        style: "primary",
      },
      {
        id: levId,
        label: levLabel.length > 50 ? `${keepMarginLeverage}x leverage` : levLabel,
        style: "primary",
      },
    ],
  });
}

/**
 * Capability confirm: nothing numeric to decide, but there ARE hard limits
 * (can't-read conditions / a reinterpretation). Show them and ask to proceed.
 */
export async function sendCapabilityConfirm(
  plugin: StrategyWizardDeps,
  ctx: MessageContext,
  strategyId: string,
  prompt: string,
  authored: AuthoredStrategy,
  infoLines: string[],
  resolvedExits?: "keep" | "recommend",
): Promise<void> {
  const msgId = ctx.message.id.slice(0, 8);

  const goId = `strat_cap_go_${msgId}`;
  registerAction(goId, async (actionCtx: MessageContext) => {
    const row = await StrategyAdapter.getById(strategyId);
    if (!row || row.creator_inbox_id !== actionCtx.message.senderInboxId) {
      await actionCtx.conversation.send(
        "that strategy belongs to someone else — open My Strategies from your VibeTrading menu",
      );
      return;
    }
    await renderFinalStrategyCard(plugin, actionCtx, strategyId, prompt, authored, {
      resolveExits: resolvedExits,
    });
  });

  const tweakId = `strat_cap_tweak_${msgId}`;
  registerAction(tweakId, async (actionCtx: MessageContext) => {
    const k = pendingUserKey(actionCtx.message.senderInboxId, actionCtx.conversation.id);
    await stateSet(XK.lastStrategyPrompt(k), prompt);
    pendingStrategyPrompt.add(k);
    touchPending(k);
    await actionCtx.conversation.send(
      "no worries 💙 tell me what to change — e.g. a different market or a simpler entry, and i'll rework it.",
    );
  });

  const desc = [
    `🔵 ${authored.name}`,
    "",
    "before i build it, here's the honest rundown 💙",
    "",
    ...infoLines,
    "",
    "want me to build it this way?",
  ];
  await sendActions(ctx.conversation, {
    id: `strat_cap_${msgId}`,
    description: desc.join("\n"),
    actions: [
      { id: goId, label: "build it 💙", style: "primary" },
      { id: tweakId, label: "let me tweak it", style: "secondary" },
    ],
  });
}

/**
 * Remix on a traded strategy: tell the user we'll learn from its trade wiki,
 * and ask for their own direction to combine with it. Their next message is
 * captured (pendingImproveFeedback) and fed into the wiki analysis. A "Use wiki
 * only" button lets them skip giving direction and let the agent decide.
 */
export async function startWikiRemix(
  plugin: StrategyWizardDeps,
  ctx: MessageContext,
  strategy: StrategyRow,
): Promise<void> {
  const key = pendingUserKey(ctx.message.senderInboxId, ctx.conversation.id);
  await stateSet(XK.pendingImproveFeedback(key), { strategyId: strategy.id });
  touchPending(key);

  const msgId = ctx.message.id.slice(0, 8);
  const wikiOnlyId = `strat_wiki_only_${msgId}`;
  registerAction(wikiOnlyId, async (actionCtx: MessageContext) => {
    const k = pendingUserKey(actionCtx.message.senderInboxId, actionCtx.conversation.id);
    await stateDelete(XK.pendingImproveFeedback(k));
    const s = await StrategyAdapter.getById(strategy.id);
    if (!s || s.creator_inbox_id !== actionCtx.message.senderInboxId) {
      await actionCtx.conversation.send(
        "that strategy belongs to someone else — open My Strategies from your VibeTrading menu",
      );
      return;
    }
    await runImproveStrategy(plugin, actionCtx, s, s.creator_wallet ?? "");
  });

  await sendActions(ctx.conversation, {
    id: `strat_remix_ask_${msgId}`,
    description: [
      `🔵 remix "${strategy.name}"`,
      "",
      "i'll use the Basemate Brain — everything its real trades have taught me — to propose a tuned version 💙",
      "",
      'tell me any direction to combine with that — e.g. "tighten the stops", "stop trading chop", "lean into breakouts" — or tap Use Basemate Brain and i\'ll decide.',
    ].join("\n"),
    actions: [{ id: wikiOnlyId, label: "Use Basemate Brain", style: "primary" }],
  });
}

export async function runImproveStrategy(
  plugin: StrategyWizardDeps,
  ctx: MessageContext,
  strategy: StrategyRow,
  senderAddr: string,
  observation?: string,
): Promise<void> {
  // Debounce double-taps: one Improve at a time per user+strategy.
  const inflightKey = `${ctx.message.senderInboxId}:${ctx.conversation.id}:${strategy.id}`;
  if (improveInFlight.has(inflightKey)) {
    await ctx.conversation.send("already on it 💙 one sec…");
    return;
  }
  improveInFlight.add(inflightKey);
  try {
    await runImproveStrategyInner(plugin, ctx, strategy, senderAddr, observation);
  } finally {
    improveInFlight.delete(inflightKey);
  }
}

export async function runImproveStrategyInner(
  plugin: StrategyWizardDeps,
  ctx: MessageContext,
  strategy: StrategyRow,
  senderAddr: string,
  observation?: string,
): Promise<void> {
  // trade_count counts opened trades, not closed ones — guard against running
  // Improve with nothing to analyze (no closed trades yet).
  const closed = await StrategyAdapter.listClosedTrades(strategy.id, 1);
  if (!closed.length) {
    const k = pendingUserKey(ctx.message.senderInboxId, ctx.conversation.id);
    await stateSet(XK.lastStrategyPrompt(k), strategy.prompt);
    pendingStrategyPrompt.add(k);
    touchPending(k);
    await ctx.conversation.send(
      `"${strategy.name}" hasn't closed any trades yet, so there's nothing to learn from just yet 💙 give it some time, or tell me what to change and i'll tweak it now — e.g. "riskier", "eth only", "tighter stop".`,
    );
    return;
  }

  await ctx.conversation.send("digging into your trades to see what's working 💙");

  const wiki = await buildTradeAnalysis(strategy.id);
  const { authored, diagnosis } = await improveStrategyFromWiki(strategy, wiki, observation);

  // Improve UPDATES this strategy in place — it does not spin up a new one. Bump a
  // visible version (v0.1 → v0.2 …) so the user can SEE the revision landed, and
  // show an explicit before→after diff of what changed.
  const versionedName = bumpStrategyVersion(strategy.name);
  const changes = formatConfigChanges(strategy.config, authored.config);

  const lines = [
    `🔵 ${strategy.name} → ${versionedName}`,
    "",
    `what i found: ${diagnosis}`,
    "",
    ...(changes.length ? ["changes:", ...changes.map((c) => `• ${c}`), ""] : []),
    formatStrategySpec(authored.config),
  ];
  if (authored.assumptions.length) {
    lines.push("", ...authored.assumptions.map((a) => `• ${a}`));
  }
  lines.push("", authored.explanation);
  if (!changes.length) {
    lines.push(
      "",
      "(this leaves the live settings unchanged — your current setup already matches.)",
    );
  }
  await sendMarkdownOrText(ctx as MessageContext<string>, lines.join("\n"));

  await sendImproveActions(plugin, ctx, strategy.id, versionedName, authored.config, changes);
}

/**
 * Apply / keep buttons for an Improve proposal. Apply updates the EXISTING
 * strategy's config in place (same id) and bumps a visible version on its name
 * so the change is obviously live — it never creates a new strategy.
 */
export async function sendImproveActions(
  plugin: StrategyWizardDeps,
  ctx: MessageContext,
  strategyId: string,
  versionedName: string,
  newConfig: StrategyConfig,
  changes: string[],
): Promise<void> {
  const msgId = ctx.message.id.slice(0, 8);

  const applyId = `strat_improve_apply_${msgId}`;
  registerAction(applyId, async (actionCtx: MessageContext) => {
    const row = await StrategyAdapter.getById(strategyId);
    if (!row || row.creator_inbox_id !== actionCtx.message.senderInboxId) {
      await actionCtx.conversation.send(
        "that strategy belongs to someone else — open My Strategies from your VibeTrading menu",
      );
      return;
    }
    // Update config in place + bump the version so it's visibly the new revision.
    await StrategyAdapter.updateConfig(strategyId, newConfig, versionedName);
    const confirmLines = [
      `✅ **${versionedName}** updated`,
      "",
      ...(changes.length ? ["what changed:", ...changes.map((c) => `• ${c}`), ""] : []),
      row.status === "paper"
        ? "this paper strategy uses the updated settings for new entries. open My Strategies to see the new version."
        : isStrategyLiveTradingPaused()
          ? "live trading is paused, but the strategy settings are updated. open My Strategies to see the new version."
          : "this is running on your Basemate wallet now — new entries use the updated settings. open My Strategies to see the new version.",
    ];
    await sendMarkdownOrText(actionCtx as MessageContext<string>, confirmLines.join("\n"));
    await plugin.sendPerpBackActions(actionCtx, "strategy improved");
  });

  const keepId = `strat_improve_keep_${msgId}`;
  registerAction(keepId, async (actionCtx: MessageContext) => {
    await actionCtx.conversation.send("kept your current setup 💙 nothing changed.");
    await plugin.sendPerpBackActions(actionCtx, "kept current");
  });

  await sendActions(ctx.conversation, {
    id: `strat_improve_${msgId}`,
    description: `apply this update (it'll become "${versionedName}") or keep the current setup?`,
    actions: [
      { id: applyId, label: "Apply update", style: "primary" },
      { id: keepId, label: "Keep current", style: "secondary" },
    ],
  });
}

/** Execute + Build-another buttons shown under a finished strategy. */
export async function sendStrategyActions(
  plugin: StrategyWizardDeps,
  ctx: MessageContext,
  strategyId: string | null,
  name: string,
): Promise<void> {
  const msgId = ctx.message.id.slice(0, 8);
  const livePaused = isStrategyLiveTradingPaused();
  const actions: Array<{ id: string; label: string; style: "primary" | "secondary" }> = [];

  if (strategyId) {
    const execId = `strat_exec_${msgId}`;
    registerAction(execId, async (actionCtx: MessageContext) => {
      const row = await StrategyAdapter.getById(strategyId);
      if (!row || row.creator_inbox_id !== actionCtx.message.senderInboxId) {
        await actionCtx.conversation.send(
          "that strategy belongs to someone else — open My Strategies from your VibeTrading menu",
        );
        await plugin.sendPerpBackActions(actionCtx, "couldn't deploy");
        return;
      }

      const strategyKey = pendingUserKey(
        actionCtx.message.senderInboxId,
        actionCtx.conversation.id,
      );
      pendingStrategyPrompt.delete(strategyKey);
      await stateDelete(XK.lastStrategyPrompt(strategyKey));

      if (
        row.status === "testing" ||
        row.status === "published" ||
        row.status === "publishable"
      ) {
        await sendMarkdownOrText(
          actionCtx as MessageContext<string>,
          `"${name}" is already running. VibeTrading → My Strategies to check PnL.`,
        );
        await plugin.sendPerpBackActions(actionCtx, "already running");
        return;
      }

      const deployed = await deployStrategy(strategyId, actionCtx.message.senderInboxId);
      if (!deployed.ok) {
        if (deployed.blockedStrategy) {
          await sendMarkdownOrText(
            actionCtx as MessageContext<string>,
            `you already have "${deployed.blockedStrategy.name}" live — turn it off in My Strategies first.`,
          );
          await plugin.sendPerpBackActions(actionCtx, "deploy blocked");
          return;
        }
        await actionCtx.conversation.send(
          deployed.error ?? "couldn't deploy that strategy — try again in a minute.",
        );
        await plugin.sendPerpBackActions(actionCtx, "deploy failed");
        return;
      }

      const margin = row.default_collateral_usdc ?? row.config.defaultCollateralUsdc ?? 25;
      const leverage = row.config.maxLeverage;
      const pairs = row.config.pairs.join(", ");
      const walletLine = deployed.walletAddress
        ? `${BASEMATE_WALLET_LABEL}: ${shortAddress(deployed.walletAddress)}\n${deployed.walletAddress}`
        : `${BASEMATE_WALLET_LABEL}: (fund USDC + ETH on Base before first trade)`;
      await sendMarkdownOrText(
        actionCtx as MessageContext<string>,
        [
          `🔵 **${name}** is live`,
          "",
          walletLine,
          `markets: ${pairs}`,
          `direction: ${resolveStrategyDirection(row.config, row.prompt)}`,
          `margin: $${margin} per trade`,
          `leverage: ${leverage}x`,
          "",
          "open trades: 0 · waiting for entry conditions — your money isn't in a position yet.",
          `warming up price data (about ${ORACLE_MIN_SAMPLES} min before first entry). VibeTrading → My Strategies to watch PnL.`,
        ].join("\n"),
      );
      await plugin.sendPerpBackActions(actionCtx, "strategy deployed");
    });

    const paperId = `strat_paper_${msgId}`;
    registerAction(paperId, async (actionCtx: MessageContext) => {
      const row = await StrategyAdapter.getById(strategyId);
      if (!row || row.creator_inbox_id !== actionCtx.message.senderInboxId) {
        await actionCtx.conversation.send(
          "that strategy belongs to someone else — open My Strategies from your VibeTrading menu",
        );
        await plugin.sendPerpBackActions(actionCtx, "couldn't paper trade");
        return;
      }

      const strategyKey = pendingUserKey(
        actionCtx.message.senderInboxId,
        actionCtx.conversation.id,
      );
      pendingStrategyPrompt.delete(strategyKey);
      await stateDelete(XK.lastStrategyPrompt(strategyKey));

      if (row.status === "paper") {
        await actionCtx.conversation.send(
          `"${name}" is already paper trading. VibeTrading → My Strategies to watch it.`,
        );
        await plugin.sendPerpBackActions(actionCtx, "already paper");
        return;
      }
      if (
        row.status === "testing" ||
        row.status === "published" ||
        row.status === "publishable"
      ) {
        await actionCtx.conversation.send(`"${name}" is already live.`);
        await plugin.sendPerpBackActions(actionCtx, "already live");
        return;
      }

      const res = await deployPaperStrategy(strategyId, actionCtx.message.senderInboxId);
      if (!res.ok) {
        await actionCtx.conversation.send(
          res.error ?? "couldn't start paper trading — try again in a minute.",
        );
        await plugin.sendPerpBackActions(actionCtx, "paper failed");
        return;
      }

      await sendMarkdownOrText(
        actionCtx as MessageContext<string>,
        [
          `📄 **${name}** is paper trading`,
          "",
          `markets: ${row.config.pairs.join(", ")}`,
          `direction: ${resolveStrategyDirection(row.config, row.prompt)}`,
          "",
          isStrategyLiveTradingPaused()
            ? "no real funds — watching live prices. track PnL in VibeTrading → My Strategies. paper ignores fees/slippage."
            : "no real funds — watching live prices. track PnL in VibeTrading → My Strategies. paper ignores fees/slippage, so live fills may differ. tap Go Live when you're ready 💙",
        ].join("\n"),
      );
      await plugin.sendPerpBackActions(actionCtx, "paper started");
    });
  }

  const remixId = `strat_remix_${msgId}`;
  registerAction(remixId, async (actionCtx: MessageContext) => {
    const k = pendingUserKey(actionCtx.message.senderInboxId, actionCtx.conversation.id);
    pendingStrategyPrompt.add(k);
    touchPending(k);
    await actionCtx.conversation.send(
      'what should i change? e.g. "riskier", "eth only", "tighter stop" 💙',
    );
  });

  const againId = `strat_again_${msgId}`;
  registerAction(againId, async (actionCtx: MessageContext) => {
    const k = pendingUserKey(actionCtx.message.senderInboxId, actionCtx.conversation.id);
    await stateDelete(XK.lastStrategyPrompt(k));
    pendingStrategyPrompt.add(k);
    touchPending(k);
    await actionCtx.conversation.send(
      "let's do it 💙 describe your next strategy and i'll build it.",
    );
  });

  const backId = `strat_back_${msgId}`;
  registerPerpBackAction(plugin, backId);

  // Desired order: Remix · Paper Trade · Execute · Build another · ← Back
  actions.length = 0;
  actions.push({ id: remixId, label: "✏️ Remix", style: "secondary" });
  if (strategyId) {
    actions.push({ id: `strat_paper_${msgId}`, label: "📄 Paper Trade", style: "secondary" });
    if (!livePaused) {
      actions.push({ id: `strat_exec_${msgId}`, label: "🔵 Execute", style: "primary" });
    }
  }
  actions.push({ id: againId, label: "👷 Build another", style: "secondary" });
  actions.push({ id: backId, label: "← Back", style: "secondary" });

  await sendActions(ctx.conversation, {
    id: `strat_actions_${msgId}`,
    description: livePaused
      ? "paper trade it or remix first:"
      : "paper trade it, go live, or remix first:",
    actions,
  });
}
