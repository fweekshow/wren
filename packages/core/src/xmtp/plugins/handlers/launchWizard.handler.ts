/**
 * launchWizard.handler — guided token-launch multi-step flow (XMTP / Base App).
 *
 * Native B20 stock-pair path: name → ticker → image → stock pair → confirm → user-signed create.
 * Bankr deploys are retired. iStonks / Stonks Exchange live in the standalone istonk service.
 */

import type { MessageContext } from "@xmtp/agent-sdk";
import type { Address } from "viem";

import type { LaunchToken } from "@/discovery/ai.js";
import { prepareB20StockPairLaunch } from "@/discovery/b20/createB20StockPair.js";
import { uploadLaunchMetadata } from "@/discovery/doppler/metadata.js";
import {
  listStockTokens,
  resolveStockToken,
} from "@/discovery/doppler/stockRegistry.js";
import { TokenLaunchAdapter } from "@/discovery/adapters/index.js";
import type { DiscoveryAI } from "@/discovery/ai/core.js";
import { stateDelete, stateGet, stateSet } from "@/state/conversationState.store.js";
import {
  sendActions,
  registerAction,
} from "@/xmtp/content-types/inline-actions/index.js";
import {
  resolveSenderWalletAddress,
} from "@/xmtp/core/index.js";
import { pendingUserKey } from "@/xmtp/core/pendingInteractionRegistry.js";
import { isLaunchImageSkip } from "@/xmtp/utils/launchImageUpload.js";
import { shouldAbandonPendingWizard } from "@/xmtp/utils/pendingWizard.util.js";
import { sendWalletSendCalls } from "@/xmtp/plugins/handlers/discovery.walletSend.js";
import {
  XK,
  type PendingDopplerLaunch,
} from "@/xmtp/plugins/handlers/discovery.stateKeys.js";

/** State carried between wizard steps (persisted in Redis). */
export type LaunchState = {
  name?: string;
  symbol?: string;
  imageUrl?: string;
  imagePromptDone?: boolean;
  /** bankr = retired; doppler_stock = leftover Redis; b20_stock = native B20 + V4 */
  mode?: "bankr" | "doppler_stock" | "b20_stock";
  pairSymbol?: string;
};

type PendingLaunch = {
  kind: "name" | "symbol" | "image" | "pair";
  state: LaunchState;
  token?: LaunchToken;
  walletAddress?: string;
  createdAt?: number;
  txConfirmUrl?: string;
};

/** Minimum surface of DiscoveryAI needed by the launch wizard. */
export interface LaunchWizardDeps {
  ai: Pick<DiscoveryAI, "recordTurn">;
  xk: {
    pendingLaunch: (key: string) => string;
    pendingActivityAt: (key: string) => string;
  };
}

function isStockPaired(state: LaunchState): boolean {
  return state.mode === "b20_stock" || state.mode === "doppler_stock";
}

function isB20Stock(state: LaunchState): boolean {
  return state.mode === "b20_stock";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Touch the activity timestamp so the key TTL stays alive mid-wizard. */
async function touchPending(xk: LaunchWizardDeps["xk"], key: string): Promise<void> {
  await stateSet(xk.pendingActivityAt(key), Date.now());
}

async function renderStockPairPicker(
  deps: LaunchWizardDeps,
  ctx: MessageContext,
  state: LaunchState,
): Promise<void> {
  const convId = ctx.conversation.id;
  const inboxId = ctx.message.senderInboxId;
  const pendingKey = pendingUserKey(inboxId, convId);
  const stocks = listStockTokens();

  if (stocks.length === 0) {
    await ctx.conversation.send(
      "no Coinbase B20 stock tokens are configured yet — set STOCK_TOKENS_JSON, or launch a regular token instead",
    );
    return;
  }

  await stateSet(deps.xk.pendingLaunch(pendingKey), { kind: "pair", state });
  await touchPending(deps.xk, pendingKey);

  const msgId = ctx.message.id.slice(0, 8);
  const prompt =
    `almost there — which stock should $${state.symbol} pair against?\n` +
    `(buyers will pay with that Coinbase B20 equity token)`;
  await ctx.conversation.send(prompt);
  deps.ai.recordTurn(convId, undefined, prompt);

  const actions = stocks.slice(0, 8).map((s) => {
    const id = `launch_pair_${s.symbol}_${msgId}`;
    registerAction(id, async (actionCtx: MessageContext) => {
      await stateDelete(
        deps.xk.pendingLaunch(
          pendingUserKey(actionCtx.message.senderInboxId, actionCtx.conversation.id),
        ),
      );
      await launchRenderStep(deps, actionCtx, { ...state, pairSymbol: s.symbol });
    });
    return { id, label: `$${s.symbol}`, style: "primary" as const };
  });

  await sendActions(ctx.conversation, {
    id: `launch_pair_pick_${msgId}`,
    description: "Pick a stock pair",
    actions,
  });
}

// ── Public handler functions ─────────────────────────────────────────────────

/**
 * Intercept free-text messages when a launch wizard session is in-flight.
 * Returns `true` if the message was consumed by the wizard (caller must stop).
 */
export async function launchTryHandleText(
  deps: LaunchWizardDeps,
  ctx: MessageContext<string>,
  pendingKey: string,
  rawContent: string,
): Promise<boolean> {
  const pendingLnch = await stateGet<PendingLaunch>(deps.xk.pendingLaunch(pendingKey));
  if (!pendingLnch) return false;

  const convId = ctx.conversation.id;
  const txt = rawContent.trim().replace(/^(?:@\S+\s+)+/i, "").trim();
  if (!txt && pendingLnch.kind !== "image") return false;

  if (pendingLnch.kind === "name" || pendingLnch.kind === "symbol") {
    const abandonKind = pendingLnch.kind === "name" ? "launch_name" : "launch_symbol";
    if (shouldAbandonPendingWizard(txt, abandonKind)) {
      await stateDelete(deps.xk.pendingLaunch(pendingKey));
      await stateDelete(deps.xk.pendingActivityAt(pendingKey));
      return false;
    }
  }

  if (pendingLnch.kind === "name") {
    if (txt.length >= 2 && txt.length <= 50) {
      await stateDelete(deps.xk.pendingLaunch(pendingKey));
      await launchRenderStep(deps, ctx, { ...pendingLnch.state, name: txt });
    } else {
      const errText = 'give me a token name (2–50 characters), e.g. "Pizza Coin"';
      await ctx.conversation.send(errText);
      deps.ai.recordTurn(convId, rawContent, errText);
      await touchPending(deps.xk, pendingKey);
    }
    return true;
  }

  if (pendingLnch.kind === "symbol") {
    const sym = txt.replace(/^\$/, "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    if (sym.length >= 2 && sym.length <= 10) {
      await stateDelete(deps.xk.pendingLaunch(pendingKey));
      await launchRenderStep(deps, ctx, { ...pendingLnch.state, symbol: sym });
    } else {
      const errText =
        "ticker should be 2–10 letters/numbers, no spaces — try again (e.g. PIZZA)";
      await ctx.conversation.send(errText);
      deps.ai.recordTurn(convId, rawContent, errText);
      await touchPending(deps.xk, pendingKey);
    }
    return true;
  }

  if (pendingLnch.kind === "pair") {
    const resolved = resolveStockToken(txt);
    if (resolved) {
      await stateDelete(deps.xk.pendingLaunch(pendingKey));
      await launchRenderStep(deps, ctx, {
        ...pendingLnch.state,
        pairSymbol: resolved.symbol,
      });
    } else {
      const available = listStockTokens()
        .map((s) => `$${s.symbol}`)
        .join(", ");
      await ctx.conversation.send(
        `i don't have that stock configured — pick one of: ${available || "(none yet)"}`,
      );
      await touchPending(deps.xk, pendingKey);
    }
    return true;
  }

  // kind === "image"
  if (isLaunchImageSkip(txt)) {
    await stateDelete(deps.xk.pendingLaunch(pendingKey));
    await launchRenderStep(deps, ctx, { ...pendingLnch.state, imagePromptDone: true });
    return true;
  }
  if (txt) {
    await ctx.conversation.send(
      "send a photo for your token image, or reply skip to launch without one",
    );
  }
  return true;
}

/**
 * Render the current wizard step. Given the state so far it renders only the
 * FIRST missing field (name → ticker → image → [pair] → confirm).
 */
export async function launchRenderStep(
  deps: LaunchWizardDeps,
  ctx: MessageContext,
  state: LaunchState,
): Promise<void> {
  const convId = ctx.conversation.id;
  const inboxId = ctx.message.senderInboxId;
  const pendingKey = pendingUserKey(inboxId, convId);

  if (!state.name) {
    await stateSet(deps.xk.pendingLaunch(pendingKey), { kind: "name", state });
    await touchPending(deps.xk, pendingKey);
    const prompt = isB20Stock(state)
      ? 'let\'s launch a B20 token paired with a Coinbase stock 🚀 what would you like to call it? (e.g. "Pizza Coin")'
      : isStockPaired(state)
        ? 'let\'s launch a stock-paired token on Doppler 🚀 what would you like to call it? (e.g. "Pizza Coin")'
        : 'let\'s launch your token 🚀 what would you like to call it? (e.g. "Pizza Coin")';
    await ctx.conversation.send(prompt);
    deps.ai.recordTurn(convId, undefined, prompt);
    return;
  }

  if (!state.symbol) {
    await stateSet(deps.xk.pendingLaunch(pendingKey), { kind: "symbol", state });
    await touchPending(deps.xk, pendingKey);
    const prompt = `got it — "${state.name}". what would you like the ticker to be? (2–10 letters, e.g. PIZZA)`;
    await ctx.conversation.send(prompt);
    deps.ai.recordTurn(convId, state.name, prompt);
    return;
  }

  if (!state.imagePromptDone) {
    await stateSet(deps.xk.pendingLaunch(pendingKey), { kind: "image", state });
    await ctx.conversation.send(
      `nice — $${state.symbol}. want a token image? send a photo here, or reply skip`,
    );
    return;
  }

  if (isStockPaired(state) && !state.pairSymbol) {
    await renderStockPairPicker(deps, ctx, state);
    return;
  }

  if (isStockPaired(state) && state.pairSymbol) {
    const pair = resolveStockToken(state.pairSymbol);
    if (!pair) {
      await renderStockPairPicker(deps, ctx, { ...state, pairSymbol: undefined });
      return;
    }
  }

  // ── Review + confirm ──────────────────────────────────────────────────────
  await stateDelete(deps.xk.pendingLaunch(pendingKey));
  const msgId = ctx.message.id.slice(0, 8);
  const confirmId = `launch_go_${msgId}`;
  const cancelId = `launch_cancel_${msgId}`;

  registerAction(confirmId, async (actionCtx: MessageContext) => {
    await launchExecute(deps, actionCtx, state);
  });
  registerAction(cancelId, async (actionCtx: MessageContext) => {
    await stateDelete(
      deps.xk.pendingLaunch(pendingUserKey(actionCtx.message.senderInboxId, actionCtx.conversation.id)),
    );
    await actionCtx.conversation.send("ok, scrapped it 🫡 ping me whenever you wanna launch");
  });

  const imageLine = state.imageUrl ? "image: yes" : "image: none";
  const pairLine =
    isStockPaired(state) && state.pairSymbol
      ? `pair: $${state.pairSymbol} (Coinbase B20)\n`
      : "";
  const reviewText = isB20Stock(state)
    ? `here's your B20 launch 👇\n\n` +
      `name: ${state.name}\n` +
      `ticker: $${state.symbol}\n` +
      pairLine +
      `${imageLine}\n\n` +
      `tap below to create $${state.symbol} and seed the $${state.symbol}/$${state.pairSymbol} pool on Base:`
    : isStockPaired(state)
      ? `here's your Doppler launch 👇\n\n` +
        `name: ${state.name}\n` +
        `ticker: $${state.symbol}\n` +
        pairLine +
        `${imageLine}\n\n` +
        `tap below to sign the create tx on Base — buyers will trade $${state.symbol} against $${state.pairSymbol}:`
      : `here's your launch 👇\n\n` +
        `name: ${state.name}\n` +
        `ticker: $${state.symbol}\n` +
        `${imageLine}\n\n` +
        `heads up — i can't set a logo or socials from here. tap below to deploy on Base:`;
  await ctx.conversation.send(reviewText);
  deps.ai.recordTurn(convId, undefined, reviewText);

  await sendActions(ctx.conversation, {
    id: `launch_confirm_${msgId}`,
    description: `Launch $${state.symbol}?`,
    actions: [
      {
        id: confirmId,
        label: isStockPaired(state)
          ? `🚀 Launch $${state.symbol} / $${state.pairSymbol}`
          : `🚀 Launch $${state.symbol}`,
        style: "primary" as const,
      },
      { id: cancelId, label: "Cancel", style: "secondary" as const },
    ],
  });
}

/**
 * Deploy after the user taps "🚀 Launch".
 * B20 (and leftover Doppler sessions) encode + wallet_sendCalls. Bankr is retired.
 */
export async function launchExecute(
  deps: LaunchWizardDeps,
  ctx: MessageContext,
  state: LaunchState,
): Promise<void> {
  if (isB20Stock(state) || state.mode === "doppler_stock") {
    return launchExecuteB20(deps, ctx, state);
  }
  return launchExecuteBankr(deps, ctx, state);
}

async function launchExecuteBankr(
  deps: LaunchWizardDeps,
  ctx: MessageContext,
  state: LaunchState,
): Promise<void> {
  // Bankr launches are retired. Keep B20 on this bot; do not send users to iStonks.
  void deps;
  void state;
  await ctx.conversation.send(
    "Bankr launches are retired — say launch and I can start a B20 stock-paired token here",
  );
}

async function launchExecuteB20(
  deps: LaunchWizardDeps,
  ctx: MessageContext,
  state: LaunchState,
): Promise<void> {
  if (!state.name || !state.symbol || !state.pairSymbol) {
    await ctx.conversation.send(
      "something dropped out of the launch details — start over and tell me the name, ticker, and stock pair 🙏",
    );
    return;
  }

  const wallet = (await resolveSenderWalletAddress(ctx as any)) || "";
  if (!wallet || wallet === "0x0000000000000000000000000000000000000000") {
    await ctx.conversation.send(
      "i can't read your wallet address right now — try again in a sec 🫠",
    );
    return;
  }

  const pair = resolveStockToken(state.pairSymbol);
  if (!pair) {
    await ctx.conversation.send(
      `$${state.pairSymbol} isn't in the stock registry — pick a configured Coinbase B20 equity`,
    );
    return;
  }

  console.log(
    `🚀 b20 stock launch: name="${state.name}" symbol="${state.symbol}" ` +
      `pair=$${pair.symbol} tapperInboxId=${ctx.message.senderInboxId} user=${wallet}`,
  );

  const rateLimit = await TokenLaunchAdapter.checkRateLimit(wallet);
  if (rateLimit.status !== "allowed") {
    await ctx.conversation.send(
      rateLimit.message ?? "max 3 token launches per wallet per day — try again tomorrow",
    );
    return;
  }

  await ctx.conversation.send(
    `prepping $${state.symbol} / $${pair.symbol} as a B20 pool… sign the tx when it pops up 🛠️`,
  );

  try {
    const tokenURI = await uploadLaunchMetadata({
      name: state.name,
      symbol: state.symbol,
      image: state.imageUrl,
    });

    const prepared = await prepareB20StockPairLaunch({
      name: state.name,
      symbol: state.symbol,
      contractURI: tokenURI,
      userAddress: wallet as Address,
      pairSymbol: pair.symbol,
      pair,
    });

    const pending: PendingDopplerLaunch = {
      name: state.name,
      symbol: state.symbol,
      pairSymbol: pair.symbol,
      pairAddress: pair.address,
      predictedToken: prepared.predictedToken,
      wallet,
      createdAt: Date.now(),
    };
    await stateSet(XK.pendingB20Launch(ctx.conversation.id), pending);

    await sendWalletSendCalls(
      ctx as MessageContext<string>,
      prepared.calls,
      prepared.chainId,
      `sign to create $${state.symbol} and seed the $${state.symbol}/$${pair.symbol} B20 pool\n` +
        `predicted token: https://basescan.org/token/${prepared.predictedToken}`,
      wallet,
      "basemate",
    );
  } catch (err) {
    console.warn("⚠️ b20 stock launch prepare failed:", err);
    await TokenLaunchAdapter.recordAttempt({
      wallet,
      tokenName: state.name,
      tokenSymbol: state.symbol,
      status: "failed",
    });
    await stateDelete(XK.pendingB20Launch(ctx.conversation.id));
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.conversation.send(
      `couldn't prepare the B20 create right now — ${msg.slice(0, 200)}`,
    );
  }
}

/** Shared success path: Basescan link + optional XMTP community group. */
export async function finalizeLaunchSuccess(
  ctx: MessageContext,
  opts: {
    name: string;
    symbol: string;
    tokenAddress: string;
    pairSymbol?: string;
    txHash?: string;
  },
): Promise<void> {
  const addr = opts.tokenAddress;
  const pairNote = opts.pairSymbol
    ? `\nbuyers trade against $${opts.pairSymbol} (Coinbase B20).`
    : "\ntrading fees go straight to your wallet.";
  const txNote = opts.txHash ? `\ntx: https://basescan.org/tx/${opts.txHash}` : "";
  const successMsg =
    `🚀 $${opts.symbol} is live on Base!${pairNote}\n\n` +
    `token: https://basescan.org/token/${addr}${txNote}`;

  const clicker = ctx.message.senderInboxId;
  try {
    const group = await ctx.client.conversations.newGroup([clicker], {
      groupName: `$${opts.symbol}`,
      groupDescription: opts.pairSymbol
        ? `${opts.name} — B20 launch paired with $${opts.pairSymbol} via Basemate`
        : `${opts.name} — launched on Base with Basemate`,
    });
    try {
      await (group as any).addSuperAdmin(clicker);
      console.log(`👑 promoted ${clicker.slice(0, 8)} to super-admin of $${opts.symbol} group`);
    } catch (promoteErr) {
      console.warn("⚠️ failed to promote launcher to super-admin (non-fatal):", promoteErr);
    }
    await group.send(successMsg);
    await ctx.conversation.send(
      `${successMsg}\n\noh and i also spun up a group chat for your $${opts.symbol} community on base app — check your inbox 👀`,
    );
  } catch (err) {
    console.warn("⚠️ launch group creation failed, falling back to inline reply:", err);
    await ctx.conversation.send(successMsg);
  }
}

/**
 * Called from DiscoveryPlugin after wallet_sendCalls confirms.
 * Completes a pending Doppler stock-paired launch.
 */
export function defaultLaunchState(): LaunchState {
  return { mode: "b20_stock" };
}

/** Map the pending launch state onto the launch-log columns. */
function launchAttemptFields(pending: PendingDopplerLaunch) {
  return {
    wallet: pending.wallet,
    tokenName: pending.name,
    tokenSymbol: pending.symbol,
    tokenAddress: pending.predictedToken,
    poolId: pending.poolId,
    pairAddress: pending.pairAddress,
    pairSymbol: pending.pairSymbol,
    beneficiaries: pending.beneficiaries,
  };
}

/**
 * Called from DiscoveryPlugin after wallet_sendCalls confirms.
 * Completes a pending native B20 stock-paired launch.
 */
export async function finalizePendingB20Launch(
  ctx: MessageContext,
  txHash?: string,
): Promise<boolean> {
  const pending = await stateGet<PendingDopplerLaunch>(
    XK.pendingB20Launch(ctx.conversation.id),
  );
  if (!pending) return false;

  await stateDelete(XK.pendingB20Launch(ctx.conversation.id));

  await TokenLaunchAdapter.recordAttempt({
    ...launchAttemptFields(pending),
    status: "success",
    txHash,
  });

  await finalizeLaunchSuccess(ctx, {
    name: pending.name,
    symbol: pending.symbol,
    tokenAddress: pending.predictedToken,
    pairSymbol: pending.pairSymbol,
    txHash,
  });
  return true;
}

export async function finalizePendingDopplerLaunch(
  ctx: MessageContext,
  txHash?: string,
): Promise<boolean> {
  const pending = await stateGet<PendingDopplerLaunch>(
    XK.pendingDopplerLaunch(ctx.conversation.id),
  );
  if (!pending) return false;

  await stateDelete(XK.pendingDopplerLaunch(ctx.conversation.id));

  await TokenLaunchAdapter.recordAttempt({
    ...launchAttemptFields(pending),
    status: "success",
    txHash,
  });

  await finalizeLaunchSuccess(ctx, {
    name: pending.name,
    symbol: pending.symbol,
    tokenAddress: pending.predictedToken,
    pairSymbol: pending.pairSymbol,
    txHash,
  });
  return true;
}
