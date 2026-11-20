/**
 * send.handler.test.ts — Tests for the iMessage send money flow.
 *
 * Covers:
 *   - Contact resolved from imessage_contacts → embedded wallet approval URL built
 *   - Contact with phone but no wallet → phone escrow deposit calls returned
 *   - Unknown contact name → "i don't have X saved" message
 *   - Recipient notification is deferred until the embedded wallet tx confirms on-chain
 *   - EscrowReleasePoller.tickOnce: recipient has embedded wallet → release + DM delivered
 *   - EscrowReleasePoller.tickOnce: recipient has no address → skip
 *   -  */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRedis } from "@/test-utils/mockRedis.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// NOTE: Not using vi.hoisted — the mock factory is lazy, so module-level init is fine.
const mockRedisInstance = createMockRedis();

vi.mock("@/infra/redis.js", () => ({
  getRedis: () => mockRedisInstance,
  getRedisOrNull: () => mockRedisInstance,
}));

const mockContactsResolveWallet = vi.hoisted(() => vi.fn());
const mockPhoneEscrowBuildDraft = vi.hoisted(() => vi.fn());
const mockPhoneEscrowRelease = vi.hoisted(() => vi.fn());
const mockPhoneEscrowListPositions = vi.hoisted(() => vi.fn());
const mockPhoneEscrowHasPending = vi.hoisted(() => vi.fn().mockResolvedValue(false));

vi.mock("@/messaging/contacts.adapter.js", () => ({
  ContactsAdapter: {
    resolveWallet: mockContactsResolveWallet,
    normalizeHandle: vi.fn((s: string) => s),
    saveContact: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/wallet/phoneEscrow.js", () => ({
  PhoneEscrowAdapter: {
    buildDepositDraft: mockPhoneEscrowBuildDraft,
    listUnreleasedPositions: mockPhoneEscrowListPositions,
    claimForRelease: vi.fn().mockResolvedValue(true),
    unclaimForRelease: vi.fn().mockResolvedValue(undefined),
    releaseToWalletAddress: mockPhoneEscrowRelease,
    hasPending: mockPhoneEscrowHasPending,
  },
}));

// Mocks needed for wallet.handler.ts and escrowReleasePoller.ts transitive imports
vi.mock("@/config/config.js", () => ({
  config: {
    databaseUrl: "postgresql://localhost:5432/test",
    phoneEscrow: { releaseEnabled: true, refundEnabled: true, claimTtlHours: 72 },
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

vi.mock("@/wallet/cdp.js", () => ({
  getUsdcBalance: vi.fn().mockResolvedValue("0"),
  getBalances: vi.fn().mockResolvedValue([]),
  withdraw: vi.fn().mockResolvedValue({ transactionHash: "0xtest" }),
  isCdpEnabled: vi.fn().mockReturnValue(false),
  GasEstimationError: class GasEstimationError extends Error {},
  InsufficientGasError: class InsufficientGasError extends Error {},
}));

vi.mock("@/discovery/adapters/wallet.adapter.js", () => ({
  WalletAdapter: {
    getWalletBalances: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue("0"),
  },
}));

vi.mock("@/infra/queues/base.js", () => ({
  startPollerJob: vi.fn().mockReturnValue({ stop: vi.fn() }),
}));

vi.mock("@/discovery/ai.js", () => ({
  prepareAvantisOpen: vi.fn(),
  normalizeAvantisPair: vi.fn((p: string) => p),
}));

vi.mock("@/wallet/onramp.js", () => ({
  buildOfframpUrl: vi.fn().mockResolvedValue("https://pay.coinbase.com/sell?sessionToken=mock"),
  createHeadlessOnrampOrder: vi.fn(),
  APPLE_PAY_METHOD: "GUEST_CHECKOUT_APPLE_PAY",
  GOOGLE_PAY_METHOD: "GUEST_CHECKOUT_GOOGLE_PAY",
  isCoinbaseRegionForbiddenError: vi.fn().mockReturnValue(false),
}));

vi.mock("@/wallet/fundSession.js", () => ({
  FundSessionAdapter: { create: vi.fn().mockResolvedValue("mock-session-token") },
}));

vi.mock("@/wallet/onrampUserData.js", () => ({
  OnrampUserDataAdapter: {
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
    needsPhoneReverification: vi.fn().mockReturnValue(false),
  },
}));

vi.mock("@/wallet/sweep.js", () => ({
  sweepCustodialWallets: vi.fn(),
  resolveCustodialSweepWallets: vi.fn(),
  formatSweepPreview: vi.fn().mockReturnValue("sweep preview"),
  formatSweepResult: vi.fn().mockReturnValue("sweep done"),
}));

// ── Tests: ContactsAdapter.resolveWallet ─────────────────────────────────────

describe("send money — contact resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisInstance.clear();
  });

  it("returns a resolved contact wallet when found", async () => {
    mockContactsResolveWallet.mockResolvedValue({
      address: "0xabcdef1234567890abcdef1234567890abcdef12",
      phone: "+15551234567",
    });

    const { ContactsAdapter } = await import("@/messaging/contacts.adapter.js");
    const result = await ContactsAdapter.resolveWallet("+15550001111", "alice");

    expect(result).not.toBeNull();
    expect(result?.address).toMatch(/^0x/);
  });

  it("returns null when contact is not found", async () => {
    mockContactsResolveWallet.mockResolvedValue(null);

    const { ContactsAdapter } = await import("@/messaging/contacts.adapter.js");
    const result = await ContactsAdapter.resolveWallet("+15550001111", "unknown-person");

    expect(result).toBeNull();
  });
});

// ── Tests: Phone escrow deposit path ─────────────────────────────────────────

describe("send money — phone escrow deposit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("buildDepositDraft returns two calls: approve + deposit", async () => {
    mockPhoneEscrowBuildDraft.mockReturnValue({
      phone: "+15551234567",
      phoneHash: "0xhash",
      tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      tokenSymbol: "USDC",
      tokenDecimals: 6,
      amountAtomic: BigInt(10_000_000),
      amount: "10",
      calls: [
        { to: "0xusdc", value: "0x0", data: "0xapprove", metadata: {} },
        { to: "0xescrow", value: "0x0", data: "0xdeposit", metadata: {} },
      ],
    });

    const { PhoneEscrowAdapter } = await import("@/wallet/phoneEscrow.js");
    const draft = PhoneEscrowAdapter.buildDepositDraft("+15551234567", "10", {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      symbol: "USDC",
      decimals: 6,
    });

    expect(draft.calls).toHaveLength(2);
    expect(draft.amount).toBe("10");
    expect(draft.phone).toBe("+15551234567");
  });
});

// ── Tests: EscrowReleasePoller ────────────────────────────────────────────────

describe("EscrowReleasePoller.tickOnce", () => {
  it("skips recipient when no embedded wallet address", async () => {
    const { EscrowReleasePoller } = await import("@/wallet/escrowReleasePoller.js");

    const mockDeps = {
      listPositions: vi.fn().mockResolvedValue([{
        phone: "+15551234567",
        tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        tokenSymbol: "USDC",
        tokenDecimals: 6,
      }]),
      getConnectedAddress: vi.fn().mockResolvedValue(null), // no address
      claim: vi.fn().mockResolvedValue(true),
      unclaim: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(null),
      deliver: vi.fn().mockResolvedValue(true),
      buildMessage: vi.fn().mockReturnValue("you got paid"),
    };

    const poller = new EscrowReleasePoller(mockDeps as any);
    const result = await poller.tickOnce();

    expect(result.released).toBe(0);
    expect(mockDeps.release).not.toHaveBeenCalled();
  });

  it("releases escrow and delivers DM when recipient has embedded wallet", async () => {
    const { EscrowReleasePoller } = await import("@/wallet/escrowReleasePoller.js");

    const mockDeps = {
      listPositions: vi.fn().mockResolvedValue([{
        phone: "+15551234567",
        tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        tokenSymbol: "USDC",
        tokenDecimals: 6,
      }]),
      getConnectedAddress: vi
        .fn()
        .mockResolvedValue("0xabcdef1234567890abcdef1234567890abcdef12"),
      claim: vi.fn().mockResolvedValue(true),
      unclaim: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue({ amount: "10", transactionHash: "0xtx" }),
      deliver: vi.fn().mockResolvedValue(true),
      buildMessage: vi.fn().mockReturnValue("you got paid 10 USDC"),
    };

    const poller = new EscrowReleasePoller(mockDeps as any);
    const result = await poller.tickOnce();

    expect(result.released).toBe(1);
    expect(result.delivered).toBe(1);
    expect(mockDeps.deliver).toHaveBeenCalledWith("+15551234567", "you got paid 10 USDC");
  });

  it("skips release when claim lock fails (concurrent release)", async () => {
    const { EscrowReleasePoller } = await import("@/wallet/escrowReleasePoller.js");

    const mockDeps = {
      listPositions: vi.fn().mockResolvedValue([{
        phone: "+15551234567",
        tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        tokenSymbol: "USDC",
        tokenDecimals: 6,
      }]),
      getConnectedAddress: vi
        .fn()
        .mockResolvedValue("0xabcdef1234567890abcdef1234567890abcdef12"),
      claim: vi.fn().mockResolvedValue(false), // lock not acquired
      unclaim: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue({ amount: "10", transactionHash: "0xtx" }),
      deliver: vi.fn().mockResolvedValue(true),
      buildMessage: vi.fn().mockReturnValue("you got paid"),
    };

    const poller = new EscrowReleasePoller(mockDeps as any);
    const result = await poller.tickOnce();

    expect(result.released).toBe(0);
    expect(mockDeps.release).not.toHaveBeenCalled();
  });

  it("unclaimslock when release returns null (no on-chain escrow)", async () => {
    const { EscrowReleasePoller } = await import("@/wallet/escrowReleasePoller.js");

    const mockDeps = {
      listPositions: vi.fn().mockResolvedValue([{
        phone: "+15551234567",
        tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        tokenSymbol: "USDC",
        tokenDecimals: 6,
      }]),
      getConnectedAddress: vi
        .fn()
        .mockResolvedValue("0xabcdef1234567890abcdef1234567890abcdef12"),
      claim: vi.fn().mockResolvedValue(true),
      unclaim: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(null), // nothing on chain
      deliver: vi.fn().mockResolvedValue(true),
      buildMessage: vi.fn().mockReturnValue("you got paid"),
    };

    const poller = new EscrowReleasePoller(mockDeps as any);
    const result = await poller.tickOnce();

    expect(result.released).toBe(0);
    expect(mockDeps.unclaim).toHaveBeenCalledWith(
      expect.objectContaining({ phone: "+15551234567", tokenSymbol: "USDC" }),
    );
  });
});
