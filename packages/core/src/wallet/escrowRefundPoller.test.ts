import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config/config.js", () => ({
  config: {
    phoneEscrow: {
      releaseEnabled: true,
      refundEnabled: true,
      claimTtlHours: 72,
    },
  },
}));
vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/discovery/db.js", () => ({ db: { query: vi.fn(), connect: vi.fn() } }));
vi.mock("@/discovery/adapters/wallet.adapter.js", () => ({ WalletAdapter: {} }));
vi.mock("./phoneEscrow.js", () => ({ PhoneEscrowAdapter: {} }));
vi.mock("@/state/conversationState.store.js", () => ({
  acquireLock: vi.fn(async () => true),
  releaseLock: vi.fn(async () => undefined),
}));
vi.mock("@/infra/queues/base.js", () => ({
  startPollerJob: vi.fn(),
}));

import { EscrowRefundPoller, buildEscrowRefundMessage } from "./escrowRefundPoller.js";
import type { PhoneEscrowDepositRow, PhoneEscrowRefundResult } from "./phoneEscrow.js";

const ROW: PhoneEscrowDepositRow = {
  id: "42",
  senderId: "+15550001111",
  recipientPhone: "+15551234567",
  phoneHash: "0xhash",
  tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  tokenSymbol: "USDC",
  tokenDecimals: 6,
  amountAtomic: 10_000_000n,
  amountDisplay: "10",
  status: "deposited",
  senderRefundAddress: "0x1111111111111111111111111111111111111111",
  depositTxHash: "0xdep",
  claimExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
};

function refundResult(): PhoneEscrowRefundResult {
  return {
    id: ROW.id,
    phone: ROW.recipientPhone,
    phoneHash: ROW.phoneHash,
    tokenAddress: ROW.tokenAddress,
    tokenSymbol: ROW.tokenSymbol,
    tokenDecimals: ROW.tokenDecimals,
    amount: "10",
    amountAtomic: ROW.amountAtomic,
    senderRefundAddress: ROW.senderRefundAddress!,
    senderId: ROW.senderId,
    transactionHash: "0xrefund",
  };
}

describe("EscrowRefundPoller.tickOnce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refunds expired deposit and DMs sender when recipient has no wallet", async () => {
    const mockDeps = {
      listExpired: vi.fn().mockResolvedValue([ROW]),
      getConnectedAddress: vi.fn().mockResolvedValue(null),
      claim: vi.fn().mockResolvedValue(true),
      unclaim: vi.fn().mockResolvedValue(undefined),
      refund: vi.fn().mockResolvedValue(refundResult()),
      deliver: vi.fn().mockResolvedValue(true),
      buildMessage: vi.fn().mockReturnValue("refunded"),
    };

    const poller = new EscrowRefundPoller(mockDeps);
    const result = await poller.tickOnce();

    expect(result.refunded).toBe(1);
    expect(result.delivered).toBe(1);
    expect(mockDeps.refund).toHaveBeenCalledWith(ROW);
    expect(mockDeps.deliver).toHaveBeenCalledWith(ROW.senderId, "refunded");
  });

  it("skips refund when recipient has connected a wallet", async () => {
    const mockDeps = {
      listExpired: vi.fn().mockResolvedValue([ROW]),
      getConnectedAddress: vi
        .fn()
        .mockResolvedValue("0xabcdef1234567890abcdef1234567890abcdef12"),
      claim: vi.fn().mockResolvedValue(true),
      unclaim: vi.fn().mockResolvedValue(undefined),
      refund: vi.fn().mockResolvedValue(refundResult()),
      deliver: vi.fn().mockResolvedValue(true),
      buildMessage: vi.fn().mockReturnValue("refunded"),
    };

    const poller = new EscrowRefundPoller(mockDeps);
    const result = await poller.tickOnce();

    expect(result.skippedConnected).toBe(1);
    expect(result.refunded).toBe(0);
    expect(mockDeps.claim).not.toHaveBeenCalled();
    expect(mockDeps.refund).not.toHaveBeenCalled();
  });

  it("rolls back lock when on-chain balance is insufficient", async () => {
    const mockDeps = {
      listExpired: vi.fn().mockResolvedValue([ROW]),
      getConnectedAddress: vi.fn().mockResolvedValue(null),
      claim: vi.fn().mockResolvedValue(true),
      unclaim: vi.fn().mockResolvedValue(undefined),
      refund: vi.fn().mockResolvedValue(null),
      deliver: vi.fn().mockResolvedValue(true),
      buildMessage: vi.fn().mockReturnValue("refunded"),
    };

    const poller = new EscrowRefundPoller(mockDeps);
    const result = await poller.tickOnce();

    expect(result.refunded).toBe(0);
    expect(mockDeps.unclaim).toHaveBeenCalledWith("42");
    expect(mockDeps.deliver).not.toHaveBeenCalled();
  });

  it("skips when claim lock fails", async () => {
    const mockDeps = {
      listExpired: vi.fn().mockResolvedValue([ROW]),
      getConnectedAddress: vi.fn().mockResolvedValue(null),
      claim: vi.fn().mockResolvedValue(false),
      unclaim: vi.fn().mockResolvedValue(undefined),
      refund: vi.fn().mockResolvedValue(refundResult()),
      deliver: vi.fn().mockResolvedValue(true),
      buildMessage: vi.fn().mockReturnValue("refunded"),
    };

    const poller = new EscrowRefundPoller(mockDeps);
    const result = await poller.tickOnce();

    expect(result.refunded).toBe(0);
    expect(mockDeps.refund).not.toHaveBeenCalled();
  });

  it("unclaims on refund throw so a later tick can retry", async () => {
    const mockDeps = {
      listExpired: vi.fn().mockResolvedValue([ROW]),
      getConnectedAddress: vi.fn().mockResolvedValue(null),
      claim: vi.fn().mockResolvedValue(true),
      unclaim: vi.fn().mockResolvedValue(undefined),
      refund: vi.fn().mockRejectedValue(new Error("rpc down")),
      deliver: vi.fn().mockResolvedValue(true),
      buildMessage: vi.fn().mockReturnValue("refunded"),
    };

    const poller = new EscrowRefundPoller(mockDeps);
    const result = await poller.tickOnce();

    expect(result.refunded).toBe(0);
    expect(mockDeps.unclaim).toHaveBeenCalledWith("42");
  });
});

describe("buildEscrowRefundMessage", () => {
  it("mentions amount, phone, and TTL", () => {
    const msg = buildEscrowRefundMessage(refundResult());
    expect(msg).toContain("10 USDC");
    expect(msg).toContain("+15551234567");
    expect(msg).toContain("72 hours");
    expect(msg).toContain("back in your wallet");
  });
});
