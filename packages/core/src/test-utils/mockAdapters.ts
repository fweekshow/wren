/**
 * mockAdapters — pre-wired stubs for the most-mocked adapters in tests.
 *
 * Provides factory functions that return vi.fn() stubs for:
 *   - WalletAdapter (embedded wallet address lookups)
 *   - ContactsAdapter (contact resolution)
 *   - FundSessionAdapter (fund/off-ramp session creation)
 *   - OnrampUserDataAdapter (email/phone verification state)
 *
 * Usage:
 *   const wallet = createMockWalletAdapter();
 *   wallet.getConnectedWalletAddress.mockResolvedValue("0xabc...");
 */

import { vi } from "vitest";

// ── WalletAdapter ─────────────────────────────────────────────────────────────

export function createMockWalletAdapter() {
  return {
    getConnectedWalletAddress: vi.fn().mockResolvedValue(null) as ReturnType<typeof vi.fn>,
    resolveForSender: vi.fn().mockResolvedValue(null),
    upsertBaseAppAddress: vi.fn().mockResolvedValue(undefined),
  };
}

// ── ContactsAdapter ───────────────────────────────────────────────────────────

export function createMockContactsAdapter() {
  return {
    resolveWallet: vi.fn().mockResolvedValue(null) as ReturnType<typeof vi.fn>,
    saveContact: vi.fn().mockResolvedValue(undefined),
    normalizeHandle: vi.fn((s: string) => s) as ReturnType<typeof vi.fn>,
    getContact: vi.fn().mockResolvedValue(null),
  };
}

// ── FundSessionAdapter ────────────────────────────────────────────────────────

export function createMockFundSessionAdapter() {
  return {
    create: vi.fn().mockResolvedValue("mock-session-token") as ReturnType<typeof vi.fn>,
    get: vi.fn().mockResolvedValue(null),
    invalidate: vi.fn().mockResolvedValue(undefined),
  };
}

// ── OnrampUserDataAdapter ─────────────────────────────────────────────────────

export function createMockOnrampUserDataAdapter() {
  return {
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
    needsPhoneReverification: vi.fn().mockReturnValue(false) as ReturnType<typeof vi.fn>,
  };
}

// ── PhoneEscrowAdapter ────────────────────────────────────────────────────────

export function createMockPhoneEscrowAdapter() {
  return {
    buildDepositDraft: vi.fn().mockReturnValue({
      phone: "+15551234567",
      phoneHash: "0xhash",
      amountAtomic: BigInt(10_000_000),
      amount: "10",
      calls: [
        { to: "0xusdc", value: "0x0", data: "0xapprove" },
        { to: "0xescrow", value: "0x0", data: "0xdeposit" },
      ],
    }),
    releaseUsdcToBaseAccount: vi.fn().mockResolvedValue(null),
    hasPendingEscrow: vi.fn().mockResolvedValue(false),
  };
}

// ── RespondCtx builder ────────────────────────────────────────────────────────

export function makeRespondCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const custodialWallet = overrides.custodialWallet ?? false;
  return {
    inboxId: "+15550001111",
    walletAddress: custodialWallet ? "0xCustodialAddr0000000000000000000000000001" : null,
    custodialAccountName: custodialWallet ? "user-wallet" : undefined,
    linkedWallets: [],
    custodialWallet: false,
    conversationId: "conv-test-001",
    userMessage: "test",
    disableDeterministicRouting: true,
    copyPlatform: "imessage",
    copyUserKey: "+15550001111",
    positionsChannel: "imessage",
    ...overrides,
  };
}
