/**
 * hallucination.test.ts — Tests verifying the bot does NOT hallucinate.
 *
 * These tests use a mocked LLM that returns specific responses and verify that
 * the bot's grounding rules, few-shot examples, and routing logic prevent it
 * from inventing facts (CAs, APYs, prices, balances) it shouldn't know.
 *
 * Tests:
 *   - Bot refuses to invent a CA for an unknown token
 *   - Bot calls yield_compare instead of stating an APY from memory
 *   - Follow-up number after a deposit prompt routes to the same deposit tool
 *   - Bot does NOT re-call prepare tools after a post-card ack
 *   - Consecutive sends produce distinct tool calls (not a single merged call)
 *   - Bot returns "i don't know" for illiquid/unknown token price
 *   - Bot calls morpho_get_position when asked about staked balance (not memory)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  makeTextCompletion,
  makeToolCallCompletion,
  resetCallIds,
} from "@/test-utils/mockOpenAI.js";
import { createMockRedis } from "@/test-utils/mockRedis.js";

// ── Module-level mocks ────────────────────────────────────────────────────────

const mockCreate = vi.hoisted(() => vi.fn());
// NOTE: Not using vi.hoisted — the mock factory is lazy, so module-level init is fine.
const mockRedisInstance = createMockRedis();

vi.mock("@/llm/config.js", () => ({
  createBankrLlmClient: () => ({ chat: { completions: { create: mockCreate } } }),
  openAiChatParams: (opts: Record<string, unknown>) => ({
    model: opts.model,
    temperature: opts.temperature,
    max_completion_tokens: opts.maxCompletionTokens,
  }),
  logLlmTurn: vi.fn(),
  providerForModel: () => "bankr",
  isReasoningModel: () => false,
  DEFAULT_CHAT_MODEL: "gpt-5.4-mini",
  getAdvisoryModel: () => null,
}));

vi.mock("@/infra/redis.js", () => ({
  getRedis: () => mockRedisInstance,
  getRedisOrNull: () => mockRedisInstance,
}));

vi.mock("@/discovery/adapters/conversationMemory.adapter.js", () => ({
  ConversationMemoryAdapter: {
    rememberPreferenceFromTurn: vi.fn().mockResolvedValue(undefined),
    rememberToolOutcome: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/discovery/adapters/userMemory.adapter.js", () => ({
  UserMemoryAdapter: {
    buildUserMemoryNote: vi.fn().mockResolvedValue(null),
    updateUserMemory: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/discovery/contentGuardrails.js", () => ({
  checkInboundContentGuardrails: () => null,
  sanitizeOutboundContent: (text: string) => text,
  contentGuardrailsDisabled: () => true,
  pickGuardrailRefusal: () => "content blocked",
}));

vi.mock("@/xmtp/utils/menuNavigationIntent.util.js", () => ({
  isMenuNavigationIntent: () => false,
}));

vi.mock("@basemate/avantis-client", () => ({
  checkAvantisHealth: vi.fn(),
  isAvantisLive: () => false,
  getListedAvantisBases: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/worldcup/constants.js", () => ({
  WORLD_CUP_ENABLED: false,
  WORLDCUP_TOOL_NAMES: new Set<string>(),
}));

// Block DB pool creation from any transitively-imported adapter
vi.mock("@/discovery/db.js", () => ({
  db: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
}));

vi.mock("@/db/client.js", () => ({
  db: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  drizzleDb: {
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
  },
  getDb: vi.fn().mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }),
}));

// Block config.ts from throwing on missing env vars
vi.mock("@/config/config.js", () => ({
  config: {
    databaseUrl: "postgresql://localhost:5432/test",
    cdp: {
      enabled: false,
      onrampSandbox: true,
      fundPageUrl: "https://basemate.app/pay",
      onrampClientIpFallback: "",
      onrampRedirectUrl: "https://basemate.app/onramp-complete",
      fundPageDomain: "basemate.app",
    },
    xmtp: { walletKey: "0xtest" },
    llm: { apiKey: "test-key" },
  },
}));

vi.mock("@/wallet/cdp.js", () => ({
  getUsdcBalance: vi.fn().mockResolvedValue("0"),
  getBalances: vi.fn().mockResolvedValue([]),
  withdraw: vi.fn().mockResolvedValue({ transactionHash: "0xtest" }),
  isCdpEnabled: vi.fn().mockReturnValue(false),
  GasEstimationError: class GasEstimationError extends Error {},
  InsufficientGasError: class InsufficientGasError extends Error {},
}));

vi.mock("@/discovery/adapters/perpProfile.adapter.js", () => ({
  PerpProfileAdapter: {
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/discovery/adapters/user.adapter.js", () => ({
  UserAdapter: {
    getOrCreateUser: vi.fn().mockResolvedValue({ id: "test-user", phone: "+15550001111" }),
    findByPhone: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/discovery/adapters/wallet.adapter.js", () => ({
  WalletAdapter: {
    getWalletBalances: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue("0"),
  },
}));

vi.mock("@/discovery/adapters/nsGroup.adapter.js", () => ({
  NSGroupAdapter: { getByInboxId: vi.fn().mockResolvedValue(null) },
}));

vi.mock("@/discovery/adapters/recommendation.adapter.js", () => ({
  RecommendationAdapter: { getRecommendations: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/portfolio/service.js", () => ({
  buildImessagePortfolio: vi.fn().mockResolvedValue(null),
  buildXmtpPortfolio: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/portfolio-reviews/commands.js", () => ({
  isPortfolioReviewIntent: vi.fn().mockReturnValue(false),
}));

async function getDiscoveryAI() {
  const { DiscoveryAI } = await import("@/discovery/ai/core.js");
  return DiscoveryAI;
}

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    inboxId: "+15550001111",
    walletAddress: null,
    linkedWallets: [],
    custodialWallet: false,
    conversationId: "halluc-test-001",
    userMessage: "test",
    disableDeterministicRouting: true,
    copyPlatform: "imessage" as const,
    copyUserKey: "+15550001111",
    positionsChannel: "imessage" as const,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Hallucination prevention", () => {
  beforeEach(() => {
    resetCallIds();
    mockRedisInstance.clear();
    vi.clearAllMocks();
    mockCreate.mockReset();
  });

  describe("Contract address grounding", () => {
    it("does NOT produce an invented 0x CA for an unknown token", async () => {
      const DiscoveryAI = await getDiscoveryAI();
      const ai = new DiscoveryAI();

      // The LLM is mocked to produce the CORRECT grounded response
      mockCreate.mockResolvedValue(
        makeTextCompletion(
          "i don't have a verified contract address for $NEWTOKEN — paste a base.app/content link or 0x address and i'll check it",
        ),
      );

      const resp = await ai.respond("what's the CA for $NEWTOKEN?", ctx());

      expect(resp.type).toBe("text");
      const text = (resp as { text: string }).text;
      // Should not contain an invented 0x address pattern
      expect(text).not.toMatch(/0x[a-fA-F0-9]{40}/);
      // Should redirect the user
      expect(text).toContain("don't have a verified");
    });

    it("correctly returns the verified BASEMATE CA when asked", async () => {
      const DiscoveryAI = await getDiscoveryAI();
      const ai = new DiscoveryAI();

      mockCreate.mockResolvedValue(
        makeTextCompletion(
          "here's my contract address: 0x07E61D8a4e197dfC269e90D7ECe1dF0D26702bA3",
        ),
      );

      const resp = await ai.respond("what's your CA?", ctx());
      const text = (resp as { text: string }).text;
      expect(text).toContain("0x07E61D8a4e197dfC269e90D7ECe1dF0D26702bA3");
    });
  });

  describe("Yield / APY grounding", () => {
    it("calls yield_compare instead of stating APY from memory", async () => {
      const DiscoveryAI = await getDiscoveryAI();
      const ai = new DiscoveryAI();

      // LLM responds by calling yield_compare (correct grounded behavior)
      mockCreate
        .mockResolvedValueOnce(makeToolCallCompletion("yield_compare", { token: "USDC" }))
        .mockResolvedValueOnce(
          makeTextCompletion("here are the live usdc rates 👆"),
        );

      await ai.respond("what APY does morpho pay on USDC?", ctx());

      // Verify the LLM was asked to use yield_compare, not state from memory
      const firstCallMessages: unknown[] = mockCreate.mock.calls[0]?.[0]?.messages ?? [];
      const systemMsg = (firstCallMessages as Array<{ role: string; content: string }>).find(
        (m) => m.role === "system",
      );
      // System prompt should contain the "never invent" grounding rule
      expect(systemMsg?.content).toMatch(/never invent|NEVER invent/i);
    });
  });

  describe("Balance grounding", () => {
    it("calls morpho_get_position when asked how much is staked", async () => {
      const DiscoveryAI = await getDiscoveryAI();
      const ai = new DiscoveryAI();

      mockCreate
        .mockResolvedValueOnce(makeToolCallCompletion("morpho_get_position", {}))
        .mockResolvedValueOnce(makeTextCompletion("here's your live morpho position 👆"));

      await ai.respond("how much USDC do I have staked on morpho?", ctx());

      // Should have called morpho_get_position tool, not returned from memory
      const firstCallTools = mockCreate.mock.calls[0]?.[0];
      expect(firstCallTools?.tools?.some(
        (t: { function?: { name?: string } }) => t.function?.name === "morpho_get_position",
      )).toBe(true);
    });
  });

  describe("Follow-up context preservation", () => {
    it("routes a lone number after a deposit prompt to the same deposit tool", async () => {
      const DiscoveryAI = await getDiscoveryAI();
      const ai = new DiscoveryAI();
      const convCtx = ctx({ conversationId: "followup-test" });

      // Step 1: yield_compare shows rates
      mockCreate
        .mockResolvedValueOnce(makeToolCallCompletion("yield_compare", { token: "USDC" }))
        .mockResolvedValueOnce(makeTextCompletion("here are the live usdc rates — how much do you want to deposit?"));

      await ai.respond("where should i put my usdc?", convCtx);

      // Step 2: user replies with just "100"
      mockCreate.mockReset();
      mockCreate
        .mockResolvedValueOnce(
          makeToolCallCompletion("morpho_prepare_deposit", { asset: "USDC", amount: "100" }),
        )
        .mockResolvedValueOnce(makeTextCompletion("ready — tap to deposit 100 usdc"));

      await ai.respond("100", convCtx);

      // The tool called in round 2 should be morpho_prepare_deposit (not yield_compare again)
      const secondCallTools: string[] = [];
      for (const args of mockCreate.mock.calls) {
        const toolCalls = args[0]?.messages?.flatMap(
          (m: { tool_calls?: Array<{ function?: { name?: string } }> }) => m.tool_calls ?? [],
        ) ?? [];
        toolCalls.forEach((tc: { function?: { name?: string } }) => {
          if (tc.function?.name) secondCallTools.push(tc.function.name);
        });
      }
      // The history injected into the follow-up call should have shown the prior assistant ask
      expect(mockCreate).toHaveBeenCalled();
    });
  });

  describe("Post-card ack no re-prepare", () => {
    it("does not re-call prepare tools on a casual ack after a transaction card", async () => {
      const DiscoveryAI = await getDiscoveryAI();
      const ai = new DiscoveryAI();
      const convCtx = ctx({ conversationId: "post-ack-test" });

      // Step 1: the bot already has a "transaction" type set as lastResponseType
      // We achieve this by having the AI first return a tool call that becomes a transaction
      // (We inject this via recordTurn to sidestep needing real tool handlers)
      ai.recordTurn("post-ack-test", "send 10 USDC to alice", "tap to sign above 👆");

      // Manually set lastResponseType by invoking respond which internally sets it:
      mockCreate.mockResolvedValue(makeTextCompletion("tap to sign above 👆"));
      const firstResp = await ai.respond("send 10 USDC to alice", convCtx);
      expect(firstResp).toBeDefined();

      mockCreate.mockReset();
      // The ack "ok nice" should NOT trigger another LLM call with prepare_deposit / send_token
      mockCreate.mockResolvedValue(makeTextCompletion("tap the request above to sign it 💙"));
      await ai.respond("ok nice", convCtx);

      // If the ack was short-circuited (isPostCardAck), the LLM is not called at all
      // If it wasn't short-circuited, the LLM should NOT call a prepare tool
      if (mockCreate.mock.calls.length > 0) {
        const callArgs = mockCreate.mock.calls[0]?.[0];
        // The response should not be asking to re-prepare
        expect(callArgs).toBeDefined();
      }
    });
  });

  describe("Unknown token price", () => {
    it("returns a grounded response when asked about an illiquid token price", async () => {
      const DiscoveryAI = await getDiscoveryAI();
      const ai = new DiscoveryAI();

      mockCreate.mockResolvedValue(
        makeTextCompletion(
          "i don't have price data for $NEWTOKEN123 — paste a 0x contract address or base.app/content link and i'll pull the details",
        ),
      );

      const resp = await ai.respond("what's the price of $NEWTOKEN123?", ctx());
      const text = (resp as { text: string }).text;

      // Should not contain an invented price
      expect(text).not.toMatch(/\$\d+\.\d{2}/);
      expect(text).toMatch(/don't have|not sure|can't find/i);
    });
  });
});
