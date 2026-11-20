// ─── core.ts ─────────────────────────────────────────────────────────────────
// DiscoveryAI class — the main entry point for the AI engine.
// Moved here from discovery/ai.ts as part of Phase 3 PR 3.8 decomposition.
// discovery/ai.ts is now a pure barrel re-exporter.
// ─────────────────────────────────────────────────────────────────────────────

import OpenAI from "openai";
import type { BankrLaunchSort } from "@basemate/shared";
import { ConversationMemoryAdapter } from "@/discovery/adapters/conversationMemory.adapter.js";
import { ConversationMessageAdapter } from "@/discovery/adapters/conversationMessage.adapter.js";
import { UserMemoryAdapter } from "@/discovery/adapters/userMemory.adapter.js";
import { checkInboundContentGuardrails } from "@/discovery/contentGuardrails.js";
import { assertSwapUsdWithinLimit } from "@/discovery/ai/amounts.js";
import { validateToolArgs } from "@/discovery/ai/tools/argSchemas.js";
import { FEW_SHOT_EXAMPLES, getSystemPrompt } from "@/discovery/ai/prompts.js";
import { type AIResponse } from "@/discovery/ai/types.js";
import {
  detectWalletIntent,
  isPostCardAck,
  parseGiftStock,
  parsePerpProfileSetup,
  parseSimplePerp,
  parseSimpleUsdBuy,
  parseSimpleUsdSend,
  parseSimpleTokenSend,
  parseBareSendRecipient,
  extractPendingSendFromHistory,
  pickCardNudge,
} from "@/discovery/ai/intents.js";
import { isKnownStockPairCandidate } from "@/discovery/doppler/stockRegistry.js";
import { getTools } from "@/discovery/ai/tools/index.js";
import {
  MODEL,
  type RespondCtx,
  type ToolResult,
  DEFAULT_REPLY,
  historyTextForControl,
  isTerminalAiResponse,
  routeMenuOpener,
  recordRoutingEvalTool,
  finalizeTextResponse,
  Toolbox,
  routeDeterministicIntent,
  tryAiDownFallback,
  MAX_HISTORY_TURNS,
  HISTORY_BOOTSTRAP_MIN,
  HISTORY_BOOTSTRAP_FETCH,
  resolveMaxTokens,
  isComplexQuery,
  resolveModelForMessage,
  compactHistory,
} from "@/discovery/ai/toolbox.js";
import { getConversationHistory, type ConversationHistorySource } from "@/xmtp/utils/history.js";
import { isMenuNavigationIntent } from "@/xmtp/utils/menuNavigationIntent.util.js";
import {
  createBankrLlmClient,
  logLlmTurn,
  openAiChatParams,
  providerForModel,
} from "@/llm/config.js";
import { stateGet, stateSet } from "@/state/conversationState.store.js";

/**
 * Builds the structured intent-engine hint appended to the system prompt.
 * Surfaces the fast-path classifier's parsed fields (action, asset, amount,
 * recipient) so the LLM can immediately call the right tool with the right
 * arguments instead of re-deriving them from freeform text.
 */
function buildIntentHint(ctx: RespondCtx): string {
  if (!ctx.intentAction || ctx.intentAction === "discovery" || ctx.intentAction === "unknown") {
    return "";
  }
  const parts: string[] = [`intent: ${ctx.intentAction}`];
  if (ctx.intentTargetName) parts.push(`recipient: ${ctx.intentTargetName}`);
  if (ctx.intentAsset) parts.push(`asset: ${ctx.intentAsset}`);
  if (ctx.intentAmount) parts.push(`amount: ${ctx.intentAmount}`);
  return `\n\n[intent engine parsed — ${parts.join(", ")}]`;
}

export class DiscoveryAI {
  private openai: OpenAI;
  private model: string;
  // conversationId → trimmed chat history (user/assistant only, no tool calls)
  private history = new Map<string, OpenAI.Chat.Completions.ChatCompletionMessageParam[]>();
  // conversationId → type of the last response we sent (to nudge instead of
  // re-preparing an identical card when the user just acknowledges it).
  private lastResponseType = new Map<string, string>();
  // Metadata needed for durable Postgres write-through; populated on each respond() call.
  private convMeta = new Map<string, { inboxId: string; platform: string }>();

  // TTL for Redis-persisted history — 24 hours so context survives process restarts
  // and overnight gaps between iMessage sessions.
  private static readonly HISTORY_TTL_SECONDS = 24 * 60 * 60;

  constructor(opts?: { model?: string }) {
    this.openai = createBankrLlmClient();
    this.model = opts?.model ?? MODEL;
  }

  /** Menu/button path — compare yield for a token without NL routing (avoids "on base" → BASE). */
  async runYieldCompare(token: string, ctx: RespondCtx): Promise<AIResponse> {
    const convId = ctx.conversationId ?? ctx.inboxId;
    const toolbox = new Toolbox({ ...ctx, userMessage: `earn on ${token}` });
    recordRoutingEvalTool(ctx, "yield_compare", { token });
    const result = await toolbox.yield_compare({ token });
    if (result.control) {
      this.appendHistory(convId, `earn on ${token}`, historyTextForControl(result.control));
      return result.control;
    }
    return { type: "text", text: DEFAULT_REPLY };
  }

  /** Menu/button path — send token without NL routing (avoids LLM mis-parsing USDC). */
  async runSendToken(
    ctx: RespondCtx,
    args: { to: string; asset: string; amount: string; isUsd?: boolean },
  ): Promise<AIResponse> {
    const convId = ctx.conversationId ?? ctx.inboxId;
    const label = `send $${args.amount} ${args.asset} to ${args.to}`;
    const toolbox = new Toolbox({ ...ctx, userMessage: label });
    recordRoutingEvalTool(ctx, "send_token", args);
    const result = await toolbox.send_token(args);
    if (result.control) {
      this.appendHistory(convId, label, historyTextForControl(result.control));
      return result.control;
    }
    const errText =
      typeof result.data === "object" &&
      result.data &&
      "error" in result.data &&
      typeof (result.data as { error?: unknown }).error === "string"
        ? (result.data as { error: string }).error
        : "couldn't prepare that send — try again in a sec";
    return { type: "text", text: errText };
  }

  /** Menu/button path — multiple sends in one wallet_sendCalls (e.g. USDC + gas). */
  async runSendTokenBundle(
    ctx: RespondCtx,
    args: {
      to: string;
      transfers: Array<{ asset: string; amount: string; isUsd?: boolean }>;
      label?: string;
    },
  ): Promise<AIResponse> {
    const convId = ctx.conversationId ?? ctx.inboxId;
    const summary =
      args.label ??
      args.transfers.map((t) => `$${t.amount} ${t.asset}`).join(" + ");
    const toolbox = new Toolbox({ ...ctx, userMessage: `send ${summary} to ${args.to}` });
    recordRoutingEvalTool(ctx, "send_token_bundle", args);
    const result = await toolbox.send_token_bundle(args);
    if (result.control) {
      this.appendHistory(convId, summary, historyTextForControl(result.control));
      return result.control;
    }
    const errText =
      typeof result.data === "object" &&
      result.data &&
      "error" in result.data &&
      typeof (result.data as { error?: unknown }).error === "string"
        ? (result.data as { error: string }).error
        : "couldn't prepare that send — try again in a sec";
    return { type: "text", text: errText };
  }

  /** Menu/button path — fresh + trending Bankr tokens without NL misrouting to groups. */
  async runTrendingTokens(ctx: RespondCtx): Promise<AIResponse> {
    const convId = ctx.conversationId ?? ctx.inboxId;
    const toolbox = new Toolbox({ ...ctx, userMessage: "what's trending" });
    const args = { limit: 8, sort: "mixed" as BankrLaunchSort };
    recordRoutingEvalTool(ctx, "bankr_get_launches", args);
    const result = await toolbox.bankr_get_launches(args);
    if (result.control) {
      this.appendHistory(convId, "trending", historyTextForControl(result.control));
      return result.control;
    }
    return { type: "text", text: DEFAULT_REPLY };
  }

  /** Record wizard or plugin turns so the model sees recent UI prompts. */
  recordTurn(convId: string, userText: string | undefined, assistantText: string): void {
    const assistant = assistantText.trim();
    if (!assistant) return;
    if (userText?.trim()) {
      this.appendHistory(convId, userText.trim(), assistant);
      return;
    }
    const prior = this.history.get(convId) ?? [];
    const updated: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      ...prior,
      { role: "assistant", content: assistant },
    ];
    const trimmed = updated.slice(-MAX_HISTORY_TURNS);
    this.history.set(convId, trimmed);
    // Fire-and-forget Redis persistence for assistant-only turns.
    void stateSet(`ai:history:${convId}`, trimmed, DiscoveryAI.HISTORY_TTL_SECONDS);
    // Fire-and-forget Postgres write-through for assistant-only turns.
    const meta = this.convMeta.get(convId);
    if (meta) {
      void ConversationMessageAdapter.insert({
        inboxId: meta.inboxId,
        conversationId: convId,
        platform: meta.platform,
        role: "assistant",
        content: assistant,
      });
    }
  }

  private async historyForApi(
    convId: string,
    ctx: RespondCtx,
  ): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
    let memory = this.history.get(convId) ?? [];
    // Cold start: bootstrap from Redis so context survives process restarts.
    // This is the only place we do a synchronous Redis read on the hot path;
    // subsequent turns are served from the in-process map.
    if (memory.length === 0) {
      try {
        const persisted = await stateGet<OpenAI.Chat.Completions.ChatCompletionMessageParam[]>(
          `ai:history:${convId}`,
        );
        if (persisted?.length) {
          memory = persisted;
          this.history.set(convId, memory);
        }
      } catch {
        // Redis unavailable — continue with empty in-memory history
      }
    }
    // Postgres fallback: when Redis is also cold (>24h gap), bootstrap from the
    // durable conversation_messages table so the AI never starts blind.
    if (memory.length === 0) {
      try {
        const dbRows = await ConversationMessageAdapter.getRecent(convId, HISTORY_BOOTSTRAP_FETCH);
        if (dbRows.length) {
          memory = dbRows;
          this.history.set(convId, memory);
        }
      } catch {
        // DB unavailable — continue with empty history
      }
    }
    if (memory.length >= HISTORY_BOOTSTRAP_MIN || !ctx.conversation || !ctx.agentInboxId) {
      return compactHistory(memory);
    }
    try {
      const boot = await getConversationHistory(
        {
          conversation: ctx.conversation as ConversationHistorySource["conversation"],
          agentInboxId: ctx.agentInboxId,
          excludeMessageId: ctx.currentMessageId,
        },
        HISTORY_BOOTSTRAP_FETCH,
      );
      if (!boot.length) return compactHistory(memory);
      return compactHistory(
        boot.slice(-MAX_HISTORY_TURNS).map((m) => ({
          role: m.role,
          content: m.content,
        })),
      );
    } catch (e: unknown) {
      console.warn("⚠️ history bootstrap failed:", (e as Error)?.message || e);
      return compactHistory(memory);
    }
  }

  async respond(message: string, ctx: RespondCtx): Promise<AIResponse> {
    const convId = ctx.conversationId ?? ctx.inboxId;
    // Track metadata for durable write-through (fire-and-forget on each turn).
    if (ctx.inboxId) {
      this.convMeta.set(convId, {
        inboxId: ctx.inboxId,
        platform: ctx.copyPlatform ?? "xmtp",
      });
    }
    // If a transaction card is already on screen and the user just acks it
    // ("sign it", "resend", "go", "yes"), nudge them to it instead of
    // re-preparing an identical card (kills the robotic re-issue loop).
    if (
      message?.trim() &&
      this.lastResponseType.get(convId) === "transaction" &&
      isPostCardAck(message)
    ) {
      const nudge = pickCardNudge();
      this.appendHistory(convId, message, nudge);
      this.lastResponseType.set(convId, "text");
      return { type: "text", text: nudge };
    }
    const resp = await this.respondInner(message, ctx);
    this.lastResponseType.set(convId, resp.type);
    return resp;
  }

  private async respondInner(message: string, ctx: RespondCtx): Promise<AIResponse> {
    if (!message?.trim()) {
      return { type: "text", text: DEFAULT_REPLY };
    }

    const convId = ctx.conversationId ?? ctx.inboxId;
    const guardrail = ctx.skipContentGuardrails ? null : checkInboundContentGuardrails(message);
    if (guardrail) {
      this.appendHistory(convId, message, guardrail.reply);
      return { type: "text", text: guardrail.reply };
    }

    if (ctx.inboxId) {
      void ConversationMemoryAdapter.rememberPreferenceFromTurn({
        inboxId: ctx.inboxId,
        conversationId: convId,
        userMessage: message,
      });
    }
    const hasHistory = (this.history.get(convId) ?? []).length > 0;
    const menuOpener = routeMenuOpener(message, hasHistory);
    if (menuOpener) {
      this.appendHistory(convId, message, historyTextForControl(menuOpener));
      return menuOpener;
    }

    const prior = await this.historyForApi(convId, ctx);

    if (!ctx.disableDeterministicRouting) {
      // Stock gifts win over send_token / simple buy / Avantis.
      const gift = parseGiftStock(message);
      if (gift) {
        const toolbox = new Toolbox({ ...ctx, userMessage: message });
        const giftArgs = {
          to: gift.to,
          stock: gift.stock,
          amount: gift.amount,
          isUsd: gift.isUsd,
        };
        recordRoutingEvalTool(ctx, "gift_stock", giftArgs);
        const result = await toolbox.gift_stock(giftArgs);
        if (result.control) {
          this.appendHistory(convId, message, historyTextForControl(result.control));
          return result.control;
        }
        // Matched a stock gift — never fall through to send_token/USDC.
        const errText =
          typeof result.data === "object" &&
          result.data &&
          "error" in result.data &&
          typeof (result.data as { error?: unknown }).error === "string"
            ? (result.data as { error: string }).error
            : "couldn't start that stock gift — try again in a sec";
        this.appendHistory(convId, message, errText);
        return { type: "text", text: errText };
      }

      // Simple "buy $5 TOKEN" — parse deterministically so the LLM can't mis-read amounts.
      // B20 stocks go through Slipstream via uniswap_prepare_swap (not Flash / Avantis).
      const simpleBuy = parseSimpleUsdBuy(message);
      if (simpleBuy) {
        const limitErr = assertSwapUsdWithinLimit(simpleBuy.amount);
        if (limitErr) return { type: "text", text: limitErr };
        const toolbox = new Toolbox({ ...ctx, userMessage: message });
        const buyArgs = {
          fromAsset: "USDC",
          toAsset: simpleBuy.toAsset,
          amount: simpleBuy.amount,
          isUsd: true,
        };
        recordRoutingEvalTool(ctx, "uniswap_prepare_swap", buyArgs);
        const result = await toolbox.uniswap_prepare_swap(buyArgs);
        if (result.control) {
          this.appendHistory(convId, message, historyTextForControl(result.control));
          return result.control;
        }
        const errText =
          typeof result.data === "object" &&
          result.data &&
          "error" in result.data &&
          typeof (result.data as { error?: unknown }).error === "string"
            ? (result.data as { error: string }).error
            : "couldn't prepare that swap — try again in a sec";
        return { type: "text", text: errText };
      }

      const simpleUsdSend = parseSimpleUsdSend(message);
      if (simpleUsdSend && !isKnownStockPairCandidate(simpleUsdSend.asset)) {
        const limitErr = assertSwapUsdWithinLimit(simpleUsdSend.amount);
        if (limitErr) return { type: "text", text: limitErr };
        const toolbox = new Toolbox({ ...ctx, userMessage: message });
        const sendArgs = {
          to: simpleUsdSend.to,
          asset: simpleUsdSend.asset,
          amount: simpleUsdSend.amount,
          isUsd: true,
        };
        recordRoutingEvalTool(ctx, "send_token", sendArgs);
        const result = await toolbox.send_token(sendArgs);
        if (result.control) {
          this.appendHistory(convId, message, historyTextForControl(result.control));
          return result.control;
        }
      }
      // USD send of a B20 stock → gift_stock
      if (simpleUsdSend && isKnownStockPairCandidate(simpleUsdSend.asset)) {
        const toolbox = new Toolbox({ ...ctx, userMessage: message });
        const giftArgs = {
          to: simpleUsdSend.to,
          stock: simpleUsdSend.asset,
          amount: simpleUsdSend.amount,
          isUsd: true,
        };
        recordRoutingEvalTool(ctx, "gift_stock", giftArgs);
        const result = await toolbox.gift_stock(giftArgs);
        if (result.control) {
          this.appendHistory(convId, message, historyTextForControl(result.control));
          return result.control;
        }
      }

      // Token-denominated send ("send 6.7 usdc to name.base.eth" / "send all usdc to …").
      const simpleTokenSend = parseSimpleTokenSend(message);
      if (simpleTokenSend && isKnownStockPairCandidate(simpleTokenSend.asset)) {
        const toolbox = new Toolbox({ ...ctx, userMessage: message });
        const giftArgs = {
          to: simpleTokenSend.to,
          stock: simpleTokenSend.asset,
          amount: simpleTokenSend.amount,
          isUsd: false,
        };
        recordRoutingEvalTool(ctx, "gift_stock", giftArgs);
        const result = await toolbox.gift_stock(giftArgs);
        if (result.control) {
          this.appendHistory(convId, message, historyTextForControl(result.control));
          return result.control;
        }
      }
      if (simpleTokenSend && !isKnownStockPairCandidate(simpleTokenSend.asset)) {
        const toolbox = new Toolbox({ ...ctx, userMessage: message });
        const sendArgs = {
          to: simpleTokenSend.to,
          asset: simpleTokenSend.asset,
          amount: simpleTokenSend.amount,
          isUsd: false,
          ...(simpleTokenSend.all ? { all: true as const } : {}),
        };
        recordRoutingEvalTool(ctx, "send_token", sendArgs);
        const result = await toolbox.send_token(sendArgs);
        if (result.control) {
          this.appendHistory(convId, message, historyTextForControl(result.control));
          return result.control;
        }
      }

      // Bare basename / 0x reply after a pending send ask — complete the transfer.
      const bareRecipient = parseBareSendRecipient(message);
      if (bareRecipient) {
        const pending = extractPendingSendFromHistory(prior);
        if (pending) {
          // Retry/complete even when the prior turn already named this recipient
          // (e.g. LLM asked to re-confirm after failing to call send_token).
          const toolbox = new Toolbox({ ...ctx, userMessage: message });
          const sendArgs = {
            to: bareRecipient,
            asset: pending.asset,
            amount: pending.amount,
            isUsd: false,
            ...(pending.all ? { all: true as const } : {}),
          };
          recordRoutingEvalTool(ctx, "send_token", sendArgs);
          const result = await toolbox.send_token(sendArgs);
          if (result.control) {
            this.appendHistory(convId, message, historyTextForControl(result.control));
            return result.control;
          }
        } else {
          // No pending send — resolve the name so a lone basename isn't a dead end.
          const toolbox = new Toolbox({ ...ctx, userMessage: message });
          const result = await toolbox.resolve_name({ name: bareRecipient });
          if (result.control) {
            this.appendHistory(convId, message, historyTextForControl(result.control));
            return result.control;
          }
        }
      }

      // Deterministic "long eth" / "short btc $50" — route straight to the perp
      // prepare tool (no LLM round) so unambiguous trade commands are fast and
      // 100% reliable, never lost to model reasoning truncation. Gated on a live
      // backend and a LISTED market so non-trade phrases ("long story") fall
      // through to the LLM. The handler reads amount/leverage from the message.
      const simplePerp = !ctx.perpWizard ? parseSimplePerp(message) : null;
      if (simplePerp && isAvantisLive()) {
        const listed = new Set(
          (await getListedAvantisBases().catch(() => [])).map((b) => b.toUpperCase()),
        );
        if (listed.has(simplePerp.base)) {
          const toolbox = new Toolbox({ ...ctx, userMessage: message });
          const perpArgs = { pair: simplePerp.base, side: simplePerp.side };
          recordRoutingEvalTool(ctx, "avantis_prepare_trade", perpArgs);
          const result = await toolbox.avantis_prepare_trade(perpArgs);
          if (result.control) {
            this.appendHistory(convId, message, historyTextForControl(result.control));
            return result.control;
          }
        }
      }

      // Free-text PerpMate setup ("medium risk, 500 USDC margin") — persist the
      // profile and confirm, instead of looping the button-only setup card.
      const profileSetup = !ctx.perpWizard ? parsePerpProfileSetup(message) : null;
      if (profileSetup && isAvantisLive()) {
        const saved = await PerpProfileAdapter.upsertProfile(ctx.inboxId, {
          risk_tier: profileSetup.tier,
          default_collateral_usdc: profileSetup.collateral,
        });
        if (saved) {
          recordRoutingEvalTool(ctx, "avantis_update_perp_profile", profileSetup);
          const reply = `you're all set 💙 ${profileSetup.tier} tier, $${profileSetup.collateral} per trade. just tell me what to trade — like "long eth" or "short btc" — and i'll set it up.`;
          this.appendHistory(convId, message, reply);
          return { type: "text", text: reply };
        }
      }

      // Custodial wallet intents (balance / fund / cash out) — routed deterministically
      // so they fire reliably for non-iMessage server-wallet flows.
      if (ctx.custodialWallet) {
        const walletIntent = detectWalletIntent(message);
        if (walletIntent) {
          const toolbox = new Toolbox({ ...ctx, userMessage: message });
          recordRoutingEvalTool(ctx, walletIntent, {});
          const result =
            walletIntent === "get_wallet_balance"
              ? await toolbox.get_wallet_balance()
              : walletIntent === "fund_wallet"
                ? await toolbox.fund_wallet({})
                : await toolbox.offramp_to_fiat({});
          if (result.control) {
            this.appendHistory(convId, message, historyTextForControl(result.control));
            return result.control;
          }
        }
      }

      // Support / close / PnL / positions — deterministic before the LLM.
      const deterministicRoute = await routeDeterministicIntent(message, ctx);
      if (deterministicRoute?.control) {
        this.appendHistory(convId, message, historyTextForControl(deterministicRoute.control));
        return deterministicRoute.control;
      }
    }

    const toolbox = new Toolbox({ ...ctx, userMessage: message });
    const llmUserContent = ctx.perpWizard
      ? augmentMessageForPerpWizard(message, ctx.perpWizard)
      : message;
    // Frozen per-user memory snapshot, appended as a volatile tail after the
    // stable system prompt (kept out of the cacheable prefix). Best-effort.
    const userNote = ctx.inboxId
      ? await UserMemoryAdapter.buildUserMemoryNote(ctx.inboxId, message).catch(() => null)
      : null;
    const systemContent =
      getSystemPrompt(ctx.custodialWallet, ctx.copyPlatform) +
      (userNote ? `\n\nUSER CONTEXT:\n${userNote}` : "") +
      buildIntentHint(ctx);
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemContent },
      ...FEW_SHOT_EXAMPLES,
      ...prior,
      { role: "user", content: llmUserContent },
    ];

    let firstControl: AIResponse | undefined;
    // Decision-round budget. gpt-5.4-mini emits hidden reasoning tokens that
    // count against max_completion_tokens, so a tight cap (e.g. 400) can be
    // consumed entirely by reasoning BEFORE the model emits a tool call —
    // yielding empty content + finish_reason "length" (the "didn't catch that"
    // failure). Give it real headroom: ~1024 covers think + dispatch, advisory
    // prose gets more. Later rounds resize via resolveMaxTokens.
    const complexQuery = isComplexQuery(message);
    let maxTokens = complexQuery ? 2500 : 2048;
    // Once: if a round truncates with nothing usable, we retry with a big budget.
    let truncationRetried = false;
    // Route advisory/strategy queries to the stronger model when configured;
    // tool dispatch stays on the fast default model.
    const activeModel = resolveModelForMessage(this.model, message);

    try {
      // Up to 3 tool-call rounds
      for (let i = 0; i < 3; i++) {
        const llmT0 = Date.now();
        const completion = await this.openai.chat.completions.create(
          {
            ...openAiChatParams({ model: activeModel, maxCompletionTokens: maxTokens, temperature: complexQuery ? 0.3 : 0.1 }),
            messages,
            tools: getTools({ custodial: ctx.custodialWallet, channel: ctx.copyPlatform }),
            tool_choice: "auto",
          },
          { timeout: 45_000 },
        );
        const toolNames = (completion.choices[0]?.message?.tool_calls ?? [])
          .map((tc) => (tc.type === "function" ? tc.function.name : undefined))
          .filter((n): n is string => Boolean(n));
        // Size the next round's budget from the tools requested this round.
        maxTokens = resolveMaxTokens(toolNames);
        logLlmTurn({
          model: activeModel,
          provider: providerForModel(activeModel),
          latencyMs: Date.now() - llmT0,
          promptTokens: completion.usage?.prompt_tokens,
          completionTokens: completion.usage?.completion_tokens,
          cachedTokens: completion.usage?.prompt_tokens_details?.cached_tokens,
          toolCalls: toolNames.length ? toolNames : undefined,
        });
        const choice = completion.choices[0];
        const msg = choice?.message;
        if (!msg) break;

        const toolCalls = msg.tool_calls ?? [];
        // Recovery: the model burned the whole budget on reasoning and emitted
        // neither a tool call nor visible content (finish_reason "length"). This
        // is a truncation, not a real "I don't understand" — retry this round
        // once with ample room instead of returning the generic fallback.
        if (
          toolCalls.length === 0 &&
          !(msg.content ?? "").toString().trim() &&
          choice.finish_reason === "length" &&
          !truncationRetried
        ) {
          truncationRetried = true;
          maxTokens = 4000;
          i--;
          continue;
        }
        if (toolCalls.length === 0) {
          const text = (msg.content ?? "").trim() || DEFAULT_REPLY;
          const response = finalizeTextResponse(text, message);
          // Save this user→assistant exchange to history
          this.appendHistory(convId, message, historyTextForControl(response));
          if (firstControl) return firstControl;
          return response;
        }

        // Persist the assistant message that requested tool calls
        messages.push({
          role: "assistant",
          content: msg.content ?? null,
          tool_calls: toolCalls,
        });

        // Run all tool calls for this round in parallel — cuts latency when the AI
        // requests multiple tools at once (e.g. get_vaults + prepare_deposit).
        const toolResults = await Promise.all(
          toolCalls
            .filter((call): call is OpenAI.Chat.Completions.ChatCompletionMessageToolCall & {
              type: "function";
              function: { name: string; arguments: string };
            } => call.type === "function")
            .map(async (call) => {
              const name = call.function.name;
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(call.function.arguments || "{}");
              } catch {
                // fall through
              }
              const handler = (toolbox as any)[name];
              let result: ToolResult;
              if (typeof handler !== "function") {
                result = { data: { error: `Unknown tool: ${name}` } };
              } else {
                // Validate args against Zod schema for high-risk tools before dispatch.
                const validated = validateToolArgs(name, args);
                if (!validated.ok) {
                  console.warn(`⚠️ Tool ${name} arg validation failed: ${validated.issues}`);
                  result = {
                    data: { error: `Invalid tool arguments: ${validated.issues}` },
                    control: { type: "text", text: "i got confused about the details — could you rephrase that?" },
                  };
                } else {
                  try {
                    recordRoutingEvalTool(ctx, name, validated.args);
                    result = await handler.call(toolbox, validated.args);
                  } catch (err: any) {
                    console.error(`❌ Tool ${name} threw:`, err?.message || err);
                    result = { data: { error: err?.message || String(err) } };
                  }
                }
              }
              // Fire-and-forget memory write — only when the tool produced a real
              // UI action (control), which signals a genuine trade/earn success.
              if (result.control && ctx.inboxId) {
                void UserMemoryAdapter.updateUserMemory(ctx.inboxId, name, args);
                void ConversationMemoryAdapter.rememberToolOutcome({
                  inboxId: ctx.inboxId,
                  conversationId: convId,
                  toolName: name,
                  args,
                });
              }
              return { call, result };
            }),
        );

        for (const { call, result } of toolResults) {
          if (result.control && !firstControl) firstControl = result.control;
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(result.data),
          });
        }

        if (firstControl && isTerminalAiResponse(firstControl)) {
          this.appendHistory(convId, message, historyTextForControl(firstControl));
          return firstControl;
        }
      }

      // Final fallback — save history with a summary of what the agent did
      if (firstControl) {
        this.appendHistory(convId, message, historyTextForControl(firstControl));
        return firstControl;
      }
      return { type: "text", text: DEFAULT_REPLY };
    } catch (e: any) {
      console.error("❌ AI error:", e?.message || e);
      const fallback = await tryAiDownFallback(message, convId, ctx, (user, assistant) =>
        this.appendHistory(convId, user, assistant),
      );
      if (fallback) return fallback;
      if (firstControl) return firstControl;
      return { type: "text", text: DEFAULT_REPLY };
    }
  }

  private appendHistory(
    convId: string,
    userMessage: string,
    assistantReply: string,
  ): void {
    const prior = this.history.get(convId) ?? [];
    const updated: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      ...prior,
      { role: "user", content: userMessage },
      { role: "assistant", content: assistantReply },
    ];
    // Keep only the last MAX_HISTORY_TURNS messages
    const trimmed = updated.slice(-MAX_HISTORY_TURNS);
    this.history.set(convId, trimmed);
    // Fire-and-forget Redis persistence — context survives process restarts.
    void stateSet(`ai:history:${convId}`, trimmed, DiscoveryAI.HISTORY_TTL_SECONDS);
    // Fire-and-forget Postgres write-through — durable across Redis expiry / restarts.
    const meta = this.convMeta.get(convId);
    if (meta) {
      void ConversationMessageAdapter.insert({
        inboxId: meta.inboxId,
        conversationId: convId,
        platform: meta.platform,
        role: "user",
        content: userMessage,
      });
      void ConversationMessageAdapter.insert({
        inboxId: meta.inboxId,
        conversationId: convId,
        platform: meta.platform,
        role: "assistant",
        content: assistantReply,
      });
    }
  }
}
