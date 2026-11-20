import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImessageOutbound } from "@/imessage/outbound.js";

const createOfframpDraftMock = vi.hoisted(() => vi.fn());

vi.mock("@/config/config.js", () => ({
  config: {
    cdp: {
      enabled: true,
      fundPageUrl: "https://app.basemate.app/pay",
      fundPageDomain: "app.basemate.app",
      onrampSandbox: false,
      onrampClientIpFallback: "",
    },
    phoneEscrow: {
      enabled: true,
      releaseEnabled: true,
      refundEnabled: true,
      claimTtlHours: 72,
      contractAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      phoneHashSalt: "test-salt",
      operatorPrivateKey: "0xabc",
    },
    payPage: { origin: "https://app.basemate.app" },
    mentionHandle: "basemate",
  },
}));

vi.mock("@/wallet/pendingPay.js", () => ({
  PendingPayAdapter: {
    create: vi.fn(async () => ({ token: "pending-token", row: {} })),
  },
}));

const onrampTestState = vi.hoisted(() => {
  type Row = {
    userPhone: string;
    email: string | null;
    tosAcceptedAt: Date | null;
    phoneVerifiedAt: Date | null;
    emailVerifiedAt: Date | null;
    pendingPhoneOtp: string | null;
    pendingPhoneOtpExpiresAt: Date | null;
    pendingEmailOtp: string | null;
    pendingEmailOtpExpiresAt: Date | null;
  };
  const rows = new Map<string, Row>();
  const baseRow = (userPhone: string): Row => ({
    userPhone,
    email: null,
    tosAcceptedAt: null,
    phoneVerifiedAt: null,
    emailVerifiedAt: null,
    pendingPhoneOtp: null,
    pendingPhoneOtpExpiresAt: null,
    pendingEmailOtp: null,
    pendingEmailOtpExpiresAt: null,
  });
  const upsert = async (userPhone: string, updates: Partial<Omit<Row, "userPhone">>) => {
    rows.set(userPhone, { ...(rows.get(userPhone) ?? baseRow(userPhone)), ...updates });
  };
  const issueEmailOtp = vi.fn(async (userPhone: string, email: string) => {
    await upsert(userPhone, {
      email,
      tosAcceptedAt: new Date("2026-01-01T00:00:00.000Z"),
      pendingEmailOtp: "123456",
      pendingEmailOtpExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
  });
  const verifyEmailOtp = vi.fn(async (userPhone: string, code: string) => {
    const row = rows.get(userPhone);
    if (!row?.email || !row.pendingEmailOtp || !row.pendingEmailOtpExpiresAt) {
      return { ok: false, reason: "missing" as const };
    }
    if (row.pendingEmailOtpExpiresAt.getTime() <= Date.now()) {
      await upsert(userPhone, { pendingEmailOtp: null, pendingEmailOtpExpiresAt: null });
      return { ok: false, reason: "expired" as const };
    }
    if (code !== row.pendingEmailOtp) return { ok: false, reason: "mismatch" as const };
    await upsert(userPhone, {
      emailVerifiedAt: new Date("2026-01-01T00:01:00.000Z"),
      pendingEmailOtp: null,
      pendingEmailOtpExpiresAt: null,
    });
    return { ok: true, email: row.email };
  });
  const resendEmailOtp = vi.fn(async (userPhone: string) => {
    const row = rows.get(userPhone);
    if (!row?.email) return { ok: false, reason: "missing_email" as const };
    if (row.emailVerifiedAt) return { ok: false, reason: "already_verified" as const };
    await issueEmailOtp(userPhone, row.email);
    return { ok: true, email: row.email };
  });
  return { rows, upsert, issueEmailOtp, verifyEmailOtp, resendEmailOtp };
});

vi.mock("@/wallet/onrampUserData.js", () => ({
  OnrampUserDataAdapter: {
    __rows: onrampTestState.rows,
    async get(userPhone: string) {
      return onrampTestState.rows.get(userPhone) ?? null;
    },
    upsert: onrampTestState.upsert,
    needsPhoneReverification(data: { phoneVerifiedAt: Date | null } | null) {
      if (!data?.phoneVerifiedAt) return true;
      return Date.now() - data.phoneVerifiedAt.getTime() >= 60 * 24 * 60 * 60 * 1000;
    },
  },
}));

vi.mock("@/wallet/emailOtp.js", () => ({
  generateOtp: vi.fn(() => "123456"),
  issueEmailOtp: onrampTestState.issueEmailOtp,
  verifyEmailOtp: onrampTestState.verifyEmailOtp,
  resendEmailOtp: onrampTestState.resendEmailOtp,
}));

vi.mock("@/wallet/walletSetupSession.js", () => ({
  WalletSetupSessionAdapter: {
    create: vi.fn(async () => "setup-token"),
  },
}));

vi.mock("@/wallet/fundSession.js", () => ({
  FundSessionAdapter: {
    create: vi.fn(async () => "fund-session-token"),
    createIntent: vi.fn(async () => "fund-session-token"),
  },
}));

const mockCreateFundSessionIntent = vi.hoisted(() =>
  vi.fn(async () => "fund-session-token"),
);

vi.mock("@/wallet/fundSessionCheckout.js", () => ({
  createFundSessionIntent: mockCreateFundSessionIntent,
  ONRAMP_MIN_USD: 2,
}));

vi.mock("@/wallet/onramp.js", () => ({
  createHeadlessOnrampOrder: vi.fn(async () => ({
    paymentLink: { url: "https://pay.coinbase.com/guest/apple/mock" },
  })),
  buildHeadlessFundLinks: vi.fn(async () => ({
    paymentLinkOptions: [
      {
        method: "apple_pay",
        label: "Apple Pay",
        url: "https://pay.coinbase.com/guest/apple/mock",
      },
    ],
  })),
  buildHostedFallbackUrl: vi.fn(async () => "https://pay.coinbase.com/buy/select-asset?sessionToken=mock"),
  isCoinbaseRegionForbiddenError: vi.fn(() => false),
  ONRAMP_MIN_USD: 2,
  buildOfframpUrl: vi.fn(async (params: { presetCryptoAmount?: string }) => {
    const q = new URLSearchParams({
      sessionToken: "offramp-token",
      partnerUserRef: "im-sender1",
      redirectUrl: "https://app.basemate.app/onramp-complete",
      defaultAsset: "USDC",
      defaultNetwork: "base",
    });
    if (params.presetCryptoAmount) q.set("presetCryptoAmount", params.presetCryptoAmount);
    return `https://pay.coinbase.com/v3/sell/input?${q.toString()}`;
  }),
}));

vi.mock("@/wallet/offramp.js", () => ({
  OfframpValidationError: class OfframpValidationError extends Error {},
  createOfframpDraft: createOfframpDraftMock,
}));

vi.mock("./bot.js", () => ({
  renderAIResponseText: (resp: {
    type: string;
    text?: string;
    description?: string;
    url?: string;
    address?: string;
    groups?: Array<{ name: string }>;
    options?: Array<{ label: string }>;
    presetsUsd?: number[];
  }) => {
    if (resp.type === "menu") {
      return [`${resp.description ? `${resp.description}\n\n` : ""}here's what i can help with:`];
    }
    if (resp.type === "disambiguate") {
      const options = (resp.options ?? []).map((opt, i) => `${i + 1}. ${opt.label}`).join("\n");
      return [`${resp.text ?? ""}${options ? `\n\n${options}` : ""}`];
    }
    if (resp.type === "amount_select") {
      const presets = (resp.presetsUsd ?? []).map((usd, i) => `#${i + 1}. $${usd}`).join("\n");
      return [`${resp.text ?? ""}${presets ? `\n\n${presets}` : ""}`];
    }
    if (resp.type === "onramp_link") return [resp.text ?? "", resp.address, resp.url].filter(Boolean);
    return [resp.text ?? resp.description ?? ""];
  },
}));

vi.mock("@/discovery/adapters/wallet.adapter.js", () => {
  const embeddedAddresses = new Map<string, string>();
  const noServerWallets = new Set<string>();
  const displayNames = new Map<string, string>();
  const missingDisplayNames = new Set<string>();
  const hasEmbedded = new Set<string>();
  const missingEmbedded = new Set<string>();
  const embeddedPayModes = new Map<string, "manual" | "quick">();
  const embeddedAddr = "0xE11bed0000000000000000000000000000000000";
  return {
    WalletAdapter: {
      __embeddedAddresses: embeddedAddresses,
      __noServerWallets: noServerWallets,
      __displayNames: displayNames,
      __missingDisplayNames: missingDisplayNames,
      __hasEmbedded: hasEmbedded,
      __missingEmbedded: missingEmbedded,
      __embeddedPayModes: embeddedPayModes,
      async getEmbeddedWallet(senderId: string) {
        if (missingEmbedded.has(senderId)) return null;
        return {
          cdpUserId: `cdp-${senderId}`,
          address: embeddedAddresses.get(senderId) ?? embeddedAddr,
          delegationId: "deleg-1",
          delegationExpiresAt: null,
        };
      },
      async getEmbeddedPayMode(senderId: string) {
        return embeddedPayModes.get(senderId) ?? "manual";
      },
      async setEmbeddedPayMode(senderId: string, mode: "manual" | "quick") {
        embeddedPayModes.set(senderId, mode);
      },
      async getAutoSendLimit() {
        return null;
      },
      async setAutoSendLimit() {},
      async getReceiveAddress(senderId: string) {
        if (missingEmbedded.has(senderId)) return null;
        return embeddedAddresses.get(senderId) ?? embeddedAddr;
      },
      async findByEmbeddedAddress() {
        return null;
      },
      async findByCdpUserId() {
        return null;
      },
      async ensureProfile() {},
      async findBySenderId(senderId: string) {
        if (noServerWallets.has(senderId)) return null;
        return {
          address: "0x2222222222222222222222222222222222222222",
          accountName: `acct-${senderId}`,
        };
      },
      async getOrCreate(senderId: string) {
        const isNew = noServerWallets.delete(senderId) || senderId === "new-sender";
        return {
          address: "0x2222222222222222222222222222222222222222",
          accountName: `acct-${senderId}`,
          isNew,
        };
      },
      async getDisplayName(senderId: string) {
        return missingDisplayNames.has(senderId)
          ? null
          : (displayNames.get(senderId) ?? "Test User");
      },
      async setDisplayName(senderId: string, name: string) {
        displayNames.set(senderId, name);
        missingDisplayNames.delete(senderId);
      },
      async resolveSenderKey(senderId: string) {
        return senderId;
      },
      async getIdentity(senderId: string) {
        const receive = missingEmbedded.has(senderId)
          ? null
          : (embeddedAddresses.get(senderId) ?? embeddedAddr);
        if (!receive && !displayNames.has(senderId) && !missingDisplayNames.has(senderId)) {
          return null;
        }
        return {
          receiveAddress: receive,
          basename: null,
          displayName: displayNames.get(senderId) ?? null,
        };
      },
    },
    DEFAULT_AUTO_SEND_LIMIT_USD: 100,
  };
});

vi.mock("@/price-alerts/index.js", () => {
  const pendingAlerts = Object.assign(new Map<string, unknown>(), {
    async getAsync(key: string) {
      return pendingAlerts.get(key) ?? null;
    },
    async hasAsync(key: string) {
      return pendingAlerts.has(key);
    },
  });
  const createAlertFromIntent = vi.fn(async (input: {
    dmTarget: { spaceId: string } | null;
    sourceConversationId: string;
    sourceIsGroup: boolean;
  }) => ({
    kind: "created",
    alertId: 42,
    reply: input.sourceIsGroup
      ? "created group-sourced alert; I'll send the alert to your DM, not this group."
      : "created dm alert.",
  }));

  return {
    pendingAlerts,
    pendingAlertKey: (platform: string, userKey: string, conversationId: string) =>
      `${platform}:${userKey}:${conversationId}`,
    extractContractAddress: (text: string) =>
      text.match(/0x[a-fA-F0-9]{40}/)?.[0] ?? null,
    parseAlertIntents: vi.fn(() => [{
      tokenQuery: "ETH",
      contractAddress: null,
      metric: "price_usd",
      targetValue: 4000,
      direction: null,
    }]),
    createAlertFromIntent,
  };
});

vi.mock("@/portfolio-reviews/index.js", () => ({
  fetchErc20TokenBalance: vi.fn(async () => 0),
  handlePortfolioReviewCommand: vi.fn(async () => ({
    handled: false,
    reply: "",
  })),
}));

vi.mock("@/discovery/adapters/portfolioReview.adapter.js", () => ({
  PortfolioReviewAdapter: {},
}));

vi.mock("@/portfolio/service.js", () => ({
  buildImessagePortfolio: vi.fn(async () => "mock portfolio"),
}));

vi.mock("@/portfolio/summary.js", () => ({
  formatCoinsSummaryForImessage: vi.fn(() => "mock coins summary"),
}));

vi.mock("@/copy-trading/portfolio/balances.js", () => ({
  fetchTraderHoldings: vi.fn(async (walletAddress: string) => {
    const { getBalances } = await import("@/wallet/cdp.js");
    const balances = await getBalances(walletAddress);
    return balances.map((balance) => {
      const amount = Number(balance.formatted);
      const priceUsd = balance.symbol === "ETH" ? 3_000 : 1;
      return {
        symbol: balance.symbol,
        name: balance.symbol,
        tokenAddress: balance.contractAddress,
        amount: balance.formatted,
        decimals: balance.decimals,
        priceUsd,
        valueUsd: amount * priceUsd,
        change24hPct: null,
        risk: "low",
      };
    });
  }),
}));

vi.mock("@/account-linking/index.js", () => ({
  handleAccountLinkCommand: vi.fn(async () => ({
    handled: false,
    reply: "",
  })),
  resolveAllWalletsForUser: vi.fn(async () => []),
}));


vi.mock("@/wallet/phoneEscrow.js", () => ({
  PhoneEscrowAdapter: {
    buildDepositDraft: vi.fn((
      phone: string,
      amount: string,
      token: { address: string; symbol: string; decimals: number },
    ) => ({
      phone,
      phoneHash: "0xphonehash",
      tokenAddress: token.address,
      tokenSymbol: token.symbol,
      tokenDecimals: token.decimals,
      amountAtomic: BigInt(Math.round(Number(amount) * 10 ** token.decimals)),
      amount,
      calls: [
        { to: "0x1111111111111111111111111111111111111111", data: "0xapprove", value: "0x0" },
        { to: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", data: "0xdeposit", value: "0x0" },
      ],
    })),
    recordDepositIntent: vi.fn(async () => undefined),
    listUnreleasedPositions: vi.fn(async () => []),
    claimForRelease: vi.fn(async () => true),
    unclaimForRelease: vi.fn(async () => undefined),
    releaseToWalletAddress: vi.fn(async () => null),
  },
}));

vi.mock("@/discovery/services/sendRecipient.service.js", () => ({
  resolveSendRecipient: vi.fn(async (to: string) => {
    const trimmed = to.trim();
    if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
      return { address: trimmed.toLowerCase(), display: trimmed };
    }
    return { error: `couldn't resolve "${trimmed}" to a wallet address.` };
  }),
}));

vi.mock("@/discovery/adapters/perpProfile.adapter.js", () => {
  type PerpRiskTier = "steady" | "tactical" | "aggressive" | "basemaxxing";
  type PerpProfile = {
    inbox_id: string;
    risk_tier: PerpRiskTier;
    default_collateral_usdc: string;
    updated_at: Date;
  };

  const profiles = new Map<string, PerpProfile>();

  const PerpProfileAdapter = {
    __profiles: profiles,
    isComplete(profile: PerpProfile | null | undefined): profile is PerpProfile {
      return Boolean(profile?.risk_tier && Number(profile.default_collateral_usdc) > 0);
    },
    async getProfile(inboxId: string): Promise<PerpProfile | null> {
      return profiles.get(inboxId) ?? null;
    },
    async upsertProfile(
      inboxId: string,
      partial: { risk_tier?: PerpRiskTier; default_collateral_usdc?: string },
    ): Promise<PerpProfile | null> {
      const existing = profiles.get(inboxId);
      const risk_tier = partial.risk_tier ?? existing?.risk_tier;
      const default_collateral_usdc =
        partial.default_collateral_usdc ?? existing?.default_collateral_usdc;
      if (!risk_tier || !default_collateral_usdc) return null;
      const profile = {
        inbox_id: inboxId,
        risk_tier,
        default_collateral_usdc,
        updated_at: new Date(),
      };
      profiles.set(inboxId, profile);
      return profile;
    },
    async resolveTradeParams() {
      return { leverage: 7, takeProfit: "3000", stopLoss: "2400" };
    },
  };

  return { PerpProfileAdapter };
});

vi.mock("@/discovery/adapters/priceAlert.adapter.js", () => ({
  PriceAlertAdapter: {
    cancelForUser: vi.fn(async () => 0),
    listActiveForUser: vi.fn(async () => []),
  },
}));

vi.mock("@/copy-trading/adapters/copyStrategy.adapter.js", () => ({
  CopyStrategyAdapter: {
    listForUser: vi.fn(async () => []),
  },
}));

vi.mock("@/discovery/ai.js", () => ({
  DiscoveryAI: class {},
  resolveTokenAsync: vi.fn(async (asset: string) => {
    const upper = asset.toUpperCase();
    if (upper === "ETH") {
      return { address: "ETH", decimals: 18, symbol: "ETH", resolved: true };
    }
    if (upper === "UNKNOWN") {
      return { address: asset, decimals: 18, symbol: upper, resolved: false };
    }
    if (upper === "BASEMATE") {
      return {
        address: "0x07E61D8a4e197dfC269e90D7ECe1dF0D26702bA3",
        decimals: 18,
        symbol: "BASEMATE",
        resolved: true,
      };
    }
    return {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      decimals: 6,
      symbol: "USDC",
      resolved: true,
    };
  }),
  getAvantisPairMeta: vi.fn(async () => ({ listed: true, maxLeverage: 75, minPosUsd: 100 })),
  normalizeAvantisPair: (pair: string) => {
    const base = pair.trim().toUpperCase().replace(/[-/_].*$/, "");
    return `${base}-USD`;
  },
  prepareAvantisOpen: vi.fn(async (args: {
    pair: string;
    side: "long" | "short";
    leverage: number;
    collateral: string;
  }) => ({
    ok: true,
    calls: [{ to: "0x1111111111111111111111111111111111111111", data: "0x", value: "0x0" }],
    label: `Open ${args.leverage}x ${args.side} ${args.pair} with $${args.collateral} USDC`,
  })),
}));

vi.mock("@/discovery/strategy/liveTrading.js", () => ({
  isStrategyLiveTradingPaused: vi.fn(() => false),
  LIVE_TRADING_PAUSED_MESSAGE: "live trading is off.",
}));

vi.mock("@/wallet/cdp.js", () => ({
  BASE_USDC_ADDRESS: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  GasEstimationError: class GasEstimationError extends Error {},
  InsufficientGasError: class InsufficientGasError extends Error {},
  getBalances: vi.fn(),
  getUsdcBalance: vi.fn(async () => "25"),
  withdraw: vi.fn(),
  sendCalls: vi.fn(),
}));

vi.mock("@/discovery/services/avantisClose.service.js", () => ({
  AvantisCloseBuildError: class AvantisCloseBuildError extends Error {},
  buildAvantisCloseCallsForWallet: vi.fn(),
}));

vi.mock("@/discovery/strategy/wallet.js", () => ({
  resolveBasemateServerWallet: vi.fn(async () => null),
}));

vi.mock("./contacts.adapter.js", () => {
  const saved: Array<{ ownerSenderId: string; name: string; phone?: string }> = [];
  return {
    ContactsAdapter: {
      __saved: saved,
      async saveContact(ownerSenderId: string, name: string, phone?: string) {
        saved.push({ ownerSenderId, name, phone });
      },
      normalizeHandle(raw: string | null | undefined) {
        if (!raw) return null;
        const cleaned = raw.replace(/[^\d+]/g, "");
        return /^\+\d{7,15}$/.test(cleaned) ? cleaned : null;
      },
      async findByName() {
        return null;
      },
      async findByNameFuzzy(this: { findByName: (o: string, n: string) => Promise<unknown> }, ownerSenderId: string, name: string) {
        const row = await this.findByName(ownerSenderId, name);
        return row
          ? { matches: [row], ambiguous: false }
          : { matches: [], ambiguous: false };
      },
      async findByPhone() {
        return null;
      },
      async resolveWallet() {
        return null;
      },
    },
  };
});

const { PerpProfileAdapter } = await import("../discovery/adapters/perpProfile.adapter.js");
const { WalletAdapter } = await import("../discovery/adapters/wallet.adapter.js");
const { buildAvantisCloseCallsForWallet } = await import("../discovery/services/avantisClose.service.js");
const { resolveSendRecipient } = await import("../discovery/services/sendRecipient.service.js");
const { resolveBasemateServerWallet } = await import("../discovery/strategy/wallet.js");
const { createAlertFromIntent, pendingAlerts, pendingAlertKey } = await import("../price-alerts/index.js");
const { buildImessagePortfolio } = await import("../portfolio/service.js");
const { WalletSetupSessionAdapter } = await import("../wallet/walletSetupSession.js");
const { FundSessionAdapter } = await import("../wallet/fundSession.js");
const { getBalances, getUsdcBalance, sendCalls, withdraw } = await import("../wallet/cdp.js");
const { buildOfframpUrl, createHeadlessOnrampOrder } = await import("../wallet/onramp.js");
const { PhoneEscrowAdapter } = await import("../wallet/phoneEscrow.js");
const { ContactsAdapter } = await import("./contacts.adapter.js");
const { UserProfileAdapter } = await import("./adapters/userProfile.adapter.js");
const { createImessageHandler } = await import("./handler.js");
const { isImessageMentioned, removeImessageMention } = await import("../imessage/groupEngagement.js");
const { formatOutboundForRepl } = await import("@/imessage/outbound.js");
const { __clearConversationStateForTests } = await import("../state/conversationState.store.js");

const profileStore = (PerpProfileAdapter as unknown as {
  __profiles: Map<string, unknown>;
}).__profiles;
const embeddedAddressStore = (
  WalletAdapter as unknown as {
    __embeddedAddresses: Map<string, string>;
  }
).__embeddedAddresses;
const noServerWallets = (WalletAdapter as unknown as {
  __noServerWallets: Set<string>;
}).__noServerWallets;
const displayNameStore = (WalletAdapter as unknown as {
  __displayNames: Map<string, string>;
}).__displayNames;
const missingDisplayNames = (WalletAdapter as unknown as {
  __missingDisplayNames: Set<string>;
}).__missingDisplayNames;
const hasEmbeddedStore = (WalletAdapter as unknown as {
  __hasEmbedded: Set<string>;
}).__hasEmbedded;
const missingEmbeddedStore = (
  WalletAdapter as unknown as {
    __missingEmbedded: Set<string>;
  }
).__missingEmbedded;
const sendCallsMock = vi.mocked(sendCalls);
const withdrawMock = vi.mocked(withdraw);
const getBalancesMock = vi.mocked(getBalances);
const getUsdcBalanceMock = vi.mocked(getUsdcBalance);
const buildOfframpUrlMock = vi.mocked(buildOfframpUrl);
const createHeadlessOnrampOrderMock = vi.mocked(createHeadlessOnrampOrder);
const phoneEscrowMock = vi.mocked(PhoneEscrowAdapter);
const resolveSendRecipientMock = vi.mocked(resolveSendRecipient);
const buildAvantisCloseCallsForWalletMock = vi.mocked(buildAvantisCloseCallsForWallet);
const resolveBasemateServerWalletMock = vi.mocked(resolveBasemateServerWallet);
const createAlertFromIntentMock = vi.mocked(createAlertFromIntent);
const buildImessagePortfolioMock = vi.mocked(buildImessagePortfolio);
const walletSetupSessionCreateMock = vi.mocked(WalletSetupSessionAdapter.create);
const fundSessionCreateMock = vi.mocked(FundSessionAdapter.create);
const { PendingPayAdapter } = await import("../wallet/pendingPay.js");
const pendingPayCreateMock = vi.mocked(PendingPayAdapter.create);

const MAIN_WALLET = "0x2222222222222222222222222222222222222222";
const renderChunks = (chunks: ImessageOutbound[]) => chunks.map(formatOutboundForRepl).join("\n");

describe("createImessageHandler PerpMate profile flow", () => {
  beforeEach(() => {
    __clearConversationStateForTests();
    profileStore.clear();
    embeddedAddressStore.clear();
    noServerWallets.clear();
    displayNameStore.clear();
    missingDisplayNames.clear();
    hasEmbeddedStore.clear();
    missingEmbeddedStore.clear();
    onrampTestState.rows.clear();
    onrampTestState.issueEmailOtp.mockClear();
    onrampTestState.verifyEmailOtp.mockClear();
    onrampTestState.resendEmailOtp.mockClear();
    sendCallsMock.mockReset();
    sendCallsMock.mockResolvedValue({ hashes: ["0xabc"] });
    withdrawMock.mockReset();
    withdrawMock
      .mockResolvedValueOnce({ transactionHash: "0xusdc" })
      .mockResolvedValueOnce({ transactionHash: "0xeth" });
    getBalancesMock.mockReset();
    getBalancesMock.mockImplementation(async (address: string) => {
      if (address.toLowerCase() === MAIN_WALLET) {
        return [
          {
            symbol: "BASEMATE",
            contractAddress: "0x07e61d8a4e197dfc269e90d7ece1df0d26702ba3",
            amount: 1_573_284_865_893_357_102_277_193n,
            decimals: 18,
            formatted: "1573284.865893357102277193",
          },
          {
            symbol: "USDC",
            contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            amount: 100_000_000n,
            decimals: 6,
            formatted: "100",
          },
          {
            symbol: "ETH",
            contractAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            amount: 1_000_000_000_000_000n,
            decimals: 18,
            formatted: "0.001",
          },
        ];
      }
      if (embeddedAddressStore.get("sender-1")?.toLowerCase() === address.toLowerCase()) {
        return [
          {
            symbol: "USDC",
            contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            amount: 7_000_000n,
            decimals: 6,
            formatted: "7",
          },
          {
            symbol: "ETH",
            contractAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            amount: 2_000_000_000_000_000n,
            decimals: 18,
            formatted: "0.002",
          },
        ];
      }
      return [
        {
          symbol: "USDC",
          contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          amount: 25_000_000n,
          decimals: 6,
          formatted: "25",
        },
      ];
    });
    getUsdcBalanceMock.mockReset();
    getUsdcBalanceMock.mockResolvedValue("25");
    createOfframpDraftMock.mockReset();
    createOfframpDraftMock.mockImplementation(async (params: { amount: string }) => ({
      url: `https://basemate.app/pay?o=offramp-${params.amount}`,
    }));
    buildOfframpUrlMock.mockClear();
    createHeadlessOnrampOrderMock.mockClear();
    fundSessionCreateMock.mockClear();
    resolveBasemateServerWalletMock.mockReset();
    resolveBasemateServerWalletMock.mockResolvedValue(null);
    buildAvantisCloseCallsForWalletMock.mockReset();
    buildAvantisCloseCallsForWalletMock.mockResolvedValue({
      calls: [{ to: "0x1111111111111111111111111111111111111111", data: "0x", value: "0x0" }],
      labels: ["Close ETH #1"],
      positions: [{
        label: "Close ETH #1",
        pair: "ETH-USD",
        pairIndex: 0,
        tradeIndex: 1,
        calls: [{ to: "0x1111111111111111111111111111111111111111", data: "0x", value: "0x0" }],
      }],
    });
    phoneEscrowMock.buildDepositDraft.mockClear();
    phoneEscrowMock.recordDepositIntent.mockClear();
    phoneEscrowMock.listUnreleasedPositions.mockClear();
    phoneEscrowMock.claimForRelease.mockClear();
    phoneEscrowMock.unclaimForRelease.mockClear();
    phoneEscrowMock.releaseToWalletAddress.mockClear();
    resolveSendRecipientMock.mockClear();
    buildImessagePortfolioMock.mockClear();
    walletSetupSessionCreateMock.mockClear();
    pendingAlerts.clear();
    createAlertFromIntentMock.mockClear();
  });

  it("does not auto-provision a server wallet for a new iMessage user", async () => {
    const ai = { respond: vi.fn(async () => ({ type: "text", text: "hello from basemate" })) };
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "discovery",
        action: "discovery",
        walletScope: "unknown",
        direction: "unknown",
        assets: [],
        amounts: [],
        targetAddress: null,
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.9,
      })),
    };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "new-sender",
      conversationId: "space-1",
      text: "hey",
    });

    expect(chunks.join("\n")).toContain("hello from basemate");
    expect(chunks.join("\n")).not.toContain("server wallet on Base");
    expect(chunks.join("\n")).not.toContain("to enable Apple Pay funding");
    expect(ai.respond).toHaveBeenCalled();
  });

  it("starts email collection when the user says add email", async () => {
    const ai = { respond: vi.fn() };
    const intentEngine = { classify: vi.fn() };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "add email",
    });

    expect(chunks.join("\n")).toContain("to enable Apple Pay funding I need your email address");
    expect(intentEngine.classify).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("issues an email OTP after collecting a valid onramp email", async () => {
    const ai = { respond: vi.fn() };
    const intentEngine = { classify: vi.fn() };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    await handler.handleInboundText({ senderId: "sender-1", conversationId: "space-1", text: "add email" });
    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "alice@example.com",
    });

    expect(onrampTestState.issueEmailOtp).toHaveBeenCalledWith("sender-1", "alice@example.com");
    expect(chunks.join("\n")).toContain("i sent a verification code to alice@example.com");
    expect(intentEngine.classify).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("rejects an invalid email OTP without calling the LLM", async () => {
    const ai = { respond: vi.fn() };
    const intentEngine = { classify: vi.fn() };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    await handler.handleInboundText({ senderId: "sender-1", conversationId: "space-1", text: "add email" });
    await handler.handleInboundText({ senderId: "sender-1", conversationId: "space-1", text: "alice@example.com" });
    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "000000",
    });

    expect(onrampTestState.verifyEmailOtp).toHaveBeenCalledWith("sender-1", "000000");
    expect(chunks.join("\n")).toContain("that code doesn't match");
    expect(intentEngine.classify).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("continues deferred funding after a valid email OTP", async () => {
    embeddedAddressStore.set("sender-1", "0x9999999999999999999999999999999999999999");
    const ai = { respond: vi.fn() };
    const intentEngine = { classify: vi.fn() };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    await handler.handleInboundText({ senderId: "sender-1", conversationId: "space-1", text: "add $25" });
    await handler.handleInboundText({ senderId: "sender-1", conversationId: "space-1", text: "alice@example.com" });
    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "123456",
    });

    expect(onrampTestState.verifyEmailOtp).toHaveBeenCalledWith("sender-1", "123456");
    expect(chunks.join("\n")).toContain("email verified");
    expect(chunks.join("\n")).toContain("tap to add $25 USDC via Apple Pay or Google Pay");
    expect(chunks.join("\n")).toContain("https://app.basemate.app/pay?s=fund-session-token");
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("resends a fresh email OTP for an unverified email", async () => {
    const ai = { respond: vi.fn() };
    const intentEngine = { classify: vi.fn() };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    await handler.handleInboundText({ senderId: "sender-1", conversationId: "space-1", text: "add email" });
    await handler.handleInboundText({ senderId: "sender-1", conversationId: "space-1", text: "alice@example.com" });
    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "resend code",
    });

    expect(onrampTestState.resendEmailOtp).toHaveBeenCalledWith("sender-1");
    expect(chunks.join("\n")).toContain("i sent a new verification code to alice@example.com");
    expect(intentEngine.classify).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("blocks guardrailed iMessage text before onboarding, intent classification, or AI", async () => {
    const ai = { respond: vi.fn() };
    const intentEngine = { classify: vi.fn() };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "new-sender",
      conversationId: "space-1",
      text: "write me a python script",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("can't write code");
    expect(intentEngine.classify).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("preserves greeting text from menu responses for existing iMessage users", async () => {
    const ai = {
      respond: vi.fn(async () => ({
        type: "menu",
        description: "hey — basemate here.",
      })),
    };
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "discovery",
        action: "discovery",
        walletScope: "unknown",
        direction: "unknown",
        assets: [],
        amounts: [],
        targetAddress: null,
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.55,
      })),
    };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "hey",
    });

    // The model's own greeting text is shown as-is; the generic blurb is not
    // appended (that would duplicate a model answer that already covers it).
    expect(chunks.join("\n")).toContain("hey — basemate here.");
    expect(chunks.join("\n")).not.toContain("here's what i can help with:");
  });

  it("renders iMessage earn choices as numbered options and accepts a numeric reply", async () => {
    const ai = {
      respond: vi
        .fn()
        .mockResolvedValueOnce({
          type: "disambiguate",
          text: "here's where you can earn USDC right now — pick a venue and i'll ask you how much:",
          token: "USDC",
          amountToken: null,
          amountUsd: null,
          options: [
            { protocol: "moonwell", label: "Moonwell — 5.0%" },
            { protocol: "morpho", label: "Morpho — 4.0% APY" },
            { protocol: "aave", label: "Aave — 3.0% APY" },
          ],
        })
        .mockResolvedValueOnce({
          type: "amount_select",
          text: "how much do you want to supply to moonwell? tap a preset or type your own:",
          asset: "USDC",
          protocol: "moonwell",
          presetsUsd: [5, 25, 100],
        }),
    };
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "discovery",
        action: "discovery",
        walletScope: "unknown",
        direction: "unknown",
        assets: [],
        amounts: [],
        targetAddress: null,
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.55,
      })),
    };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const first = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "How much can I earn from USDC staking",
    });

    expect(first.join("\n")).toContain("1. Moonwell");
    expect(first.join("\n")).toContain("2. Morpho");
    expect(first.join("\n")).toContain("3. Aave");

    const second = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "1",
    });

    expect(ai.respond).toHaveBeenLastCalledWith(
      "supply USDC on moonwell",
      expect.objectContaining({
        inboxId: "sender-1",
        conversationId: "space-1",
      }),
    );
    expect(second.join("\n")).toContain("#1. $5");
    expect(second.join("\n")).toContain("#2. $25");
    expect(second.join("\n")).toContain("#3. $100");
  });

  it("treats a bare amount during amount_select as dollars, not a preset index", async () => {
    const ai = {
      respond: vi
        .fn()
        .mockResolvedValueOnce({
          type: "amount_select",
          text: "how much do you want to deposit on morpho?",
          asset: "USDC",
          protocol: "morpho",
          presetsUsd: [5, 25, 100],
        })
        .mockResolvedValueOnce({ type: "text", text: "prepared $3 deposit" }),
    };
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "discovery",
        action: "discovery",
        walletScope: "unknown",
        direction: "unknown",
        assets: [],
        amounts: [],
        targetAddress: null,
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.55,
      })),
    };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "deposit USDC on morpho",
    });

    await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "3",
    });

    expect(ai.respond).toHaveBeenLastCalledWith(
      "deposit $3 of USDC on morpho",
      expect.objectContaining({
        inboxId: "sender-1",
        conversationId: "space-1",
      }),
    );
  });

  it("still accepts hash-prefixed preset selection during amount_select", async () => {
    const ai = {
      respond: vi
        .fn()
        .mockResolvedValueOnce({
          type: "amount_select",
          text: "how much do you want to deposit on morpho?",
          asset: "USDC",
          protocol: "morpho",
          presetsUsd: [5, 25, 100],
        })
        .mockResolvedValueOnce({ type: "text", text: "prepared $100 deposit" }),
    };
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "discovery",
        action: "discovery",
        walletScope: "unknown",
        direction: "unknown",
        assets: [],
        amounts: [],
        targetAddress: null,
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.55,
      })),
    };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "deposit USDC on morpho",
    });

    await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "#3",
    });

    expect(ai.respond).toHaveBeenLastCalledWith(
      "deposit $100 of USDC on morpho",
      expect.objectContaining({
        inboxId: "sender-1",
        conversationId: "space-1",
      }),
    );
  });

  it("starts no-install Basemate Account setup on balance request when no wallet exists", async () => {
    missingEmbeddedStore.add("sender-1");
    noServerWallets.add("sender-1");
    const ai = { respond: vi.fn() };
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "wallet",
        action: "main_wallet_balance",
        walletScope: "main_server_wallet",
        direction: "unknown",
        assets: [],
        amounts: [],
        targetAddress: null,
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.8,
      })),
    };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "What's my wallet?",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("set up your Basemate account");
    expect(chunks[0]).toContain("https://basemate.app/wallet/connect?s=setup-token");
    expect(walletSetupSessionCreateMock).toHaveBeenCalledWith("sender-1");
    expect(embeddedAddressStore.get("sender-1")).toBeUndefined();
    expect(buildImessagePortfolioMock).not.toHaveBeenCalled();
    expect(getBalancesMock).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("does not ask users to paste a external wallet address on missing-wallet balance requests", async () => {
    missingEmbeddedStore.add("sender-1");
    noServerWallets.add("sender-1");
    const ai = { respond: vi.fn() };
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "wallet",
        action: "main_wallet_balance",
        walletScope: "main_server_wallet",
        direction: "unknown",
        assets: [],
        amounts: [],
        targetAddress: null,
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.8,
      })),
    };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Show my wallet",
    });

    expect(chunks.join("\n")).not.toContain("external wallet address");
    expect(chunks.join("\n")).not.toContain("paste your 0x address");
    expect(chunks.join("\n")).toContain("/wallet/connect");
    expect(resolveSendRecipientMock).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("starts Basemate Account setup for create-wallet requests when only the server wallet exists", async () => {
    missingEmbeddedStore.add("sender-1");
    const ai = { respond: vi.fn() };
    const handler = createImessageHandler(ai as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Create a wallet",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("set up your Basemate account");
    expect(chunks[0]).toContain("https://basemate.app/wallet/connect?s=setup-token");
    expect(walletSetupSessionCreateMock).toHaveBeenCalledWith("sender-1");
    expect(buildImessagePortfolioMock).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("starts Basemate Account setup for connect-account requests before generic balance routing", async () => {
    missingEmbeddedStore.add("sender-1");
    const ai = { respond: vi.fn() };
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "wallet",
        action: "main_wallet_balance",
        walletScope: "main_server_wallet",
        direction: "unknown",
        assets: [],
        amounts: [],
        targetAddress: null,
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.8,
      })),
    };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Connect a base account",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("set up your Basemate account");
    expect(chunks[0]).toContain("https://basemate.app/wallet/connect?s=setup-token");
    expect(chunks.join("\n")).not.toContain("Your portfolio is about $0.0000");
    expect(walletSetupSessionCreateMock).toHaveBeenCalledWith("sender-1");
    expect(intentEngine.classify).not.toHaveBeenCalled();
    expect(buildImessagePortfolioMock).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();

    const balance = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Show my balance",
    });

    expect(balance.join("\n")).not.toContain("Recipients must be a full basename");
    expect(resolveSendRecipientMock).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("starts Basemate Account setup for an existing empty server-wallet portfolio", async () => {
    missingEmbeddedStore.add("sender-1");
    buildImessagePortfolioMock.mockResolvedValueOnce({
      generatedAt: "2026-01-01T00:00:00.000Z",
      user: {
        id: "sender-1",
        wallets: [MAIN_WALLET],
        walletLabels: { [MAIN_WALLET.toLowerCase()]: "Main wallet" },
        serverWallet: MAIN_WALLET,
      },
      totals: {
        coinsUsd: 0,
        perpsUsd: 0,
        stakingUsd: 0,
        totalUsd: 0,
      },
      coins: [],
      perpetuals: [],
      staking: [],
      errors: [],
    });
    const ai = { respond: vi.fn() };
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "wallet",
        action: "main_wallet_balance",
        walletScope: "main_server_wallet",
        direction: "unknown",
        assets: [],
        amounts: [],
        targetAddress: null,
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.8,
      })),
    };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "show my balance",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("set up your Basemate account");
    expect(chunks[0]).toContain("https://basemate.app/wallet/connect?s=setup-token");
    expect(chunks.join("\n")).not.toContain("Your portfolio is about $0.0000");
    expect(getBalancesMock).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("treats an invalid saved Basemate Account as missing on balance requests", async () => {
    missingEmbeddedStore.add("sender-1");
    embeddedAddressStore.set("sender-1", "not-an-address");
    const ai = { respond: vi.fn() };
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "wallet",
        action: "main_wallet_balance",
        walletScope: "main_server_wallet",
        direction: "unknown",
        assets: [],
        amounts: [],
        targetAddress: null,
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.8,
      })),
    };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "show my balance",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("https://basemate.app/wallet/connect?s=setup-token");
    expect(chunks.join("\n")).not.toContain("Your portfolio is about $0.0000");
    expect(buildImessagePortfolioMock).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("starts Basemate Account setup before funding when only the server wallet exists", async () => {
    missingEmbeddedStore.add("sender-1");
    const ai = { respond: vi.fn() };
    const intentEngine = { classify: vi.fn() };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "add $25",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("set up your Basemate account");
    expect(chunks[0]).toContain("https://basemate.app/wallet/connect?s=setup-token");
    expect(ai.respond).not.toHaveBeenCalled();
    expect(intentEngine.classify).not.toHaveBeenCalled();
  });

  it("asks for an amount for explicit add-funds intent without an amount", async () => {
    embeddedAddressStore.set("sender-1", "0x9999999999999999999999999999999999999999");
    const ai = { respond: vi.fn() };
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "wallet",
        action: "main_wallet_fund",
        walletScope: "main_server_wallet",
        direction: "unknown",
        assets: ["USDC"],
        amounts: [],
        targetAddress: null,
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.9,
      })),
    };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "buy crypto",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("how much? reply 25, 50, 100");
    expect(intentEngine.classify).toHaveBeenCalled();
    expect(createHeadlessOnrampOrderMock).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("creates a Headless Onramp fund-session link for verified add-funds intent", async () => {
    embeddedAddressStore.set("sender-1", "0x9999999999999999999999999999999999999999");
    await onrampTestState.upsert("sender-1", {
      email: "alice@example.com",
      tosAcceptedAt: new Date("2026-01-01T00:00:00.000Z"),
      emailVerifiedAt: new Date("2026-01-01T00:01:00.000Z"),
      phoneVerifiedAt: new Date(),
    });
    const ai = { respond: vi.fn() };
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "wallet",
        action: "main_wallet_fund",
        walletScope: "main_server_wallet",
        direction: "unknown",
        assets: ["USDC"],
        amounts: [{ asset: "USDC", amount: null, amountUsd: "25", all: false }],
        targetAddress: null,
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.9,
      })),
    };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "buy $25 crypto",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("tap to add $25 USDC via Apple Pay or Google Pay");
    expect(chunks[0]).toContain("https://app.basemate.app/pay?s=fund-session-token");
    expect(mockCreateFundSessionIntent).toHaveBeenCalledWith({
      userPhone: "sender-1",
      walletAddress: "0x9999999999999999999999999999999999999999",
      amountUsd: 25,
    });
    expect(createHeadlessOnrampOrderMock).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("clears pending fund amount when user asks for balance instead", async () => {
    embeddedAddressStore.set("sender-1", "0x9999999999999999999999999999999999999999");
    await onrampTestState.upsert("sender-1", {
      email: "alice@example.com",
      tosAcceptedAt: new Date("2026-01-01T00:00:00.000Z"),
      emailVerifiedAt: new Date("2026-01-01T00:01:00.000Z"),
      phoneVerifiedAt: new Date(),
    });
    const ai = { respond: vi.fn() };
    const handler = createImessageHandler(ai as never);

    await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "onramp",
    });

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Check my balance",
    });

    expect(chunks.join("\n")).toContain("here's your Basemate Account:");
    expect(chunks.join("\n")).not.toContain("reply a dollar amount");
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("returns a Coinbase Offramp link for explicit cash-out intent when USDC exists", async () => {
    embeddedAddressStore.set("sender-1", "0x9999999999999999999999999999999999999999");
    getUsdcBalanceMock.mockResolvedValue("25");
    const ai = { respond: vi.fn() };
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "wallet",
        action: "main_wallet_offramp",
        walletScope: "main_server_wallet",
        direction: "unknown",
        assets: ["USDC"],
        amounts: [{ asset: "USDC", amount: "10", amountUsd: null, all: false }],
        targetAddress: null,
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.9,
      })),
    };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Cash out $10",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("tap to cash out 10 USDC to fiat via Coinbase");
    expect(chunks[0]).toContain("https://basemate.app/pay?o=offramp-10");
    expect(createOfframpDraftMock).toHaveBeenCalledWith({
      platform: "imessage",
      userKey: "sender-1",
      sourceAddress: "0x9999999999999999999999999999999999999999",
      amount: "10",
    });
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("asks for an amount before checking cash-out balance", async () => {
    embeddedAddressStore.set("sender-1", "0x9999999999999999999999999999999999999999");
    getUsdcBalanceMock.mockResolvedValue("0");
    const ai = { respond: vi.fn() };
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "wallet",
        action: "main_wallet_offramp",
        walletScope: "main_server_wallet",
        direction: "unknown",
        assets: ["USDC"],
        amounts: [],
        targetAddress: null,
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.9,
      })),
    };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "cash out",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("how much USDC should i cash out");
    expect(createOfframpDraftMock).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("starts Basemate Account setup before generic main-wallet AI routing", async () => {
    missingEmbeddedStore.add("sender-1");
    const ai = {
      respond: vi.fn(async () => ({
        type: "text",
        text: "Your portfolio is about $0.0000.\n\nTop coins:\n- No tracked Base coin balances yet.",
      })),
    };
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "wallet",
        action: "main_wallet_transfer",
        walletScope: "main_server_wallet",
        direction: "out",
        assets: [],
        amounts: [],
        targetAddress: "0x9999999999999999999999999999999999999999",
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.8,
      })),
    };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "send 10 USDC to 0x9999999999999999999999999999999999999999",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("https://basemate.app/wallet/connect?s=setup-token");
    expect(chunks.join("\n")).not.toContain("Your portfolio is about $0.0000");
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("keeps an empty portfolio response for a connected embedded wallet", async () => {
    const ai = {
      respond: vi.fn(async () => ({
        type: "text",
        text: "Your portfolio is about $0.0000.\n\nTop coins:\n- No tracked Base coin balances yet.",
      })),
    };
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "discovery",
        action: "discovery",
        walletScope: "unknown",
        direction: "unknown",
        assets: [],
        amounts: [],
        targetAddress: null,
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.55,
      })),
    };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "portfolio status",
    });

    expect(ai.respond).toHaveBeenCalled();
    expect(chunks).toHaveLength(1);
    expect(chunks.join("\n")).toContain("Your portfolio is about $0.0000");
    expect(chunks.join("\n")).not.toContain("/wallet/connect");
  });

  it("starts Basemate Account setup for balance text before intent classification", async () => {
    missingEmbeddedStore.add("sender-1");
    const ai = { respond: vi.fn() };
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "discovery",
        action: "discovery",
        walletScope: "unknown",
        direction: "unknown",
        assets: [],
        amounts: [],
        targetAddress: null,
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.55,
      })),
    };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Show my balance",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("https://basemate.app/wallet/connect?s=setup-token");
    expect(intentEngine.classify).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("drops echoed empty portfolio messages to stop reply loops", async () => {
    const ai = { respond: vi.fn() };
    const intentEngine = { classify: vi.fn() };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Your portfolio is about $0.0000.\n\nTop coins:\n- No tracked Base coin balances yet.",
    });

    expect(chunks).toEqual([]);
    expect(intentEngine.classify).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("starts Basemate Account setup before funding when no wallet exists", async () => {
    missingEmbeddedStore.add("sender-1");
    noServerWallets.add("sender-1");
    const ai = { respond: vi.fn() };
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "wallet",
        action: "main_wallet_fund",
        walletScope: "main_server_wallet",
        direction: "unknown",
        assets: [],
        amounts: [{ asset: "USDC", amount: "25", amountUsd: null, all: false }],
        targetAddress: null,
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.8,
      })),
    };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "add $25",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("set up your Basemate account");
    expect(chunks[0]).toContain("https://basemate.app/wallet/connect?s=setup-token");
    expect(walletSetupSessionCreateMock).toHaveBeenCalledWith("sender-1");
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("shows the connected Basemate Account balance in wallet replies", async () => {
    embeddedAddressStore.set("sender-1", "0x9999999999999999999999999999999999999999");
    const ai = { respond: vi.fn() };
    const handler = createImessageHandler(ai as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Show my balance",
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("here's your Basemate Account:");
    expect(chunks[0]).toContain("• 7 USDC");
    expect(chunks[0]).toContain("• 0.002 ETH");
    expect(chunks[1]).toBe("0x9999999999999999999999999999999999999999");
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("shows a saved Basemate Account even when no server wallet exists", async () => {
    noServerWallets.add("sender-1");
    embeddedAddressStore.set("sender-1", "0x9999999999999999999999999999999999999999");
    const ai = { respond: vi.fn() };
    const handler = createImessageHandler(ai as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Show my wallet",
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("here's your Basemate Account:");
    expect(chunks[0]).toContain("• 7 USDC");
    expect(chunks[1]).toBe("0x9999999999999999999999999999999999999999");
    expect(buildImessagePortfolioMock).toHaveBeenCalledWith("sender-1");
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("swaps a full token balance via the Basemate Account tap-to-sign link", async () => {
    embeddedAddressStore.set("sender-1", MAIN_WALLET);
    const calls = [
      {
        to: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        data: "0x1234" as `0x${string}`,
        value: "0x0" as `0x${string}`,
      },
    ];
    const ai = {
      respond: vi.fn(async () => ({
        type: "transaction",
        text: "Swap 1573284.865893357102277193 BASEMATE → USDC on Base — sign below:",
        chainId: "0x2105",
        calls,
      })),
    };
    const handler = createImessageHandler(ai as never);

    const prompt = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Swap all BASEMATE to usdc",
    });

    expect(ai.respond).toHaveBeenCalledWith(
      "Swap 1573284.865893357102277193 BASEMATE to USDC",
      expect.objectContaining({
        walletAddress: MAIN_WALLET,
        custodialWallet: false,
      }),
    );
    expect(renderChunks(prompt)).toContain("https://app.basemate.app/pay/sign/");
    expect(sendCallsMock).not.toHaveBeenCalled();
  });

  it("prompts to connect a Basemate account when the sender has no embedded wallet", async () => {
    missingEmbeddedStore.add("sender-1");
    embeddedAddressStore.set("sender-1", MAIN_WALLET);
    const calls = [
      {
        to: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        data: "0x1234" as `0x${string}`,
        value: "0x0" as `0x${string}`,
      },
    ];
    const ai = {
      respond: vi.fn(async () => ({
        type: "transaction",
        text: "Stake 100 USDC on Morpho — sign below:",
        chainId: "0x2105",
        calls,
      })),
    };
    const handler = createImessageHandler(ai as never);

    const prompt = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Stake 100 USDC to Morpho",
    });

    const rendered = renderChunks(prompt);
    expect(rendered).toContain("set up your Basemate account");
  });

  it("uses a pending swap draft when the user replies whole balance", async () => {
    embeddedAddressStore.set("sender-1", MAIN_WALLET);
    const calls = [
      {
        to: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        data: "0x1234" as `0x${string}`,
        value: "0x0" as `0x${string}`,
      },
    ];
    const ai = {
      respond: vi
        .fn()
        .mockResolvedValueOnce({ type: "text", text: "What amount should I swap?" })
        .mockResolvedValueOnce({
          type: "transaction",
          text: "Swap 1573284.865893357102277193 BASEMATE → USDC on Base — sign below:",
          chainId: "0x2105",
          calls,
        }),
    };
    const handler = createImessageHandler(ai as never);

    const amountPrompt = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Swap BASEMATE to usdc",
    });
    expect(amountPrompt.join("\n")).toContain("What amount should I swap?");

    const confirmPrompt = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Whole balance",
    });

    expect(ai.respond).toHaveBeenLastCalledWith(
      "Swap 1573284.865893357102277193 BASEMATE to USDC",
      expect.any(Object),
    );
    expect(renderChunks(confirmPrompt)).toContain("https://app.basemate.app/pay/sign/");
  });

  it("resolves swap-it-all follow-ups from the last explicit balance asset", async () => {
    embeddedAddressStore.set("sender-1", MAIN_WALLET);
    const calls = [
      {
        to: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        data: "0x1234" as `0x${string}`,
        value: "0x0" as `0x${string}`,
      },
    ];
    const ai = {
      respond: vi.fn(async () => ({
        type: "transaction",
        text: "Swap 100 USDC → MXNB on Base — sign below:",
        chainId: "0x2105",
        calls,
      })),
    };
    const handler = createImessageHandler(ai as never);

    const balance = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "How much usdc do i have?",
    });
    expect(balance.join("\n")).toContain("100 USDC");
    expect(ai.respond).not.toHaveBeenCalled();

    const prompt = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Swap it all to MXNB and put it in a morpho vault",
    });

    expect(ai.respond).toHaveBeenCalledWith(
      "Swap 100 USDC to MXNB",
      expect.objectContaining({
        walletAddress: MAIN_WALLET,
        custodialWallet: false,
      }),
    );
    expect(renderChunks(prompt)).toContain("https://app.basemate.app/pay/sign/");
  });

  it("opens a direct iMessage perp via the embedded-wallet confirm link", async () => {
    hasEmbeddedStore.add("sender-1");
    await PerpProfileAdapter.upsertProfile("sender-1", {
      risk_tier: "tactical",
      default_collateral_usdc: "25",
    });
    const ai = { respond: vi.fn() };
    const handler = createImessageHandler(ai as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Long eth",
    });

    expect(ai.respond).not.toHaveBeenCalled();
    expect(renderChunks(chunks)).toContain("Open 7x long ETH-USD with $25 USDC");
    expect(renderChunks(chunks)).toContain("tap to review & confirm");
    expect(renderChunks(chunks)).toContain("https://app.basemate.app/pay/sign/");
    expect(sendCallsMock).not.toHaveBeenCalled();
  });

  it("parses buy-symbol-long-leverage-dollar phrasing for direct iMessage perps", async () => {
    hasEmbeddedStore.add("sender-1");
    await PerpProfileAdapter.upsertProfile("sender-1", {
      risk_tier: "tactical",
      default_collateral_usdc: "25",
    });
    const ai = { respond: vi.fn() };
    const handler = createImessageHandler(ai as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Buy ETH long 75x for 2$",
    });

    const text = renderChunks(chunks);
    expect(text).toContain("Open 75x long ETH-USD with $2 USDC");
    expect(text).not.toContain("that market isn't listed");
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("falls back to the stable iMessage conversation profile when sender id changes", async () => {
    hasEmbeddedStore.add("sender-rotated");
    await PerpProfileAdapter.upsertProfile("space-1", {
      risk_tier: "tactical",
      default_collateral_usdc: "25",
    });
    const ai = { respond: vi.fn() };
    const handler = createImessageHandler(ai as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-rotated",
      conversationId: "space-1",
      text: "Long eth",
    });

    expect(ai.respond).not.toHaveBeenCalled();
    expect(renderChunks(chunks)).toContain("Open 7x long ETH-USD with $25 USDC");
    expect(await PerpProfileAdapter.getProfile("sender-rotated")).toMatchObject({
      default_collateral_usdc: "25",
      risk_tier: "tactical",
    });
  });

  it("mirrors newly saved setup to sender and conversation keys", async () => {
    const ai = {
      respond: vi.fn(async () => ({
        type: "perp_setup_redirect",
        text: "before your first perp, pick a risk tier and default USDC margin",
      })),
    };
    const handler = createImessageHandler(ai as never);

    await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Long eth",
    });
    await handler.handleInboundText({ senderId: "sender-1", conversationId: "space-1", text: "setup" });
    await handler.handleInboundText({ senderId: "sender-1", conversationId: "space-1", text: "tactical" });
    const chunks = await handler.handleInboundText({ senderId: "sender-1", conversationId: "space-1", text: "$25" });

    expect(chunks.join("\n")).toContain("saved — tactical, $25 USDC per trade");
    expect(await PerpProfileAdapter.getProfile("sender-1")).toMatchObject({
      default_collateral_usdc: "25",
      risk_tier: "tactical",
    });
    expect(await PerpProfileAdapter.getProfile("space-1")).toMatchObject({
      default_collateral_usdc: "25",
      risk_tier: "tactical",
    });
  });

  it("routes generic Avantis management transactions to the Basemate Account tap-to-sign link", async () => {
    embeddedAddressStore.set("sender-1", "0x9999999999999999999999999999999999999999");
    const calls = [
      {
        to: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        data: "0x1234" as `0x${string}`,
        value: "0x0" as `0x${string}`,
      },
    ];
    const ai = {
      respond: vi.fn(async () => ({
        type: "transaction",
        text: "Close ETHUSD #1 on Avantis",
        chainId: "0x2105",
        calls,
      })),
    };
    const handler = createImessageHandler(ai as never);

    const prompt = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "close my eth position",
    });

    expect(ai.respond).toHaveBeenCalledWith(
      "close my eth position",
      expect.objectContaining({
        walletAddress: "0x9999999999999999999999999999999999999999",
        custodialWallet: false,
      }),
    );
    expect(renderChunks(prompt)).toContain("https://app.basemate.app/pay/sign/");
    expect(sendCallsMock).not.toHaveBeenCalled();
  });


  it("routes a generic transaction through embedded wallet confirmation", async () => {
    embeddedAddressStore.set("sender-1", "0x9999999999999999999999999999999999999999");
    const calls = [
      {
        to: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        data: "0x1234" as `0x${string}`,
        value: "0x0" as `0x${string}`,
      },
    ];
    const ai = {
      respond: vi.fn(async () => ({
        type: "transaction",
        text: "Close ETHUSD #1 on Avantis",
        chainId: "0x2105",
        calls,
      })),
    };
    const handler = createImessageHandler(ai as never);

    const link = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "close my eth position",
    });

    expect(renderChunks(link)).toContain("https://app.basemate.app/pay/sign/");
    expect(link.join("\n")).not.toContain("1. Server Wallet");
    expect(resolveSendRecipientMock).not.toHaveBeenCalled();
    expect(sendCallsMock).not.toHaveBeenCalled();
  });

  it("shows the stored Basemate Account address after a direct iMessage perp confirmation prompt", async () => {
    embeddedAddressStore.set("sender-1", "0x9999999999999999999999999999999999999999");
    await PerpProfileAdapter.upsertProfile("sender-1", {
      risk_tier: "tactical",
      default_collateral_usdc: "25",
    });
    const ai = { respond: vi.fn() };
    const handler = createImessageHandler(ai as never);

    const prompt = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Long eth",
    });
    expect(renderChunks(prompt)).not.toContain("2. external wallet");

    const addressReply = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "Show my base app address",
    });

    expect(addressReply.join("\n")).toContain("here's your Basemate Account:");
    expect(addressReply.join("\n")).toContain("0x9999999999999999999999999999999999999999");
    expect(sendCallsMock).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("closes Avantis positions via the embedded-wallet confirm link", async () => {
    hasEmbeddedStore.add("sender-1");
    const ai = { respond: vi.fn() };
    const handler = createImessageHandler(ai as never);

    const prompt = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "space-1",
      text: "close basemate ETH position",
    });

    expect(renderChunks(prompt)).toContain("Close Avantis position");
    expect(renderChunks(prompt)).toContain("tap to review & confirm");
    expect(renderChunks(prompt)).toContain("https://app.basemate.app/pay/sign/");
    expect(buildAvantisCloseCallsForWalletMock).toHaveBeenCalledWith(
      expect.objectContaining({ closeAll: false, pair: "ETH", tradeIndex: undefined }),
    );
    expect(sendCallsMock).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

});

describe("createImessageHandler iMessage group context", () => {
  beforeEach(() => {
    __clearConversationStateForTests();
    pendingAlerts.clear();
    createAlertFromIntentMock.mockClear();
  });

  function priceAlertIntentEngine(action: "price_alert_create" | "price_alert_followup") {
    return {
      classify: vi.fn(async () => ({
        domain: "price_alert",
        action,
        walletScope: "unknown",
        direction: "unknown",
        assets: [],
        amounts: [],
        targetAddress: null,
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.95,
      })),
    };
  }

  it("recognizes and strips configured iMessage group mentions", () => {
    expect(isImessageMentioned("@basemate alert me when ETH hits 4000")).toBe(true);
    expect(isImessageMentioned("hey @basemate.base.eth what is my balance?")).toBe(true);
    expect(isImessageMentioned("anyone watching ETH?")).toBe(false);
    expect(removeImessageMention("hey @basemate.eth alert ETH at 4000")).toBe(
      "hey alert ETH at 4000",
    );
  });

  it("creates group-sourced alerts with future delivery pointed at the sender DM", async () => {
    const handler = createImessageHandler(
      { respond: vi.fn() } as never,
      priceAlertIntentEngine("price_alert_create") as never,
    );

    const chunks = await handler.handleInboundText({
      senderId: "+15551234567",
      conversationId: "group-space-1",
      dmConversationId: "+15551234567",
      isGroup: true,
      text: "alert ETH at 4000",
    });

    expect(chunks.join("\n")).toContain("I'll send the alert to your DM, not this group.");
    expect(createAlertFromIntentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userKey: "+15551234567",
        dmTarget: { spaceId: "+15551234567" },
        sourceConversationId: "group-space-1",
        sourceIsGroup: true,
      }),
      expect.objectContaining({ tokenQuery: "ETH" }),
    );
  });

  it("keeps group alert follow-ups pending in the source conversation", async () => {
    createAlertFromIntentMock.mockResolvedValueOnce({
      kind: "ambiguous",
      reply: "which ETH token? send the contract address.",
    });
    const handler = createImessageHandler(
      { respond: vi.fn() } as never,
      priceAlertIntentEngine("price_alert_create") as never,
    );

    await handler.handleInboundText({
      senderId: "+15551234567",
      conversationId: "group-space-1",
      dmConversationId: "+15551234567",
      isGroup: true,
      text: "alert ETH at 4000",
    });

    expect(pendingAlerts.has(pendingAlertKey("imessage", "+15551234567", "group-space-1")))
      .toBe(true);
    await expect(handler.hasPendingInteraction({
      senderId: "+15551234567",
      conversationId: "group-space-1",
    })).resolves.toBe(true);

    const followupHandler = createImessageHandler(
      { respond: vi.fn() } as never,
      priceAlertIntentEngine("price_alert_followup") as never,
    );
    pendingAlerts.set(
      pendingAlertKey("imessage", "+15551234567", "group-space-1"),
      {
        tokenQuery: "ETH",
        contractAddress: null,
        metric: "price_usd",
        targetValue: 4000,
        direction: null,
      },
    );

    await followupHandler.handleInboundText({
      senderId: "+15551234567",
      conversationId: "group-space-1",
      dmConversationId: "+15551234567",
      isGroup: true,
      text: "0x1111111111111111111111111111111111111111",
    });

    expect(createAlertFromIntentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dmTarget: { spaceId: "+15551234567" },
        sourceConversationId: "group-space-1",
        sourceIsGroup: true,
      }),
      expect.objectContaining({
        contractAddress: "0x1111111111111111111111111111111111111111",
      }),
    );
  });
});

describe("createImessageHandler send contact resolution", () => {
  beforeEach(() => {
    __clearConversationStateForTests();
    embeddedAddressStore.clear();
    hasEmbeddedStore.clear();
    missingEmbeddedStore.clear();
    pendingPayCreateMock.mockClear();
    phoneEscrowMock.buildDepositDraft.mockClear();
    phoneEscrowMock.recordDepositIntent.mockClear();
    phoneEscrowMock.listUnreleasedPositions.mockClear();
    phoneEscrowMock.claimForRelease.mockClear();
    phoneEscrowMock.unclaimForRelease.mockClear();
    phoneEscrowMock.releaseToWalletAddress.mockClear();
    vi.spyOn(UserProfileAdapter, "getByPhone").mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function sendIntentEngine(asset = "USDC", amount = "1") {
    return {
      classify: vi.fn(async (message: string) => {
        const t = (message ?? "").trim().toLowerCase();
        const base = {
          walletScope: "unknown",
          direction: "unknown",
          assets: [] as string[],
          amounts: [] as unknown[],
          targetAddress: null,
          targetName: null,
          leaderboardCategory: null,
          confidence: 0.9,
        };
        if (/^(yes|yep|yeah|yup|confirm|ok|okay)\b/.test(t)) {
          return { ...base, domain: "system", action: "confirm" };
        }
        if (/^(no|nope|cancel|stop)\b/.test(t)) {
          return { ...base, domain: "system", action: "cancel" };
        }
        return {
          domain: "discovery",
          action: "send_token",
          walletScope: "unknown",
          direction: "unknown",
          assets: [asset],
          amounts: [{ asset, amount, amountUsd: null, all: false }],
          targetAddress: null,
          targetName: null,
          leaderboardCategory: null,
          confidence: 0.8,
        };
      }),
    };
  }

  it("requires a numbered choice when contacts share the mentioned name", async () => {
    embeddedAddressStore.set("sender-1", "0x9999999999999999999999999999999999999999");
    const alexSmith = {
      id: 1,
      name: "Alex Smith",
      contact_owner: "sender-1",
      contact: null,
      contact_phone: "+15550000001",
      created_at: new Date(),
      updated_at: new Date(),
    };
    const alexJones = {
      ...alexSmith,
      id: 2,
      name: "Alex Jones",
      contact_phone: "+15550000002",
    };
    vi.spyOn(ContactsAdapter, "findByNameFuzzy").mockResolvedValue({
      matches: [alexSmith, alexJones],
      ambiguous: true,
    });
    const findByPhone = vi
      .spyOn(ContactsAdapter, "findByPhone")
      .mockResolvedValue(alexJones);
    const ai = {
      respond: vi.fn(async () => ({
        type: "transaction",
        text: "Send 5 USDC",
        chainId: "0x2105",
        calls: [{ to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", data: "0x" }],
      })),
    };
    const handler = createImessageHandler(ai as never, sendIntentEngine("USDC", "5") as never);

    const prompt = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "send 5 USDC to Alex",
    });

    expect(renderChunks(prompt)).toContain("1. Alex Smith (+1 (555) 000-0001)");
    expect(renderChunks(prompt)).toContain("2. Alex Jones (+1 (555) 000-0002)");
    expect(renderChunks(prompt)).toContain("reply 1 or 2");
    expect(ai.respond).not.toHaveBeenCalled();
    expect(pendingPayCreateMock).not.toHaveBeenCalled();
    expect(phoneEscrowMock.buildDepositDraft).not.toHaveBeenCalled();

    const resumed = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "2",
    });

    expect(findByPhone).toHaveBeenCalledWith("sender-1", "+15550000002");
    expect(ai.respond).toHaveBeenCalledWith(
      expect.stringContaining("send 5 USDC to 0x"),
      expect.any(Object),
    );
    expect(renderChunks(resumed)).toContain("Would you like to add a message?");
    expect(pendingPayCreateMock).not.toHaveBeenCalled();

    await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "skip",
    });
    expect(pendingPayCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientDisplay: "+15550000002",
        amount: "5",
        tokenSymbol: "USDC",
        transferMemo: null,
      }),
    );
  });

  it("checks lowercase bare recipient names against saved contacts", async () => {
    vi.spyOn(ContactsAdapter, "resolveWallet").mockResolvedValue({
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      phone: "+639171234567",
      isNew: false,
    });
    vi.spyOn(ContactsAdapter, "findByName").mockResolvedValue({
      id: 1,
      name: "Manila",
      contact_owner: "sender-1",
      contact: "+639171234567",
      contact_phone: "+639171234567",
      created_at: new Date(),
      updated_at: new Date(),
    });
    const ai = {
      respond: vi.fn(async () => ({ type: "text", text: "ready to send" })),
    };
    const handler = createImessageHandler(ai as never, sendIntentEngine() as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "send $1 usdc to manila",
    });

    // A lowercase bare name still resolves to the saved contact (not "unknown"),
    // and the refactored resolver keeps the human name in the message for the
    // brain instead of rewriting it to a 0x address.
    expect(renderChunks(chunks)).not.toContain("don't have");
    expect(ai.respond).toHaveBeenCalledWith(
      expect.stringContaining("manila"),
      expect.any(Object),
    );
  });

  it("resolves a recipient-first dollar send as a saved contact", async () => {
    vi.spyOn(ContactsAdapter, "resolveWallet").mockResolvedValue({
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      phone: "+919876543210",
      isNew: false,
    });
    vi.spyOn(ContactsAdapter, "findByName").mockResolvedValue({
      id: 1,
      name: "Degeneer",
      contact_owner: "sender-1",
      contact: "+919876543210",
      contact_phone: "+919876543210",
      created_at: new Date(),
      updated_at: new Date(),
    });
    const ai = {
      respond: vi.fn(async () => ({ type: "text", text: "ready to send" })),
    };
    const handler = createImessageHandler(ai as never, sendIntentEngine() as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "Send Degeneer $2",
    });

    // Recipient-first phrasing resolves to the saved contact; the name is kept
    // in the message (no 0x rewrite) so the brain builds the send.
    expect(renderChunks(chunks)).not.toContain("don't have");
    expect(ai.respond).toHaveBeenCalledWith(
      expect.stringContaining("Degeneer"),
      expect.any(Object),
    );
  });

  it("persists contact transfer metadata without notifying at approval-link time", async () => {
    embeddedAddressStore.set("sender-1", "0x9999999999999999999999999999999999999999");
    vi.spyOn(ContactsAdapter, "resolveWallet").mockResolvedValue({
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      phone: "+639171234567",
      isNew: false,
    });
    const contactRow = {
      id: 1,
      name: "Manila",
      contact_owner: "sender-1",
      contact: "+639171234567",
      contact_phone: "+639171234567",
      created_at: new Date(),
      updated_at: new Date(),
    };
    vi.spyOn(ContactsAdapter, "findByName").mockResolvedValue(contactRow);
    vi.spyOn(ContactsAdapter, "findByPhone").mockResolvedValue(contactRow);
    const ai = {
      respond: vi.fn().mockResolvedValueOnce({
        type: "transaction",
        text: "Send 1 USDC",
        chainId: "0x2105",
        calls: [{ to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", data: "0x" }],
      }).mockResolvedValue({ type: "text", text: "sign request card above" }),
    };
    const handler = createImessageHandler(
      ai as never,
      sendIntentEngine() as never,
    );

    hasEmbeddedStore.add("sender-1");
    const messagePrompt = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "send 1 USDC to manila",
    });
    expect(renderChunks(messagePrompt)).toContain("Would you like to add a message?");
    expect(pendingPayCreateMock).not.toHaveBeenCalled();

    await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "Thank you for the pizza",
    });

    // Contact transfer metadata is stashed on the pending confirm row so the
    // recipient is notified only once the sender confirms and it executes.
    expect(pendingPayCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      walletKind: "embedded",
      recipientDisplay: "+639171234567",
      amount: "1",
      tokenSymbol: "USDC",
      transferMemo: "Thank you for the pizza",
    }));
    expect(ai.respond).toHaveBeenCalledTimes(1);
  });

  it("shows the contact name (not a 0x address) in the send approval label", async () => {
    hasEmbeddedStore.add("sender-1");
    vi.spyOn(ContactsAdapter, "resolveWallet").mockResolvedValue({
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      phone: "+639171234567",
      isNew: false,
    });
    const contactRow = {
      id: 1,
      name: "Manila",
      contact_owner: "sender-1",
      contact: "+639171234567",
      contact_phone: "+639171234567",
      created_at: new Date(),
      updated_at: new Date(),
    };
    vi.spyOn(ContactsAdapter, "findByName").mockResolvedValue(contactRow);
    vi.spyOn(ContactsAdapter, "findByPhone").mockResolvedValue(contactRow);
    const ai = {
      respond: vi.fn(async () => ({
        type: "transaction",
        text: "Send 1 USDC to 0x2113\u2026163c",
        chainId: "0x2105",
        calls: [{ to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", data: "0x" }],
      })),
    };
    const handler = createImessageHandler(ai as never, sendIntentEngine() as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "send 1 USDC to manila with message Thank you",
    });

    const rendered = renderChunks(chunks);
    expect(rendered).toContain("Manila (+639171234567)");
    expect(rendered).not.toContain("0x2113\u2026163c");
  });

  it("builds an embedded-wallet escrow confirm link for a phone-only saved contact", async () => {
    hasEmbeddedStore.add("sender-1");
    // Recipient has no Basemate Account → resolves to the claim/escrow path.
    missingEmbeddedStore.add("+639171234567");
    vi.spyOn(ContactsAdapter, "resolveWallet").mockResolvedValue(null);
    vi.spyOn(ContactsAdapter, "findByName").mockResolvedValue({
      id: 1,
      name: "Manila",
      contact_owner: "sender-1",
      contact: null,
      contact_phone: "+639171234567",
      created_at: new Date(),
      updated_at: new Date(),
    });
    const ai = {
      respond: vi.fn(async () => ({ type: "text", text: "should not route through AI" })),
    };
    const handler = createImessageHandler(ai as never, sendIntentEngine() as never);

    // Step 1: collect the optional message before confirming the resolved number.
    const messagePrompt = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "send $1 usdc to manila",
    });
    expect(renderChunks(messagePrompt)).toContain("Would you like to add a message?");
    expect(phoneEscrowMock.buildDepositDraft).not.toHaveBeenCalled();

    // Step 2: skipping the message advances to number confirmation.
    const confirmPrompt = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "skip",
    });
    expect(renderChunks(confirmPrompt)).toContain("+639171234567");
    expect(renderChunks(confirmPrompt).toLowerCase()).toContain("reply yes");
    expect(phoneEscrowMock.buildDepositDraft).not.toHaveBeenCalled();

    // Step 3: confirming builds the escrow deposit link.
    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "yes",
    });

    expect(renderChunks(chunks)).toContain("Send 1 USDC for manila to claim");
    expect(renderChunks(chunks)).toContain("https://app.basemate.app/pay/sign/");
    expect(phoneEscrowMock.buildDepositDraft).toHaveBeenCalledWith(
      "+639171234567",
      "1",
      {
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        symbol: "USDC",
        decimals: 6,
      },
    );
    expect(phoneEscrowMock.recordDepositIntent).toHaveBeenCalledWith(expect.objectContaining({
      senderId: "sender-1",
      phone: "+639171234567",
      amount: "1",
    }));
    expect(sendCallsMock).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("builds a BASEMATE escrow link for a phone-only saved contact", async () => {
    hasEmbeddedStore.add("sender-1");
    missingEmbeddedStore.add("+919876543210");
    vi.spyOn(ContactsAdapter, "resolveWallet").mockResolvedValue(null);
    vi.spyOn(ContactsAdapter, "findByName").mockResolvedValue({
      id: 1,
      name: "Bonu",
      contact_owner: "sender-1",
      contact: null,
      contact_phone: "+919876543210",
      created_at: new Date(),
      updated_at: new Date(),
    });
    const handler = createImessageHandler(
      { respond: vi.fn() } as never,
      sendIntentEngine("BASEMATE", "10000") as never,
    );

    const prompt = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "send 10000 BASEMATE to Bonu with message Welcome",
    });
    expect(renderChunks(prompt)).toContain("10000 BASEMATE");
    expect(renderChunks(prompt)).toContain("+919876543210");

    const link = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "yes",
    });
    expect(renderChunks(link)).toContain("Send 10000 BASEMATE for Bonu to claim");
    expect(pendingPayCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ transferMemo: "Welcome" }),
    );
    expect(phoneEscrowMock.buildDepositDraft).toHaveBeenCalledWith(
      "+919876543210",
      "10000",
      {
        address: "0x07E61D8a4e197dfC269e90D7ECe1dF0D26702bA3",
        symbol: "BASEMATE",
        decimals: 18,
      },
    );
  });

  it("rejects an unresolved token before creating phone escrow state", async () => {
    missingEmbeddedStore.add("+919876543210");
    vi.spyOn(ContactsAdapter, "resolveWallet").mockResolvedValue(null);
    vi.spyOn(ContactsAdapter, "findByName").mockResolvedValue({
      id: 1,
      name: "Bonu",
      contact_owner: "sender-1",
      contact: null,
      contact_phone: "+919876543210",
      created_at: new Date(),
      updated_at: new Date(),
    });
    const handler = createImessageHandler(
      { respond: vi.fn() } as never,
      sendIntentEngine("UNKNOWN", "10") as never,
    );

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "send 10 UNKNOWN to Bonu",
    });
    expect(renderChunks(chunks)).toContain("couldn't find UNKNOWN as a token on Base");
    expect(phoneEscrowMock.buildDepositDraft).not.toHaveBeenCalled();
  });

  it("keeps native ETH on the direct-send path", async () => {
    missingEmbeddedStore.add("+919876543210");
    vi.spyOn(ContactsAdapter, "resolveWallet").mockResolvedValue(null);
    vi.spyOn(ContactsAdapter, "findByName").mockResolvedValue({
      id: 1,
      name: "Bonu",
      contact_owner: "sender-1",
      contact: null,
      contact_phone: "+919876543210",
      created_at: new Date(),
      updated_at: new Date(),
    });
    const handler = createImessageHandler(
      { respond: vi.fn() } as never,
      sendIntentEngine("ETH", "0.01") as never,
    );

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "send 0.01 ETH to Bonu",
    });
    expect(renderChunks(chunks)).toContain("not ETH");
    expect(renderChunks(chunks)).toContain("send ETH directly");
    expect(phoneEscrowMock.buildDepositDraft).not.toHaveBeenCalled();
  });

  it("prompts to connect a Basemate account when escrowing with no embedded wallet", async () => {
    missingEmbeddedStore.add("sender-1");
    vi.spyOn(ContactsAdapter, "resolveWallet").mockResolvedValue(null);
    vi.spyOn(ContactsAdapter, "findByName").mockResolvedValue({
      id: 1,
      name: "Manila",
      contact_owner: "sender-1",
      contact: null,
      contact_phone: "+639171234567",
      created_at: new Date(),
      updated_at: new Date(),
    });
    const ai = { respond: vi.fn() };
    const handler = createImessageHandler(ai as never, sendIntentEngine() as never);

    const prompt = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "send $1 usdc to manila",
    });
    expect(renderChunks(prompt)).toContain("set up your Basemate account");
    expect(renderChunks(prompt)).toContain("https://basemate.app/wallet/connect?s=setup-token");
    expect(phoneEscrowMock.buildDepositDraft).not.toHaveBeenCalled();
  });


  it("treats unknown bare recipient names as missing contacts, not basenames", async () => {
    vi.spyOn(ContactsAdapter, "resolveWallet").mockResolvedValue(null);
    vi.spyOn(ContactsAdapter, "findByName").mockResolvedValue(null);
    const ai = {
      respond: vi.fn(async () => ({ type: "text", text: "should not route through AI" })),
    };
    const handler = createImessageHandler(ai as never, sendIntentEngine() as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "send $5 to mom",
    });

    expect(chunks.join("\n")).toContain('i don\'t have "mom" saved in your contacts');
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("falls through to basename resolution for full .base.eth recipients", async () => {
    vi.spyOn(ContactsAdapter, "resolveWallet").mockResolvedValue(null);
    vi.spyOn(ContactsAdapter, "findByName").mockResolvedValue(null);
    const ai = {
      respond: vi.fn(async () => ({ type: "text", text: "normal resolver response" })),
    };
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "discovery",
        action: "send_token",
        walletScope: "unknown",
        direction: "unknown",
        assets: ["USDC"],
        amounts: [{ asset: "USDC", amount: "1", amountUsd: null, all: false }],
        targetAddress: null,
        targetName: "jesse.base.eth",
        leaderboardCategory: null,
        confidence: 0.8,
      })),
    };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "send $1 usdc to jesse.base.eth",
    });

    expect(chunks.join("\n")).not.toContain("share their contact card");
    expect(ai.respond).toHaveBeenCalledWith(
      "send $1 usdc to jesse.base.eth",
      expect.any(Object),
    );
  });
});

describe("createImessageHandler display-name collection", () => {
  beforeEach(() => {
    __clearConversationStateForTests();
    displayNameStore.clear();
    missingDisplayNames.clear();
    missingDisplayNames.add("+15550001111");
  });

  it("never asks for a name on a greeting — routes straight to the brain", async () => {
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "discovery",
        action: "discovery",
        walletScope: "unknown",
        direction: "unknown",
        assets: [],
        amounts: [],
        targetAddress: null,
        targetName: null,
        leaderboardCategory: null,
        confidence: 0.9,
      })),
    };
    const ai = { respond: vi.fn(async () => ({ type: "text", text: "gm gm!!" })) };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const out = await handler.handleInboundText({
      senderId: "+15550001111",
      conversationId: "+15550001111",
      text: "gm",
    });

    // No upfront name ask (privacy); the greeting reaches the AI brain.
    expect(renderChunks(out)).not.toContain("what should I call you?");
    expect(ai.respond).toHaveBeenCalled();
    expect(displayNameStore.has("+15550001111")).toBe(false);
  });

  it("does not interrupt a transactional command with a name prompt", async () => {
    const intentEngine = {
      classify: vi.fn(async () => ({
        domain: "wallet",
        action: "send_token",
        walletScope: "unknown",
        direction: "unknown",
        assets: ["USDC"],
        amounts: [{ asset: "USDC", amount: "1", amountUsd: null, all: false }],
        targetAddress: null,
        targetName: "Manila",
        leaderboardCategory: null,
        confidence: 0.9,
      })),
    };
    vi.spyOn(ContactsAdapter, "resolveWallet").mockResolvedValue(null);
    vi.spyOn(ContactsAdapter, "findByName").mockResolvedValue(null);
    const handler = createImessageHandler({ respond: vi.fn() } as never, intentEngine as never);

    const result = await handler.handleInboundText({
      senderId: "+15550001111",
      conversationId: "+15550001111",
      text: "send 1 USDC to Manila",
    });

    expect(renderChunks(result)).toContain(`i don't have "Manila" saved`);
    expect(renderChunks(result)).not.toContain("what should I call you?");
    expect(displayNameStore.has("+15550001111")).toBe(false);
  });
});

describe("createImessageHandler chat contact saving", () => {
  const savedContacts = (ContactsAdapter as unknown as {
    __saved: Array<{ ownerSenderId: string; name: string; phone?: string }>;
  }).__saved;

  beforeEach(() => {
    __clearConversationStateForTests();
    savedContacts.length = 0;
  });

  it('confirms a "Name: +number" contact before saving, then saves on YES', async () => {
    const ai = { respond: vi.fn() };
    const intentEngine = { classify: vi.fn() };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    // Verify-on-add: propose first, don't save yet.
    const prompt = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "Manila: +63 917 123 4567",
    });
    expect(prompt).toHaveLength(1);
    expect(String(prompt[0]).toLowerCase()).toContain("reply yes");
    expect(String(prompt[0])).toContain("+639171234567");
    expect(savedContacts).toHaveLength(0);

    // Confirming saves it (still no LLM).
    const saved = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "yes",
    });
    expect(savedContacts).toEqual([
      { ownerSenderId: "sender-1", name: "Manila", phone: "+639171234567" },
    ]);
    expect(String(saved[0])).toContain("saved Manila (+639171234567)");
    expect(intentEngine.classify).not.toHaveBeenCalled();
    expect(ai.respond).not.toHaveBeenCalled();
  });

  it("asks for a name on a bare number, then confirms before saving", async () => {
    const ai = { respond: vi.fn() };
    const intentEngine = { classify: vi.fn() };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const ask = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "+639171234567",
    });
    expect(ask).toHaveLength(1);
    expect(String(ask[0])).toContain("what name should i save +639171234567 under?");
    expect(savedContacts).toHaveLength(0);

    // Giving a name proposes the save (verify-on-add) — not an instant write.
    const prompt = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "Manila",
    });
    expect(String(prompt[0]).toLowerCase()).toContain("reply yes");
    expect(savedContacts).toHaveLength(0);

    const saved = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "yes",
    });
    expect(savedContacts).toEqual([
      { ownerSenderId: "sender-1", name: "Manila", phone: "+639171234567" },
    ]);
    expect(String(saved[0])).toContain("saved Manila (+639171234567)");
    expect(intentEngine.classify).not.toHaveBeenCalled();
  });

  it("nudges for a country code when the number doesn't have one", async () => {
    const ai = { respond: vi.fn() };
    const intentEngine = { classify: vi.fn() };
    const handler = createImessageHandler(ai as never, intentEngine as never);

    const chunks = await handler.handleInboundText({
      senderId: "sender-1",
      conversationId: "sender-1",
      text: "Manila: 9171234567",
    });

    expect(savedContacts).toHaveLength(0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("country code");
    expect(ai.respond).not.toHaveBeenCalled();
  });
});
