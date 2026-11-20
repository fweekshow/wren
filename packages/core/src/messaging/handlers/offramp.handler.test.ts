import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateOfframpDraft = vi.hoisted(() => vi.fn());

vi.mock("@/wallet/offramp.js", () => ({
  createOfframpDraft: mockCreateOfframpDraft,
  OfframpValidationError: class OfframpValidationError extends Error {},
}));
vi.mock("@/wallet/cdp.js", () => ({
  GasEstimationError: class GasEstimationError extends Error {},
  InsufficientGasError: class InsufficientGasError extends Error {},
  withdraw: vi.fn(),
}));
vi.mock("@/config/config.js", () => ({
  config: {
    cdp: {
      enabled: true,
      paymentsEnabled: true,
      onrampSandbox: false,
      fundPageUrl: "https://basemate.app/pay",
      onrampClientIpFallback: "",
    },
  },
}));
vi.mock("@/discovery/ai.js", () => ({
  prepareAvantisOpen: vi.fn(),
  normalizeAvantisPair: vi.fn((value: string) => value),
}));
vi.mock("@/discovery/strategy/liveTrading.js", () => ({
  isStrategyLiveTradingPaused: vi.fn().mockReturnValue(false),
  LIVE_TRADING_PAUSED_MESSAGE: "trading paused",
}));
vi.mock("@/account-linking/adapter.js", () => ({
  AccountLinkingAdapter: { getLinkedBaseAppAddress: vi.fn().mockResolvedValue(null) },
}));
vi.mock("@/wallet/sweep.js", () => ({
  sweepCustodialWallets: vi.fn(),
  resolveCustodialSweepWallets: vi.fn(),
  formatSweepPreview: vi.fn(),
  formatSweepResult: vi.fn(),
}));
vi.mock("@/wallet/phoneEscrow.js", () => ({
  PhoneEscrowAdapter: { releaseUsdcToBaseAccount: vi.fn(), hasPending: vi.fn() },
}));
vi.mock("@/wallet/onrampUserData.js", () => ({
  OnrampUserDataAdapter: { get: vi.fn(), upsert: vi.fn(), needsPhoneReverification: vi.fn() },
}));
vi.mock("@/messaging/handlers/account.handler.js", () => ({
  connectBasemateAccountMessages: vi.fn(),
  getConnectedWalletAddress: vi.fn(),
  transactionApprovalOutbound: vi.fn(),
}));
vi.mock("@/state/conversationState.store.js", () => ({
  stateSet: vi.fn(),
  stateGet: vi.fn(),
  stateDelete: vi.fn(),
  stateHas: vi.fn(),
}));
vi.mock("@/discovery/db.js", () => ({ db: { query: vi.fn() } }));
vi.mock("@/db/client.js", () => ({ db: { query: vi.fn() }, getDb: vi.fn() }));

const SENDER = "+15550001111";
const WALLET = "0xabc1234567890123456789012345678901234567";

async function subject() {
  return (await import("./wallet.handler.js")).handleOfframpIntent;
}

describe("handleOfframpIntent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateOfframpDraft.mockResolvedValue({
      url: "https://basemate.app/pay?o=opaque-token",
    });
  });

  it("asks for an amount when the amount is invalid", async () => {
    const handle = await subject();
    const result = await handle({
      platform: "imessage",
      senderId: SENDER,
      walletAddress: WALLET,
      amount: "0",
    });
    expect(result[0]).toMatch(/how much/i);
    expect(mockCreateOfframpDraft).not.toHaveBeenCalled();
  });

  it("creates a Basemate wallet offramp draft with the explicit amount", async () => {
    const handle = await subject();
    const result = await handle({
      platform: "whatsapp",
      senderId: SENDER,
      walletAddress: WALLET,
      amount: "50",
    });
    expect(mockCreateOfframpDraft).toHaveBeenCalledWith({
      platform: "whatsapp",
      userKey: SENDER,
      sourceAddress: WALLET,
      amount: "50",
    });
    expect(result[0]).toContain("50");
    expect(result[0]).toContain("https://basemate.app/pay?o=opaque-token");
    expect(result[0]).toMatch(/Basemate wallet/);
  });

  it("surfaces safe validation failures", async () => {
    const { OfframpValidationError } = await import("@/wallet/offramp.js");
    mockCreateOfframpDraft.mockRejectedValue(new OfframpValidationError("You only have 25 USDC available."));
    const handle = await subject();
    const result = await handle({
      platform: "imessage",
      senderId: SENDER,
      walletAddress: WALLET,
      amount: "50",
    });
    expect(result).toEqual(["You only have 25 USDC available."]);
  });

  it("hides unexpected failures", async () => {
    mockCreateOfframpDraft.mockRejectedValue(new Error("database details"));
    const handle = await subject();
    const result = await handle({
      platform: "imessage",
      senderId: SENDER,
      walletAddress: WALLET,
      amount: "10",
    });
    expect(result[0]).toMatch(/couldn't create/i);
    expect(result[0]).not.toContain("database");
  });
});
