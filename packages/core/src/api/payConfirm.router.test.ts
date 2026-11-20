import type { Server } from "node:http";

import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getByToken: vi.fn(),
  markSigned: vi.fn(),
  getEmbeddedWallet: vi.fn(),
  sendCalls: vi.fn(),
  recordConfirmedActivity: vi.fn(),
  confirmDeposit: vi.fn(),
}));

vi.mock("@/wallet/pendingPay.js", () => ({
  PendingPayAdapter: {
    getByToken: mocks.getByToken,
    markSigned: mocks.markSigned,
  },
}));

vi.mock("@/discovery/adapters/wallet.adapter.js", () => ({
  WalletAdapter: {
    getEmbeddedWallet: mocks.getEmbeddedWallet,
  },
}));

vi.mock("@/wallet/embeddedWallet.js", () => ({
  EmbeddedWalletError: class EmbeddedWalletError extends Error {
    needsReauth = false;
  },
  EmbeddedWalletAdapter: {
    sendCalls: mocks.sendCalls,
  },
}));

vi.mock("@/discovery/adapters/txConfirmation.adapter.js", () => ({
  TxConfirmationAdapter: {
    recordConfirmedActivity: mocks.recordConfirmedActivity,
  },
}));

vi.mock("@/wallet/phoneEscrow.js", () => ({
  PhoneEscrowAdapter: {
    confirmDeposit: mocks.confirmDeposit,
  },
}));

vi.mock("@/utils/logger.js", () => ({
  logger: { error: vi.fn() },
}));

import { mountPayConfirmApi } from "@/api/payConfirm.router.js";
import { createPortfolioAccessToken } from "@/portfolio/access.js";

const TOKEN = "a".repeat(32);
const OWNER = "owner-1";
const ADDRESS = "0x1111111111111111111111111111111111111111";

function pendingRow() {
  return {
    token: TOKEN,
    senderId: OWNER,
    fromAddress: ADDRESS,
    chainId: "0x2105",
    calls: [{ to: "0x2222222222222222222222222222222222222222", value: "0x1" }],
    label: "Send",
    recipientDisplay: "+15550002222",
    amount: "1",
    tokenSymbol: "USDC",
    transferMemo: "Thanks",
    walletKind: "embedded",
    status: "pending",
    txHash: null,
    expiresAt: new Date(Date.now() + 60_000),
  };
}

describe("embedded pay confirmation authorization", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    process.env.SERVICE_API_KEY = "pay-confirm-test-secret";
    const app = express();
    mountPayConfirmApi(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getByToken.mockResolvedValue(pendingRow());
    mocks.getEmbeddedWallet.mockResolvedValue({
      cdpUserId: "cdp-owner",
      address: ADDRESS,
      delegationId: "delegation",
      delegationExpiresAt: new Date(Date.now() + 60_000),
    });
    mocks.sendCalls.mockResolvedValue({ txHash: "0xhash" });
    mocks.markSigned.mockResolvedValue(pendingRow());
    mocks.recordConfirmedActivity.mockResolvedValue(undefined);
    mocks.confirmDeposit.mockResolvedValue(null);
  });

  async function confirm(body: Record<string, unknown>) {
    return fetch(`${origin}/api/pay/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, ...body }),
    });
  }

  it("rejects a missing session without executing", async () => {
    const response = await confirm({});

    expect(response.status).toBe(401);
    expect(mocks.sendCalls).not.toHaveBeenCalled();
  });

  it("rejects a valid session owned by another user", async () => {
    const response = await confirm({
      user: "other-user",
      sessionToken: createPortfolioAccessToken("other-user"),
    });

    expect(response.status).toBe(403);
    expect(mocks.sendCalls).not.toHaveBeenCalled();
  });

  it("rejects an expired owner session", async () => {
    const response = await confirm({
      user: OWNER,
      sessionToken: createPortfolioAccessToken(OWNER, { now: 1, ttlMs: 1 }),
    });

    expect(response.status).toBe(401);
    expect(mocks.sendCalls).not.toHaveBeenCalled();
  });

  it("rejects a transaction whose from address no longer matches the wallet", async () => {
    mocks.getEmbeddedWallet.mockResolvedValue({
      cdpUserId: "cdp-owner",
      address: "0x3333333333333333333333333333333333333333",
      delegationId: "delegation",
      delegationExpiresAt: new Date(Date.now() + 60_000),
    });

    const response = await confirm({
      user: OWNER,
      sessionToken: createPortfolioAccessToken(OWNER),
    });

    expect(response.status).toBe(409);
    expect(mocks.sendCalls).not.toHaveBeenCalled();
  });

  it("executes for the authenticated owner", async () => {
    const response = await confirm({
      user: OWNER,
      sessionToken: createPortfolioAccessToken(OWNER),
    });

    expect(response.status).toBe(200);
    expect(mocks.sendCalls).toHaveBeenCalledOnce();
    expect(mocks.markSigned).toHaveBeenCalledWith(TOKEN, "0xhash");
    expect(mocks.recordConfirmedActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientPhone: "+15550002222",
        transferAmount: "1",
        transferAsset: "USDC",
        transferMemo: "Thanks",
      }),
    );
    expect(mocks.confirmDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: OWNER,
        recipientPhone: "+15550002222",
        depositTxHash: "0xhash",
        senderRefundAddress: ADDRESS,
        amountDisplay: "1",
        tokenSymbol: "USDC",
      }),
    );
  });
});
