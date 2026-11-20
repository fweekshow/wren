import { describe, expect, it, vi, beforeEach } from "vitest";
import { decodeFunctionData, encodeFunctionData } from "viem";

const testState = vi.hoisted(() => ({
  queryMock: vi.fn(async () => ({ rows: [] })),
}));

vi.mock("@/config/config.js", () => ({
  config: {
    phoneEscrow: {
      enabled: true,
      releaseEnabled: false,
      refundEnabled: false,
      claimTtlHours: 72,
      contractAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      phoneHashSalt: "test-salt",
      operatorPrivateKey: "",
    },
  },
}));

vi.mock("@/discovery/db.js", () => ({
  db: { query: testState.queryMock },
}));

vi.mock("@/messaging/contacts.adapter.js", () => ({
  ContactsAdapter: {
    normalizeHandle(raw: string | null | undefined) {
      if (!raw) return null;
      const cleaned = raw.replace(/[^\d+]/g, "");
      return /^\+\d{7,15}$/.test(cleaned) ? cleaned : null;
    },
  },
}));

vi.mock("./cdp.js", () => ({
  BASE_USDC_ADDRESS: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  CDP_NETWORK: "base",
  getCdpClient: vi.fn(),
}));

import { PHONE_ESCROW_ABI, PhoneEscrowAdapter } from "./phoneEscrow.js";

const USDC = {
  address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  symbol: "USDC",
  decimals: 6,
};
const BASEMATE = {
  address: "0x07E61D8a4e197dfC269e90D7ECe1dF0D26702bA3",
  symbol: "BASEMATE",
  decimals: 18,
};

const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

describe("PhoneEscrowAdapter", () => {
  beforeEach(() => {
    testState.queryMock.mockClear();
  });

  it("hashes normalized phones consistently", () => {
    expect(PhoneEscrowAdapter.phoneHash("+1 (555) 123-4567")).toBe(
      PhoneEscrowAdapter.phoneHash("+15551234567"),
    );
  });

  it("builds USDC approve and escrow deposit calls", () => {
    const draft = PhoneEscrowAdapter.buildDepositDraft("+15551234567", "1.25", USDC);

    expect(draft.amountAtomic).toBe(1_250_000n);
    expect(draft.calls).toHaveLength(2);

    const approve = decodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      data: draft.calls[0].data!,
    });
    expect(approve.functionName).toBe("approve");
    expect(approve.args?.[0].toLowerCase()).toBe("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    expect(approve.args?.[1]).toBe(1_250_000n);

    const deposit = decodeFunctionData({
      abi: PHONE_ESCROW_ABI,
      data: draft.calls[1].data!,
    });
    expect(deposit.functionName).toBe("deposit");
    expect(deposit.args?.[0]).toBe(draft.phoneHash);
    expect(deposit.args?.[1].toLowerCase()).toBe(USDC.address);
    expect(deposit.args?.[2]).toBe(1_250_000n);
    expect(draft.calls[0].metadata?.description).toContain("so they can claim");
    expect(draft.calls[1].metadata?.description).toContain("for them to claim");
    expect(JSON.stringify(draft.calls)).not.toMatch(/\bescrow\b/i);
  });

  it("uses the resolved token decimals and address for BASEMATE", () => {
    const draft = PhoneEscrowAdapter.buildDepositDraft(
      "+15551234567",
      "10000",
      BASEMATE,
    );
    expect(draft.amountAtomic).toBe(10_000n * 10n ** 18n);
    expect(draft.tokenSymbol).toBe("BASEMATE");

    const deposit = decodeFunctionData({
      abi: PHONE_ESCROW_ABI,
      data: draft.calls[1].data!,
    });
    expect(deposit.args?.[1].toLowerCase()).toBe(BASEMATE.address.toLowerCase());
    expect(deposit.args?.[2]).toBe(10_000n * 10n ** 18n);
  });

  it("records a pending deposit intent", async () => {
    const draft = PhoneEscrowAdapter.buildDepositDraft("+15551234567", "2", BASEMATE);

    await PhoneEscrowAdapter.recordDepositIntent({
      senderId: "sender-1",
      phone: draft.phone,
      phoneHash: draft.phoneHash,
      tokenAddress: draft.tokenAddress,
      tokenSymbol: draft.tokenSymbol,
      tokenDecimals: draft.tokenDecimals,
      amountAtomic: draft.amountAtomic,
      amount: draft.amount,
    });

    expect(testState.queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO imessage_phone_escrows"),
      [
        "sender-1",
        "+15551234567",
        draft.phoneHash,
        BASEMATE.address.toLowerCase(),
        "BASEMATE",
        18,
        "2000000000000000000",
        "2",
      ],
    );
  });

  it("locks and unlocks release rows for only one token", async () => {
    const position = {
      phone: "+15551234567",
      tokenAddress: BASEMATE.address as `0x${string}`,
      tokenSymbol: BASEMATE.symbol,
      tokenDecimals: BASEMATE.decimals,
    };
    testState.queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await expect(PhoneEscrowAdapter.claimForRelease(position)).resolves.toBe(true);
    expect(testState.queryMock).toHaveBeenLastCalledWith(
      expect.stringContaining("lower(token_address) = lower($2)"),
      ["+15551234567", BASEMATE.address],
    );
    expect(testState.queryMock.mock.calls.at(-1)?.[0]).toContain(
      "status IN ('deposited', 'link_created')",
    );

    await PhoneEscrowAdapter.unclaimForRelease(position);
    expect(testState.queryMock).toHaveBeenLastCalledWith(
      expect.stringContaining("lower(token_address) = lower($2)"),
      ["+15551234567", BASEMATE.address],
    );
  });

  it("confirms a deposit intent and starts the claim TTL", async () => {
    const expires = new Date("2026-07-27T00:00:00.000Z");
    testState.queryMock
      .mockResolvedValueOnce({ rows: [] }) // no existing by tx hash
      .mockResolvedValueOnce({
        rows: [
          {
            id: 42,
            sender_id: "sender-1",
            recipient_phone: "+15551234567",
            phone_hash: PhoneEscrowAdapter.phoneHash("+15551234567"),
            token_address: BASEMATE.address.toLowerCase(),
            token_symbol: "BASEMATE",
            token_decimals: 18,
            amount_atomic: "2000000000000000000",
            amount_display: "2",
            status: "deposited",
            sender_refund_address: "0x1111111111111111111111111111111111111111",
            deposit_tx_hash: "0xabc",
            claim_expires_at: expires,
          },
        ],
        rowCount: 1,
      });

    const confirmed = await PhoneEscrowAdapter.confirmDeposit({
      senderId: "sender-1",
      recipientPhone: "+15551234567",
      depositTxHash: "0xabc",
      senderRefundAddress: "0x1111111111111111111111111111111111111111",
      amountDisplay: "2",
      tokenSymbol: "BASEMATE",
    });

    expect(confirmed?.status).toBe("deposited");
    expect(confirmed?.id).toBe("42");
    expect(confirmed?.depositTxHash).toBe("0xabc");
    expect(testState.queryMock.mock.calls[1]?.[0]).toContain("status = 'deposited'");
    expect(testState.queryMock.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(["0xabc", "0x1111111111111111111111111111111111111111", 72]),
    );
  });

  it("is idempotent when deposit_tx_hash already confirmed", async () => {
    testState.queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 7,
          sender_id: "sender-1",
          recipient_phone: "+15551234567",
          phone_hash: PhoneEscrowAdapter.phoneHash("+15551234567"),
          token_address: BASEMATE.address.toLowerCase(),
          token_symbol: "BASEMATE",
          token_decimals: 18,
          amount_atomic: "1",
          amount_display: "1",
          status: "deposited",
          sender_refund_address: "0x1111111111111111111111111111111111111111",
          deposit_tx_hash: "0xdup",
          claim_expires_at: new Date(),
        },
      ],
    });

    const confirmed = await PhoneEscrowAdapter.confirmDeposit({
      senderId: "sender-1",
      recipientPhone: "+15551234567",
      depositTxHash: "0xdup",
      senderRefundAddress: "0x1111111111111111111111111111111111111111",
    });
    expect(confirmed?.id).toBe("7");
    expect(testState.queryMock).toHaveBeenCalledTimes(1);
  });

  it("lists expired deposits for refund", async () => {
    testState.queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 9,
          sender_id: "+15550001111",
          recipient_phone: "+15551234567",
          phone_hash: PhoneEscrowAdapter.phoneHash("+15551234567"),
          token_address: USDC.address.toLowerCase(),
          token_symbol: "USDC",
          token_decimals: 6,
          amount_atomic: "1000000",
          amount_display: "1",
          status: "deposited",
          sender_refund_address: "0x1111111111111111111111111111111111111111",
          deposit_tx_hash: "0xdep",
          claim_expires_at: new Date("2020-01-01T00:00:00.000Z"),
        },
      ],
    });

    const rows = await PhoneEscrowAdapter.listExpiredDeposits({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amountAtomic).toBe(1_000_000n);
    expect(testState.queryMock.mock.calls[0]?.[0]).toContain("status = 'deposited'");
    expect(testState.queryMock.mock.calls[0]?.[0]).toContain("claim_expires_at < NOW()");
  });

  it("encodes refund ABI args", () => {
    const data = encodeFunctionData({
      abi: PHONE_ESCROW_ABI,
      functionName: "refund",
      args: [
        PhoneEscrowAdapter.phoneHash("+15551234567"),
        USDC.address as `0x${string}`,
        "0x1111111111111111111111111111111111111111",
        1_000_000n,
      ],
    });
    const decoded = decodeFunctionData({ abi: PHONE_ESCROW_ABI, data });
    expect(decoded.functionName).toBe("refund");
    expect(decoded.args?.[3]).toBe(1_000_000n);
  });

  it("locks and unlocks a single row for refund", async () => {
    testState.queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await expect(PhoneEscrowAdapter.claimForRefund("42")).resolves.toBe(true);
    expect(testState.queryMock).toHaveBeenLastCalledWith(
      expect.stringContaining("status = 'deposited'"),
      ["42"],
    );

    await PhoneEscrowAdapter.unclaimForRefund("42");
    expect(testState.queryMock).toHaveBeenLastCalledWith(
      expect.stringContaining("status = 'refunding'"),
      ["42"],
    );
  });
});
