import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionAdapter = vi.hoisted(() => ({
  getByCapability: vi.fn(),
  markLaunched: vi.fn(),
  recordCoinbaseTransaction: vi.fn(),
  claimApproval: vi.fn(),
  releaseApprovalClaim: vi.fn(),
  getById: vi.fn(),
  updateTransferStatus: vi.fn(),
  create: vi.fn(),
}));
const buildOfframpUrl = vi.hoisted(() => vi.fn());
const sendEmbeddedCalls = vi.hoisted(() => vi.fn());

vi.mock("@coinbase/cdp-sdk/auth", () => ({ generateJwt: vi.fn().mockResolvedValue("jwt") }));
vi.mock("@/config/config.js", () => ({
  config: {
    cdp: {
      paymentsEnabled: true,
      apiKeyId: "key",
      apiKeySecret: "secret",
      offrampRedirectUrl: "https://basemate.app/pay/offramp/return",
      fundPageUrl: "https://basemate.app/pay",
      onrampClientIpFallback: "192.0.2.1",
    },
  },
}));
vi.mock("@/wallet/onramp.js", () => ({ buildOfframpUrl }));
vi.mock("@/wallet/offrampSession.js", () => ({
  OfframpSessionAdapter: sessionAdapter,
}));
vi.mock("@/discovery/adapters/wallet.adapter.js", () => ({
  WalletAdapter: {
    getEmbeddedWallet: vi.fn(async () => ({
      cdpUserId: "cdp-user",
      address: "0x1111111111111111111111111111111111111111",
    })),
  },
}));
vi.mock("@/wallet/embeddedWallet.js", () => ({
  EmbeddedWalletAdapter: { sendCalls: sendEmbeddedCalls },
}));
vi.mock("@/wallet/cdp.js", () => ({
  BASE_USDC_ADDRESS: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
}));

const sourceAddress = "0x1111111111111111111111111111111111111111";
const toAddress = "0x2222222222222222222222222222222222222222";
const baseSession = {
  id: "a".repeat(32),
  capabilityHash: "hash",
  platform: "imessage",
  userKey: "+15550001111",
  sourceAddress,
  partnerUserRef: `bm-${"a".repeat(32)}`,
  requestedAmount: "10",
  status: "launched",
  coinbaseTransactionId: null,
  coinbaseStatus: null,
  sellAmount: null,
  fiatTotal: null,
  fiatCurrency: null,
  coinbaseFee: null,
  toAddress: null,
  baseMcpRequestId: null,
  baseMcpApprovalUrl: null,
  txConfirmationSid: null,
  txHash: null,
  launchExpiresAt: new Date(Date.now() + 60_000),
  transferExpiresAt: new Date(Date.now() + 60_000),
  notifiedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("offramp orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionAdapter.getByCapability.mockResolvedValue(baseSession);
    buildOfframpUrl.mockResolvedValue("https://pay.coinbase.com/v3/sell/input?sessionToken=test");
    sessionAdapter.markLaunched.mockResolvedValue(baseSession);
    sendEmbeddedCalls.mockResolvedValue({ txHash: "0xembedded", userOpHash: null });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          transactions: [
            {
              transaction_id: "coinbase-tx",
              status: "TRANSACTION_STATUS_STARTED",
              asset: "USDC",
              network: "base",
              sell_amount: { value: "10.000000", currency: "USDC" },
              total: { value: "9.50", currency: "USD" },
              coinbase_fee: { value: "0.50", currency: "USD" },
              from_address: sourceAddress,
              to_address: toAddress,
            },
          ],
        }),
      }),
    );
  });

  it("mints a one-click URL only when the draft is launched", async () => {
    const { launchOfframp } = await import("./offramp.js");
    const result = await launchOfframp("x".repeat(32));
    expect(buildOfframpUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        address: sourceAddress,
        presetCryptoAmount: "10",
        disableEdit: true,
        redirectUrl: expect.stringContaining(`o=${"x".repeat(32)}`),
      }),
    );
    expect(sessionAdapter.markLaunched).toHaveBeenCalledWith(baseSession.id);
    expect(result.coinbaseUrl).toContain("pay.coinbase.com");
  });

  it("validates Coinbase details and sends the exact Base USDC transfer", async () => {
    const ready = {
      ...baseSession,
      status: "transaction_ready",
      coinbaseTransactionId: "coinbase-tx",
      sellAmount: "10",
      toAddress,
    };
    sessionAdapter.recordCoinbaseTransaction.mockResolvedValue(ready);
    sessionAdapter.claimApproval.mockResolvedValue(ready);
    sessionAdapter.getById.mockResolvedValue({
      ...ready,
      status: "transfer_submitted",
      txHash: "0xembedded",
    });

    const { createOfframpApproval } = await import("./offramp.js");
    const result = await createOfframpApproval("x".repeat(32));

    expect(sendEmbeddedCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        calls: [
          expect.objectContaining({
            to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            data: expect.stringMatching(/^0xa9059cbb/),
          }),
        ],
      }),
    );
    expect(sessionAdapter.updateTransferStatus).toHaveBeenCalledWith(baseSession.id, {
      status: "transfer_submitted",
      txHash: "0xembedded",
    });
    expect(result.approvalUrl).toBe("");
  });

  it("rejects a Coinbase amount mismatch before creating approval", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          transactions: [
            {
              transaction_id: "coinbase-tx",
              status: "TRANSACTION_STATUS_STARTED",
              asset: "USDC",
              network: "base",
              sell_amount: { value: "11", currency: "USDC" },
              from_address: sourceAddress,
              to_address: toAddress,
            },
          ],
        }),
      }),
    );
    const { createOfframpApproval } = await import("./offramp.js");
    await expect(createOfframpApproval("x".repeat(32))).rejects.toThrow(
      /different sell amount/i,
    );
    expect(sessionAdapter.claimApproval).not.toHaveBeenCalled();
    expect(sendEmbeddedCalls).not.toHaveBeenCalled();
  });
});
