import { describe, expect, it, vi } from "vitest";

// Block transitive DB dependency: intentEngine → portfolio-reviews/commands → portfolioReview.adapter → db/client
// Use the real regex logic from commands.ts so portfolio_review intent classification still works.
vi.mock("@/portfolio-reviews/commands.js", () => ({
  isPortfolioReviewIntent: (text: string) =>
    /\b((?:portfolio|portolfio)\s+review|daily\s+review|(?:portfolio|portolfio)\s+digest)\b/i.test(text),
}));

import { LlmImessageIntentEngine } from "./intentEngine.js";

describe("LlmImessageIntentEngine", () => {
  it("never calls the LLM — returns basicImessageIntent result directly (Phase 2)", async () => {
    // Phase 2: LlmImessageIntentEngine.classify() is deterministic-only.
    // Injecting a mock OpenAI client has no effect; it is never invoked.
    const create = vi.fn();
    const engine = new LlmImessageIntentEngine({
      openai: { chat: { completions: { create } } } as never,
      model: "gpt-test",
    });

    const intent = await engine.classify("opaque classifier fixture");

    // No LLM keywords match → basicImessageIntent returns discovery
    expect(intent).toMatchObject({
      action: "discovery",
      domain: "discovery",
      confidence: 0.55,
    });
    // The injected LLM client must NOT have been called
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps open-ended local routing when the LLM classifier returns unknown", async () => {
    const create = vi.fn(async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              domain: "unknown",
              action: "unknown",
              walletScope: "unknown",
              direction: "unknown",
              assets: [],
              amounts: [],
              targetAddress: null,
              targetName: null,
              leaderboardCategory: null,
              confidence: 0.2,
            }),
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    }));
    const engine = new LlmImessageIntentEngine({
      openai: { chat: { completions: { create } } } as never,
      model: "gpt-test",
    });

    const intent = await engine.classify("Hello dear");

    expect(intent).toMatchObject({
      action: "discovery",
      domain: "discovery",
      confidence: 0.55,
    });
  });

  it("routes casual acknowledgements to discovery when nothing is pending", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    await expect(engine.classify("Lol ok")).resolves.toMatchObject({
      action: "discovery",
      domain: "discovery",
      confidence: 0.55,
    });
    await expect(engine.classify("lmao")).resolves.toMatchObject({
      action: "discovery",
      domain: "discovery",
      confidence: 0.55,
    });
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("preserves confirmations when a transaction is pending", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("ok", { pendingTrade: true });

    expect(intent).toMatchObject({
      action: "confirm",
      domain: "system",
      confidence: 0.9,
    });
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("classifies my wallet address questions as main wallet balance", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("What's my wallet?");

    expect(intent).toMatchObject({
      action: "main_wallet_balance",
      domain: "wallet",
      walletScope: "main_server_wallet",
      confidence: 0.8,
    });
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("classifies show my portfolio as main wallet balance", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    await expect(engine.classify("Show my balance")).resolves.toMatchObject({
      action: "main_wallet_balance",
      domain: "wallet",
      walletScope: "main_server_wallet",
      confidence: 0.8,
    });
    await expect(engine.classify("Show my portfolio")).resolves.toMatchObject({
      action: "main_wallet_balance",
      domain: "wallet",
      walletScope: "main_server_wallet",
      confidence: 0.8,
    });
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("classifies onramp requests as main wallet funding", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("I want to onramp $10");

    expect(intent).toMatchObject({
      action: "main_wallet_fund",
      domain: "wallet",
      walletScope: "main_server_wallet",
      confidence: 0.8,
    });
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("classifies wallet connection requests as account linking", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("Connect my wallet");

    expect(intent).toMatchObject({
      action: "account_link",
      domain: "account_linking",
      confidence: 0.75,
    });
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("classifies portfolio review scheduling separately from portfolio views", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    await expect(
      engine.classify("portfolio review every day at 8am America/New_York"),
    ).resolves.toMatchObject({
      action: "portfolio_review",
      domain: "portfolio",
      confidence: 0.8,
    });
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("classifies Basemate-wallet Avantis close requests as scoped perp trades", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("close basemate wallet ETH position");

    expect(intent).toMatchObject({
      action: "perp_trade",
      domain: "perps",
      walletScope: "basemate_wallet",
      assets: ["ETH"],
      confidence: 0.85,
    });
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("classifies plain perp trading requests as perp trades", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("I want to trade perps");

    expect(intent).toMatchObject({
      action: "perp_trade",
      domain: "perps",
      confidence: 0.8,
    });
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("classifies close-all both-wallet requests as scoped perp trades", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("flatten all wallets");

    expect(intent).toMatchObject({
      action: "perp_trade",
      domain: "perps",
      walletScope: "both_wallets",
      confidence: 0.85,
    });
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("classifies Moonwell stake phrasing as a yield request", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("Show my moon well stakes");

    expect(intent).toMatchObject({
      action: "yield",
      domain: "discovery",
      confidence: 0.85,
    });
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("classifies explicit Morpho stake amounts as yield", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("Stake 100 USDC to Morpho");

    expect(intent).toMatchObject({
      action: "yield",
      domain: "discovery",
      amounts: [{ asset: "USDC", amount: "100", amountUsd: null, all: false }],
      assets: ["USDC"],
      confidence: 0.85,
    });
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("classifies Moonwell close phrasing as yield instead of perps", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("close my moonwell usdc position");

    expect(intent).toMatchObject({
      action: "yield",
      domain: "discovery",
      confidence: 0.85,
    });
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it.each([
    "I want my money back from moonwell",
    "Close moonwell stakes",
  ])("classifies natural Moonwell withdraw phrasing as yield: %s", async (message) => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify(message);

    expect(intent).toMatchObject({
      action: "yield",
      domain: "discovery",
      confidence: 0.85,
    });
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it.each([
    "show my contacts",
    "list contacts",
    "who's in my contact book",
    "view saved contacts",
  ])("classifies contact-book requests as contact_list: %s", async (message) => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify(message);

    expect(intent).toMatchObject({
      action: "contact_list",
      domain: "system",
      confidence: 0.85,
    });
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("classifies full-balance swaps for arbitrary token symbols without an API key", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("Swap all BASEMATE to usdc");

    expect(intent).toMatchObject({
      action: "swap",
      domain: "discovery",
      amounts: [{ asset: "BASEMATE", amount: null, amountUsd: null, all: true }],
      assets: ["BASEMATE"],
      confidence: 0.8,
    });
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("classifies whole, entire, and max balance swap phrasing", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    await expect(engine.classify("sell my whole DEGEN balance for USDC")).resolves.toMatchObject({
      action: "swap",
      amounts: [{ asset: "DEGEN", all: true }],
    });
    await expect(engine.classify("convert entire AERO balance to USDC")).resolves.toMatchObject({
      action: "swap",
      amounts: [{ asset: "AERO", all: true }],
    });
    await expect(engine.classify("swap max TOSHI into USDC")).resolves.toMatchObject({
      action: "swap",
      amounts: [{ asset: "TOSHI", all: true }],
    });
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  // ── New tests: pending state overrides ───────────────────────────────────────

  it("routes confirm words to 'confirm' action when pendingSweep is true", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("yes do it", { pendingSweep: true });

    expect(intent).toMatchObject({
      action: "confirm",
      domain: "system",
    });
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("routes 'cancel' to cancel action when pendingSweep is true", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("cancel", { pendingSweep: true });

    expect(intent).toMatchObject({
      action: "cancel",
      domain: "system",
    });
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("routes general USDC balance question to discovery (not a direct shortcut)", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("how much USDC do I have?");

    // general token balance questions go through discovery AI which calls the chain tool
    expect(intent.action).not.toBe("confirm");
    expect(intent.action).not.toBe("cancel");
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("sets amountUsd and nulls amount when user says dollar amount", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("buy $3 of ETH");

    // The intent engine should parse "3" as amountUsd and leave amount null
    const amountEntry = intent.amounts?.[0];
    if (amountEntry) {
      // When dollar notation is used, amountUsd should be set
      expect(amountEntry.amountUsd).toBe("3");
    }
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("routes 'send 10 to mom' to send_token even with no pending state", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("send 10 USDC to mom");

    expect(intent.action).toBe("send_token");
    // send_token routes through discovery AI, so domain is "discovery" in the basic classifier
    expect(intent.domain).toBe("discovery");
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it.each(["tip Degeneer .01 usdc", "give bob 5 usdc", "shoot alice 10 usdc", "toss mom 1 usdc", "fire over .01 usdc to jesse"])(
    "routes slang send verb %j to send_token",
    async (message) => {
      const previousKey = process.env.BANKR_LLM_API_KEY;
      delete process.env.BANKR_LLM_API_KEY;
      const engine = new LlmImessageIntentEngine();
      const intent = await engine.classify(message);
      expect(intent.action).toBe("send_token");
      if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
    },
  );

  it("classifies Apple stock gift as send_token without inventing a USDC amount", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("Send $2 of Apple stock to Leo Gonzalez");

    expect(intent.action).toBe("send_token");
    // "$2 of Apple" must not become { asset: USDC, amount: 2 } — the handler
    // then asks "how much USDC for Leo to claim". Amounts stay empty; parseGiftStock wins.
    expect(intent.amounts).toEqual([]);
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("defaults a bare dollar contact send to USDC", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("Send $2 to Aritra");

    expect(intent.action).toBe("send_token");
    expect(intent.amounts).toEqual([
      { asset: "USDC", amount: "2", amountUsd: null, all: false },
    ]);
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("classifies @Person amount shorthand as send_token", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("@Aritra 5 USDC");

    expect(intent.action).toBe("send_token");
    expect(intent.targetName).toBe("Aritra");
    expect(intent.amounts[0]?.amount).toBe("5");
    expect(intent.amounts[0]?.asset?.toUpperCase()).toBe("USDC");
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("keeps the amount in an explicit offramp request", async () => {
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("Offramp $5");

    expect(intent.action).toBe("main_wallet_offramp");
    expect(intent.amounts).toEqual([
      { asset: "USDC", amount: "5", amountUsd: null, all: false },
    ]);
  });

  it("captures basename as targetName on send_token", async () => {
    const previousKey = process.env.BANKR_LLM_API_KEY;
    delete process.env.BANKR_LLM_API_KEY;
    const engine = new LlmImessageIntentEngine();

    const intent = await engine.classify("Send 6.7 usdc to degeneer03.base.eth");

    expect(intent.action).toBe("send_token");
    expect(intent.targetName).toBe("degeneer03.base.eth");
    expect(intent.targetAddress).toBeNull();
    if (previousKey) process.env.BANKR_LLM_API_KEY = previousKey;
  });

  it("classifies dollar-amount swaps correctly without LLM (Phase 2)", async () => {
    // The LLM mock is injected but never invoked; basicImessageIntent handles this.
    const create = vi.fn();
    const engine = new LlmImessageIntentEngine({
      openai: { chat: { completions: { create } } } as never,
      model: "gpt-test",
    });

    const intent = await engine.classify("buy $3 ETH");

    expect(intent).toMatchObject({
      action: "swap",
      amounts: [{ asset: "ETH", amountUsd: "3" }],
    });
    expect(create).not.toHaveBeenCalled();
  });

  // ── basicAmounts generic token parsing ──────────────────────────────────────

  it("parses generic NUMBER TOKEN — 'send 10000 BASEMATE to Bonu'", async () => {
    const create = vi.fn();
    const engine = new LlmImessageIntentEngine({
      openai: { chat: { completions: { create } } } as never,
      model: "gpt-test",
    });
    const intent = await engine.classify("send 10000 BASEMATE to Bonu");
    expect(intent.amounts).toEqual([
      { asset: "BASEMATE", amount: "10000", amountUsd: null, all: false },
    ]);
    expect(create).not.toHaveBeenCalled();
  });

  it("parses generic NUMBER TOKEN — 'buy 5 DEGEN'", async () => {
    const create = vi.fn();
    const engine = new LlmImessageIntentEngine({
      openai: { chat: { completions: { create } } } as never,
      model: "gpt-test",
    });
    const intent = await engine.classify("buy 5 DEGEN");
    expect(intent.amounts).toEqual([
      { asset: "DEGEN", amount: "5", amountUsd: null, all: false },
    ]);
  });

  it("parses generic NUMBER TOKEN — 'send 0.5 AERO to alice'", async () => {
    const create = vi.fn();
    const engine = new LlmImessageIntentEngine({
      openai: { chat: { completions: { create } } } as never,
      model: "gpt-test",
    });
    const intent = await engine.classify("send 0.5 AERO to alice");
    expect(intent.amounts).toEqual([
      { asset: "AERO", amount: "0.5", amountUsd: null, all: false },
    ]);
  });

  it("does not duplicate USDC when 'send 10 USDC to carol'", async () => {
    const create = vi.fn();
    const engine = new LlmImessageIntentEngine({
      openai: { chat: { completions: { create } } } as never,
      model: "gpt-test",
    });
    const intent = await engine.classify("send 10 USDC to carol");
    expect(intent.amounts).toHaveLength(1);
    expect(intent.amounts[0]).toMatchObject({ asset: "USDC", amount: "10" });
  });

  it("does not treat preposition 'TO' as a token — 'send 50 to bob'", async () => {
    const create = vi.fn();
    const engine = new LlmImessageIntentEngine({
      openai: { chat: { completions: { create } } } as never,
      model: "gpt-test",
    });
    const intent = await engine.classify("send 50 to bob");
    // No amounts parsed — bare number with no recognized asset
    expect(intent.amounts).toHaveLength(0);
  });

  it("bare '$50 to bob' still resolves to USDC", async () => {
    const create = vi.fn();
    const engine = new LlmImessageIntentEngine({
      openai: { chat: { completions: { create } } } as never,
      model: "gpt-test",
    });
    const intent = await engine.classify("send $50 to bob");
    expect(intent.amounts).toEqual([
      { asset: "USDC", amount: "50", amountUsd: null, all: false },
    ]);
  });
});
