/**
 * wallet.handlers.test.ts — Unit tests for payment tool handlers.
 *
 * Covers:
 *   send_token:
 *     - ETH transfer builds correct value hex
 *     - ERC-20 builds correct transfer() calldata
 *     - isUsd: true converts via price oracle
 *     - Unknown asset → error text
 *     - Bare @handle recipient → rejected (must be full basename/0x)
 *     - Unresolved ENS → error text
 *
 *   fund_wallet:
 *     - Builds Coinbase session token URL with correct params
 *     - CDP disabled → fallback message
 *
 *   offramp_to_fiat:
 *     - USDC balance 0 → error text
 *     - Balance check passes → URL built
 *     - Amount > balance → error text
 *
 *   withdraw_funds (new preview flow):
 *     - Returns withdraw_preview control (not immediate execution)
 *     - Missing 'to' address → validation error text
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeRespondCtx } from "@/test-utils/mockAdapters.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/discovery/services/tokenResolve.service.js", () => ({
  resolveTokenAsync: vi.fn(),
}));

vi.mock("@/discovery/services/sendRecipient.service.js", () => ({
  resolveSendRecipient: vi.fn(),
}));

vi.mock("@/messaging/resolveSendTarget.js", () => ({
  resolveSendTarget: vi.fn().mockResolvedValue({ kind: "unknown", display: "" }),
}));

vi.mock("@/discovery/services/basename.util.js", () => ({
  resolveBasename: vi.fn(),
  resolveEnsNameForward: vi.fn(),
}));

vi.mock("@/discovery/ai/amounts.js", () => ({
  assertSwapUsdWithinLimit: vi.fn().mockReturnValue(null),
  usdToTokenAmount: vi.fn().mockResolvedValue({ amount: "0.003" }),
  resolveUsdQuotedSwapAmount: vi.fn(({ modelAmount, isUsd }) => ({ amount: modelAmount, isUsd })),
}));

vi.mock("@/wallet/onramp.js", () => ({
  buildOnrampUrl: vi.fn().mockResolvedValue("https://pay.coinbase.com/?sessionToken=mock"),
  buildOfframpUrl: vi.fn().mockResolvedValue("https://pay.coinbase.com/sell?sessionToken=mock"),
  createSessionToken: vi.fn().mockResolvedValue("mock-session-token"),
}));

vi.mock("@/wallet/fundSession.js", () => ({
  FundSessionAdapter: {
    create: vi.fn().mockResolvedValue("mock-fund-session-token"),
  },
}));

vi.mock("@/wallet/cdp.js", () => ({
  getBalances: vi.fn().mockResolvedValue([
    { symbol: "USDC", formatted: "100.00", contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
    { symbol: "ETH", formatted: "0.05" },
  ]),
  getUsdcBalance: vi.fn().mockResolvedValue("100.0"),
  withdraw: vi.fn().mockResolvedValue({ transactionHash: "0xabc123" }),
  isCdpEnabled: vi.fn().mockReturnValue(true),
  BASE_USDC_ADDRESS: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
}));

vi.mock("@/config/config.js", () => ({
  config: {
    cdp: {
      enabled: true,
      onrampSandbox: false,
      fundPageUrl: "https://basemate.app/pay",
      onrampRedirectUrl: "https://basemate.app/onramp-complete",
      fundPageDomain: "basemate.app",
    },
  },
}));

vi.mock("@/discovery/ai/toolbox.js", () => ({
  trimAmount: (v: string) => v,
  shortenAddress: (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`,
  custodialWalletOrError: vi.fn().mockReturnValue({
    ok: true,
    address: "0xcustodial",
    accountName: "user-wallet",
  }),
}));

// Block transitive DB connections pulled in via account-linking / discovery adapters
vi.mock("@/discovery/db.js", () => ({ db: {} }));
vi.mock("@/db/client.js", () => ({ db: {} }));
vi.mock("@/account-linking/adapter.js", () => ({
  AccountLinkingAdapter: { findByPhone: vi.fn(), findByAddress: vi.fn() },
}));

// ── Lazy imports ──────────────────────────────────────────────────────────────

async function getHandlers() {
  const [{ send_token, resolve_name }, { fund_wallet }, { offramp_to_fiat }, { withdraw_funds }] =
    await Promise.all([
      import("@/discovery/ai/tools/wallet.handlers.js"),
      import("@/discovery/ai/tools/wallet.handlers.js"),
      import("@/discovery/ai/tools/wallet.handlers.js"),
      import("@/discovery/ai/tools/wallet.handlers.js"),
    ]);
  return { send_token, resolve_name, fund_wallet, offramp_to_fiat, withdraw_funds };
}

// ── send_token ────────────────────────────────────────────────────────────────

describe("send_token", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // clearAllMocks wipes call history but keeps implementations, so reset the
    // shared resolver mock to its default (unknown) between tests.
    const { resolveSendTarget } = await import("@/messaging/resolveSendTarget.js");
    vi.mocked(resolveSendTarget).mockResolvedValue({ kind: "unknown", display: "" });
  });

  it("builds ETH value-transfer call for ETH asset", async () => {
    const { send_token } = await getHandlers();
    const { resolveTokenAsync } = await import("@/discovery/services/tokenResolve.service.js");
    const { resolveSendTarget } = await import("@/messaging/resolveSendTarget.js");
    vi.mocked(resolveTokenAsync).mockResolvedValue({
      resolved: true,
      address: "ETH",
      symbol: "ETH",
      decimals: 18,
    } as Awaited<ReturnType<typeof resolveTokenAsync>>);
    vi.mocked(resolveSendTarget).mockResolvedValue({
      kind: "wallet",
      address: "0x1234567890123456789012345678901234567890",
      display: "alice.base.eth",
    });

    const result = await send_token(makeRespondCtx() as any, {
      to: "alice.base.eth",
      asset: "ETH",
      amount: "0.1",
    });

    expect(result.control?.type).toBe("transaction");
    const tx = result.control as { type: string; calls: Array<{ value: string; data: string }> };
    expect(tx.calls[0].value).not.toBe("0x0");
    expect(tx.calls[0].data).toBe("0x");
  });

  it("builds ERC-20 transfer() calldata for USDC", async () => {
    const { send_token } = await getHandlers();
    const { resolveTokenAsync } = await import("@/discovery/services/tokenResolve.service.js");
    const { resolveSendTarget } = await import("@/messaging/resolveSendTarget.js");
    vi.mocked(resolveTokenAsync).mockResolvedValue({
      resolved: true,
      address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      symbol: "USDC",
      decimals: 6,
    } as Awaited<ReturnType<typeof resolveTokenAsync>>);
    vi.mocked(resolveSendTarget).mockResolvedValue({
      kind: "wallet",
      address: "0x1234567890123456789012345678901234567890",
      display: "bob.base.eth",
    });

    const result = await send_token(makeRespondCtx() as any, {
      to: "bob.base.eth",
      asset: "USDC",
      amount: "10",
    });

    expect(result.control?.type).toBe("transaction");
    const tx = result.control as { calls: Array<{ to: string; value: string; data: string }> };
    // Call should target the USDC contract address
    expect(tx.calls[0].to.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(tx.calls[0].value).toBe("0x0");
    // Data should be a transfer() call (starts with 0xa9059cbb)
    expect(tx.calls[0].data).toMatch(/^0xa9059cbb/);
  });

  it("returns error text for an unknown asset", async () => {
    const { send_token } = await getHandlers();
    const { resolveTokenAsync } = await import("@/discovery/services/tokenResolve.service.js");
    vi.mocked(resolveTokenAsync).mockResolvedValue({
      resolved: false,
      address: null,
      symbol: "UNKNWN",
      decimals: 18,
    } as Awaited<ReturnType<typeof resolveTokenAsync>>);

    const result = await send_token(makeRespondCtx() as any, {
      to: "0x1234567890123456789012345678901234567890",
      asset: "UNKNWN",
      amount: "10",
    });

    expect(result.control?.type).toBe("text");
    expect((result.control as { text: string }).text).toContain("UNKNWN");
  });

  // Recipient notification metadata — the tool receives `to` (a contact name,
  // extracted by the LLM from any phrasing) and must attach contactTransfer so
  // the recipient is texted once the transfer confirms.
  describe("recipient notification metadata", () => {
    async function sendToContact(to: string, opts?: { phone?: string | null }) {
      const { send_token } = await getHandlers();
      const { resolveTokenAsync } = await import(
        "@/discovery/services/tokenResolve.service.js"
      );
      const { resolveSendTarget } = await import("@/messaging/resolveSendTarget.js");
      vi.mocked(resolveTokenAsync).mockResolvedValue({
        resolved: true,
        address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        symbol: "USDC",
        decimals: 6,
      } as Awaited<ReturnType<typeof resolveTokenAsync>>);
      const phone = opts && "phone" in opts ? opts.phone : "+919330266945";
      vi.mocked(resolveSendTarget).mockResolvedValue({
        kind: "wallet",
        address: "0x1234567890123456789012345678901234567890",
        phone,
        name: to,
        display: phone ? `${to} (${phone})` : to,
      });
      return send_token(makeRespondCtx() as any, { to, asset: "USDC", amount: ".01" });
    }

    // People phrase the same send a million ways; the LLM lands them all on a
    // bare contact name in `to`. Each must attach the recipient's phone.
    it.each([
      "Degeneer",
      "degeneer",
      "mom",
      "jesse",
      "Uncle Bob",
      "my guy chris",
    ])("attaches contactTransfer for contact name %j", async (name) => {
      const result = await sendToContact(name);
      const tx = result.control as {
        type: string;
        contactTransfer?: { recipientPhone: string; amount: string; asset: string };
      };
      expect(tx.type).toBe("transaction");
      expect(tx.contactTransfer).toEqual({
        recipientPhone: "+919330266945",
        amount: ".01",
        asset: "USDC",
      });
      expect((result.control as { text?: string }).text).toContain("+919330266945");
      expect((result.control as { text?: string }).text).not.toMatch(/0x[a-fA-F0-9]{40}/);
    });

    it("shows name + phone even when `to` is already a 0x address for a saved contact", async () => {
      const { send_token } = await getHandlers();
      const { resolveTokenAsync } = await import(
        "@/discovery/services/tokenResolve.service.js"
      );
      const { resolveSendTarget } = await import("@/messaging/resolveSendTarget.js");
      const addr = "0x1234567890123456789012345678901234567890";
      vi.mocked(resolveTokenAsync).mockResolvedValue({
        resolved: true,
        address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        symbol: "USDC",
        decimals: 6,
      } as Awaited<ReturnType<typeof resolveTokenAsync>>);
      vi.mocked(resolveSendTarget).mockResolvedValue({
        kind: "wallet",
        address: addr.toLowerCase(),
        phone: "+916289874218",
        name: "Aritra",
        display: "Aritra (+916289874218)",
      });
      const result = await send_token(makeRespondCtx() as any, {
        to: addr,
        asset: "USDC",
        amount: "0.01",
      });
      const tx = result.control as {
        type: string;
        text?: string;
        contactTransfer?: { recipientPhone: string };
      };
      expect(tx.type).toBe("transaction");
      expect(tx.text).toContain("Aritra (+916289874218)");
      expect(tx.text).not.toMatch(/0x1234/i);
      expect(tx.contactTransfer?.recipientPhone).toBe("+916289874218");
    });

    it("normalizes word amounts and attaches memo on contactTransfer", async () => {
      const { send_token } = await getHandlers();
      const { resolveTokenAsync } = await import(
        "@/discovery/services/tokenResolve.service.js"
      );
      const { resolveSendTarget } = await import("@/messaging/resolveSendTarget.js");
      vi.mocked(resolveTokenAsync).mockResolvedValue({
        resolved: true,
        address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        symbol: "USDC",
        decimals: 6,
      } as Awaited<ReturnType<typeof resolveTokenAsync>>);
      vi.mocked(resolveSendTarget).mockResolvedValue({
        kind: "wallet",
        address: "0x1234567890123456789012345678901234567890",
        phone: "+919330266945",
        name: "Degeneer",
        display: "Degeneer (+919330266945)",
      });
      const result = await send_token(makeRespondCtx() as any, {
        to: "Degeneer",
        asset: "USDC",
        amount: "a penny",
        memo: "lunch",
      });
      const tx = result.control as {
        type: string;
        text?: string;
        contactTransfer?: {
          recipientPhone: string;
          amount: string;
          asset: string;
          memo?: string;
        };
      };
      expect(tx.type).toBe("transaction");
      expect(tx.text).toContain("0.01");
      expect(tx.text).toContain("lunch");
      expect(tx.text).toContain("+919330266945");
      expect(tx.contactTransfer).toEqual({
        recipientPhone: "+919330266945",
        amount: "0.01",
        asset: "USDC",
        memo: "lunch",
      });
    });

    it("explains phone-only contacts instead of saying they are unknown", async () => {
      const { send_token } = await getHandlers();
      const { resolveTokenAsync } = await import(
        "@/discovery/services/tokenResolve.service.js"
      );
      const { resolveSendTarget } = await import("@/messaging/resolveSendTarget.js");
      vi.mocked(resolveTokenAsync).mockResolvedValue({
        resolved: true,
        address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        symbol: "USDC",
        decimals: 6,
      } as Awaited<ReturnType<typeof resolveTokenAsync>>);
      vi.mocked(resolveSendTarget).mockResolvedValue({
        kind: "claim_phone",
        phone: "+919330266945",
        name: "Degeneer",
        display: "Degeneer (+919330266945)",
        isOnBasemate: false,
      });
      const result = await send_token(makeRespondCtx() as any, {
        to: "degeneer",
        asset: "USDC",
        amount: ".1",
      });
      const tx = result.control as { type: string; text?: string };
      expect(tx.type).toBe("text");
      expect(tx.text).toContain("hasn't linked a wallet");
      expect(tx.text).toContain("+919330266945");
      expect(tx.text).toMatch(/claim/i);
      expect(tx.text).not.toMatch(/\bescrow\b/i);
      expect(tx.text).not.toContain("don't have a wallet or saved contact");
    });

    it("does NOT attach contactTransfer when sending to a 0x address with no saved contact", async () => {
      const { send_token } = await getHandlers();
      const { resolveTokenAsync } = await import(
        "@/discovery/services/tokenResolve.service.js"
      );
      const { resolveSendTarget } = await import("@/messaging/resolveSendTarget.js");
      vi.mocked(resolveTokenAsync).mockResolvedValue({
        resolved: true,
        address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        symbol: "USDC",
        decimals: 6,
      } as Awaited<ReturnType<typeof resolveTokenAsync>>);
      vi.mocked(resolveSendTarget).mockResolvedValue({
        kind: "wallet",
        address: "0x1234567890123456789012345678901234567890",
        display: "0x1234…7890",
      });

      const result = await send_token(makeRespondCtx() as any, {
        to: "0x1234567890123456789012345678901234567890",
        asset: "USDC",
        amount: "10",
      });
      const tx = result.control as { type: string; contactTransfer?: unknown };
      expect(tx.type).toBe("transaction");
      expect(tx.contactTransfer).toBeUndefined();
    });

    it("does NOT attach contactTransfer when the contact has no phone", async () => {
      const result = await sendToContact("phoneless", { phone: null });
      const tx = result.control as { type: string; contactTransfer?: unknown };
      expect(tx.type).toBe("transaction");
      expect(tx.contactTransfer).toBeUndefined();
    });
  });

  it("returns error text when recipient cannot be resolved", async () => {
    const { send_token } = await getHandlers();
    const { resolveTokenAsync } = await import("@/discovery/services/tokenResolve.service.js");
    const { resolveSendTarget } = await import("@/messaging/resolveSendTarget.js");
    vi.mocked(resolveTokenAsync).mockResolvedValue({
      resolved: true,
      address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      symbol: "USDC",
      decimals: 6,
    } as Awaited<ReturnType<typeof resolveTokenAsync>>);
    vi.mocked(resolveSendTarget).mockResolvedValue({
      kind: "unknown",
      display: "@unresolvable",
    });

    const result = await send_token(makeRespondCtx() as any, {
      to: "@unresolvable",
      asset: "USDC",
      amount: "10",
    });

    expect(result.control?.type).toBe("text");
    expect((result.control as { text: string }).text).toMatch(
      /don't have a wallet or saved contact|0x address|basename/i,
    );
  });
});

// ── offramp_to_fiat ───────────────────────────────────────────────────────────

describe("offramp_to_fiat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when USDC balance is zero", async () => {
    const { offramp_to_fiat } = await getHandlers();
    const { getUsdcBalance } = await import("@/wallet/cdp.js");
    vi.mocked(getUsdcBalance).mockResolvedValue("0");

    const result = await offramp_to_fiat(makeRespondCtx({ custodialWallet: true }) as any, {});

    expect(result.control?.type).toBe("text");
    expect((result.control as { text: string }).text).toMatch(/don't have|no USDC/i);
  });

  it("returns error when requested amount exceeds balance", async () => {
    const { offramp_to_fiat } = await getHandlers();
    const { getUsdcBalance } = await import("@/wallet/cdp.js");
    vi.mocked(getUsdcBalance).mockResolvedValue("50");

    const result = await offramp_to_fiat(
      makeRespondCtx({ custodialWallet: true }) as any,
      { amount: "100" },
    );

    expect(result.control?.type).toBe("text");
    expect((result.control as { text: string }).text).toMatch(/only have|can't cash out/i);
  });

  it("returns offramp_link on happy path", async () => {
    const { offramp_to_fiat } = await getHandlers();
    const { getUsdcBalance } = await import("@/wallet/cdp.js");
    vi.mocked(getUsdcBalance).mockResolvedValue("100.0");

    const result = await offramp_to_fiat(
      makeRespondCtx({ custodialWallet: true }) as any,
      {},
    );

    expect(result.control?.type).toBe("offramp_link");
    expect((result.control as { url: string }).url).toContain("/pay?s=");
  });
});

// ── withdraw_funds (new preview flow) ─────────────────────────────────────────

describe("withdraw_funds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns withdraw_preview control (not immediate execution)", async () => {
    const { withdraw_funds } = await getHandlers();

    const result = await withdraw_funds(
      makeRespondCtx({ custodialWallet: true }) as any,
      { to: "0x1234567890123456789012345678901234567890", amount: "10", asset: "USDC" },
    );

    expect(result.control?.type).toBe("withdraw_preview");
    const preview = result.control as { type: string; to: string; amount: string; label: string };
    expect(preview.to).toBe("0x1234567890123456789012345678901234567890");
    expect(preview.amount).toBe("10");
    expect(preview.label).toBeTruthy();

    // The actual cdpWithdraw should NOT have been called
    const { withdraw } = await import("@/wallet/cdp.js");
    expect(vi.mocked(withdraw)).not.toHaveBeenCalled();
  });

  it("returns validation error for invalid 0x address", async () => {
    const { withdraw_funds } = await getHandlers();

    const result = await withdraw_funds(
      makeRespondCtx({ custodialWallet: true }) as any,
      { to: "not-an-address", amount: "10" },
    );

    expect(result.control?.type).toBe("text");
    expect((result.control as { text: string }).text).toMatch(/valid|address/i);
  });

  it("returns validation error for invalid amount", async () => {
    const { withdraw_funds } = await getHandlers();

    const result = await withdraw_funds(
      makeRespondCtx({ custodialWallet: true }) as any,
      { to: "0x1234567890123456789012345678901234567890", amount: "0" },
    );

    expect(result.control?.type).toBe("text");
  });
});

// ── resolve_name ──────────────────────────────────────────────────────────────

describe("resolve_name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forward-resolves a basename to an address", async () => {
    const { resolve_name } = await getHandlers();
    const { resolveEnsNameForward } = await import("@/discovery/services/basename.util.js");
    vi.mocked(resolveEnsNameForward).mockResolvedValue(
      "0x2e6bce51adcf88e58fe8276a210508d6c4085121",
    );

    const result = await resolve_name(makeRespondCtx() as any, {
      name: "degeneer03.base.eth",
    });

    expect(result.data).toEqual({
      name: "degeneer03.base.eth",
      address: "0x2e6bce51adcf88e58fe8276a210508d6c4085121",
    });
    expect(result.control?.type).toBe("text");
    expect((result.control as { text: string }).text).toMatch(/degeneer03\.base\.eth/);
  });

  it("reverse-resolves an address to a basename", async () => {
    const { resolve_name } = await getHandlers();
    const { resolveBasename } = await import("@/discovery/services/basename.util.js");
    vi.mocked(resolveBasename).mockResolvedValue("degeneer03.base.eth");

    const result = await resolve_name(makeRespondCtx() as any, {
      name: "0x2E6bcE51aDCF88E58fe8276a210508D6c4085121",
    });

    expect(result.data).toEqual({
      address: "0x2e6bce51adcf88e58fe8276a210508d6c4085121",
      name: "degeneer03.base.eth",
    });
  });

  it("rejects bare handles", async () => {
    const { resolve_name } = await getHandlers();

    const result = await resolve_name(makeRespondCtx() as any, { name: "degeneer03" });

    expect(result.control?.type).toBe("text");
    expect((result.control as { text: string }).text).toMatch(/full basename/i);
  });

  it("returns error when basename cannot be resolved", async () => {
    const { resolve_name } = await getHandlers();
    const { resolveEnsNameForward } = await import("@/discovery/services/basename.util.js");
    vi.mocked(resolveEnsNameForward).mockResolvedValue(null);

    const result = await resolve_name(makeRespondCtx() as any, {
      name: "nobody-here.base.eth",
    });

    expect(result.control?.type).toBe("text");
    expect((result.control as { text: string }).text).toMatch(/couldn't resolve/i);
  });
});
