/**
 * onramp.handler.test.ts — Tests for the iMessage headless on-ramp state machine.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRedis } from "@/test-utils/mockRedis.js";
import { formatOutboundForRepl } from "@/imessage/outbound.js";

const mockRedisInstance = createMockRedis();

vi.mock("@/infra/redis.js", () => ({
  getRedis: () => mockRedisInstance,
  getRedisOrNull: () => mockRedisInstance,
}));

const mockOnrampUserDataGet = vi.hoisted(() => vi.fn());
const mockOnrampUserDataUpsert = vi.hoisted(() => vi.fn());
const mockNeedsPhoneReverification = vi.hoisted(() => vi.fn().mockReturnValue(false));

vi.mock("@/wallet/onrampUserData.js", () => ({
  OnrampUserDataAdapter: {
    get: mockOnrampUserDataGet,
    upsert: mockOnrampUserDataUpsert,
    needsPhoneReverification: mockNeedsPhoneReverification,
  },
}));

const mockBuildHeadlessFundLinks = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    paymentLinkOptions: [
      {
        method: "apple_pay",
        label: "Apple Pay",
        url: "https://pay.coinbase.com/guest/apple/mock",
      },
    ],
  }),
);

const mockBuildHostedFallbackUrl = vi.hoisted(() =>
  vi.fn().mockResolvedValue("https://pay.coinbase.com/buy/select-asset?sessionToken=mock"),
);

const mockFundSessionCreate = vi.hoisted(() => vi.fn().mockResolvedValue("mock-fund-session-token"));

vi.mock("@/wallet/onramp.js", () => ({
  buildHeadlessFundLinks: mockBuildHeadlessFundLinks,
  buildHostedFallbackUrl: mockBuildHostedFallbackUrl,
  buildOfframpUrl: vi.fn().mockResolvedValue("https://pay.coinbase.com/sell?sessionToken=mock"),
  isCoinbaseRegionForbiddenError: vi.fn().mockReturnValue(false),
  ONRAMP_MIN_USD: 2,
}));

vi.mock("@/wallet/fundSession.js", () => ({
  FundSessionAdapter: {
    create: mockFundSessionCreate,
  },
}));

vi.mock("@/config/config.js", () => ({
  config: {
    cdp: {
      enabled: true,
      onrampSandbox: false,
      fundPageUrl: "https://basemate.app/pay",
      onrampRedirectUrl: "https://basemate.app/onramp-complete",
      fundPageDomain: "basemate.app",
      onrampClientIpFallback: "",
    },
    redisUrl: "redis://localhost:6379",
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

vi.mock("@/discovery/ai.js", () => ({
  prepareAvantisOpen: vi.fn(),
  normalizeAvantisPair: vi.fn((p: string) => p),
}));

vi.mock("@/wallet/cdp.js", () => ({
  getUsdcBalance: vi.fn().mockResolvedValue("0"),
  getBalances: vi.fn().mockResolvedValue([]),
  withdraw: vi.fn().mockResolvedValue({ transactionHash: "0xtest" }),
  isCdpEnabled: vi.fn().mockReturnValue(true),
  GasEstimationError: class GasEstimationError extends Error {},
  InsufficientGasError: class InsufficientGasError extends Error {},
}));

vi.mock("@/wallet/sweep.js", () => ({
  sweepCustodialWallets: vi.fn(),
  resolveCustodialSweepWallets: vi.fn(),
  formatSweepPreview: vi.fn().mockReturnValue("sweep preview"),
  formatSweepResult: vi.fn().mockReturnValue("sweep done"),
}));

vi.mock("@/wallet/phoneEscrow.js", () => ({
  PhoneEscrowAdapter: {
    buildDepositDraft: vi.fn(),
    releaseUsdcToBaseAccount: vi.fn().mockResolvedValue(null),
    hasPending: vi.fn().mockResolvedValue(false),
  },
}));

async function getHandleFundAmount() {
  const { handleFundAmount } = await import("@/messaging/handlers/wallet.handler.js");
  return handleFundAmount;
}

function makeCtx() {
  return {
    platform: "imessage" as const,
    K: {
      pendingFundAmount: (s: string) => `conv:imessage:${s}:pendingFundAmount`,
      pendingOnrampEmail: (s: string) => `conv:imessage:${s}:pendingOnrampEmail`,
      pendingEmailOtpVerification: (s: string) => `conv:imessage:${s}:pendingEmailOtpVerification`,
      pendingPhoneOtpVerification: (s: string) => `conv:imessage:${s}:pendingPhoneOtpVerification`,
    },
  } as any;
}

const SENDER = "+15550001111";
const WALLET = "0xabc1234567890123456789012345678901234567";

function verifiedUserData() {
  return {
    email: "user@example.com",
    tosAcceptedAt: new Date("2025-01-01"),
    emailVerifiedAt: new Date("2025-01-01"),
    phoneVerifiedAt: new Date("2025-01-01"),
    phoneNumber: "+15550001111",
  };
}

describe("handleFundAmount", () => {
  beforeEach(() => {
    mockRedisInstance.clear();
    vi.clearAllMocks();
    mockOnrampUserDataGet.mockReset();
    mockBuildHeadlessFundLinks.mockReset().mockResolvedValue({
      paymentLinkOptions: [
        {
          method: "apple_pay",
          label: "Apple Pay",
          url: "https://pay.coinbase.com/guest/apple/mock",
        },
      ],
    });
    mockFundSessionCreate.mockReset().mockResolvedValue("mock-fund-session-token");
  });

  it("returns preset menu when no amount given", async () => {
    const handleFundAmount = await getHandleFundAmount();
    mockOnrampUserDataGet.mockResolvedValue(verifiedUserData());

    const result = await handleFundAmount(makeCtx(), SENDER, WALLET, "0");

    expect(result[0]).toContain("minimum $2");
    const stored = await mockRedisInstance.get(`conv:imessage:${SENDER}:pendingFundAmount`);
    expect(stored).toBeTruthy();
  });

  it("rejects sub-minimum amount without trapping user in pending state", async () => {
    const handleFundAmount = await getHandleFundAmount();
    mockOnrampUserDataGet.mockResolvedValue(verifiedUserData());

    const result = await handleFundAmount(makeCtx(), SENDER, WALLET, "1");

    expect(result[0]).toContain("minimum is $2");
    const stored = await mockRedisInstance.get(`conv:imessage:${SENDER}:pendingFundAmount`);
    expect(stored).toBeFalsy();
  });

  it("prompts for email when no email on record", async () => {
    const handleFundAmount = await getHandleFundAmount();
    mockOnrampUserDataGet.mockResolvedValue(null);

    const result = await handleFundAmount(makeCtx(), SENDER, WALLET, "25");

    expect(result[0]).toMatch(/email/i);
  });

  it("auto-verifies phone for iMessage senders and proceeds", async () => {
    const handleFundAmount = await getHandleFundAmount();
    mockNeedsPhoneReverification.mockReturnValue(true);
    mockOnrampUserDataGet.mockResolvedValue({
      ...verifiedUserData(),
      phoneVerifiedAt: null,
    });

    const result = await handleFundAmount(makeCtx(), SENDER, WALLET, "25");

    expect(mockOnrampUserDataUpsert).toHaveBeenCalled();
    expect(formatOutboundForRepl(result[0])).toMatch(/pay\?s=/i);
  });

  it("returns /pay link on fully verified happy path", async () => {
    const handleFundAmount = await getHandleFundAmount();
    mockOnrampUserDataGet.mockResolvedValue(verifiedUserData());

    const result = await handleFundAmount(makeCtx(), SENDER, WALLET, "50");

    expect(mockBuildHeadlessFundLinks).toHaveBeenCalled();
    expect(mockFundSessionCreate).toHaveBeenCalledWith(
      SENDER,
      "https://pay.coinbase.com/guest/apple/mock",
      expect.arrayContaining([
        expect.objectContaining({ url: "https://pay.coinbase.com/guest/apple/mock" }),
      ]),
      50,
      WALLET,
    );
    const text = formatOutboundForRepl(result[0]);
    expect(text).toContain("basemate.app/pay?s=mock-fund-session-token");
    expect(text).toContain("$50");
  });

  it("returns error when headless links are empty", async () => {
    const handleFundAmount = await getHandleFundAmount();
    mockOnrampUserDataGet.mockResolvedValue(verifiedUserData());
    mockBuildHeadlessFundLinks.mockResolvedValue({ paymentLinkOptions: [] });

    const result = await handleFundAmount(makeCtx(), SENDER, WALLET, "25");

    expect(result[0]).toMatch(/couldn't generate a payment link/i);
  });
});
