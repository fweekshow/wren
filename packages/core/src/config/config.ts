import "@/load-env.js";
import process from "node:process";

const requireEnv = (name: string, value?: string): string => {
  if (!value) throw new Error(`${name} is required in .env`);
  return value;
};

const telegramOnly = process.env.TELEGRAM_ONLY === "true" || process.env.TELEGRAM_ONLY === "1";
const imessageOnly = process.env.IMESSAGE_ONLY === "true" || process.env.IMESSAGE_ONLY === "1";
const whatsappOnly = process.env.WHATSAPP_ONLY === "true" || process.env.WHATSAPP_ONLY === "1";
/** Apps that never start XMTP (Telegram, iMessage, WhatsApp) must not require XMTP keys. */
const skipXmtpKeys = telegramOnly || imessageOnly || whatsappOnly;

const normalizeExpressPath = (name: string, value: string | undefined, fallback: string): string => {
  const raw = value?.trim();
  if (!raw) return fallback;

  if (/^https?:\/\//i.test(raw)) {
    try {
      const pathname = new URL(raw).pathname;
      const normalized = pathname && pathname !== "/" ? pathname : fallback;
      console.warn(`${name} must be an Express path, not a full URL. Using ${normalized}.`);
      return normalized;
    } catch {
      console.warn(`${name} is not a valid Express path. Using ${fallback}.`);
      return fallback;
    }
  }

  return raw.startsWith("/") ? raw : `/${raw}`;
};

interface Config {
  env: string;
  databaseUrl: string;
  xmtp: {
    walletKey: string;
    dbEncryptionKey: string;
    env: string;
    volumeMountPath: string;
  };
  llm: {
    apiKey: string;
    baseUrl: string;
    defaultModel: string;
  };
  google: {
    placesApiKey?: string;
  };
  email: {
    enabled: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUser: string;
    smtpPass: string;
    from: string;
  };
  telegram: {
    botToken: string;
    webhookUrl: string;
    webhookPort: number;
    /** Secret echoed by Telegram in X-Telegram-Bot-Api-Secret-Token; fail-closed in prod. */
    webhookSecret: string;
    /** Express path to mount the authenticated Telegram webhook receiver on. */
    webhookPath: string;
    /** Master switch for the VibeTrading Telegram channel. */
    enabled: boolean;
  };
  spectrum: {
    projectId: string;
    projectSecret: string;
    /** HMAC-SHA256 signing secret returned once at webhook registration time. */
    signingSecret: string;
    /** Express path to mount the Spectrum webhook receiver on. */
    webhookPath: string;
  };
  whatsapp: {
    accessToken: string;
    phoneNumberId: string;
    appSecret: string;
    requestTimeoutMs: number;
    cursorKey: string;
  };
  imessageMiniApp: {
    appName: string;
    teamId: string;
    extensionBundleId: string;
    appStoreId?: number;
  };
  imessageBackgrounds: {
    /** Low-level Advanced iMessage server address in host:port form. */
    address: string;
    /** Bearer token for the low-level Advanced iMessage server. */
    token: string;
    /** Local image path for trading/perps/yield chat mode. */
    tradingPath: string;
    /** Local image path for money movement/ramp/contact-send chat mode. */
    moneyPath: string;
  };
  /**
   * Definitive Flash — advanced spot orders (limit / stop / TWAP / …) on Base.
   * Optional: when apiKey is empty, Flash tools stay disabled.
   */
  flash: {
    apiKey: string;
    enabled: boolean;
    /** Integrator fee in bps as string (e.g. "50" = 0.50%). Omitted when empty. */
    integratorFeeBps: string;
    /** Optional Base builder-code attribution on POST /order only. */
    attributionCode: string;
  };
  /**
   * Coinbase Developer Platform (CDP) — custodial server wallets + onramp/offramp.
   * Used by the iMessage bot to provision and operate a Base wallet per user.
   */
  cdp: {
    apiKeyId: string;
    apiKeySecret: string;
    /** Wallet Secret — required for signing/transfers on API-key (server) wallets. */
    walletSecret: string;
    /** True only when all CDP credentials are present (gates the custodial wallet feature). */
    enabled: boolean;
    /** True when API credentials are present for Onramp/Offramp session and status APIs. */
    paymentsEnabled: boolean;
    /** Where Coinbase redirects users after a successful onramp/offramp (must be on your CDP domain allowlist in prod). */
    onrampRedirectUrl: string;
    /** Basemate page Coinbase redirects to after an Offramp order is configured. */
    offrampRedirectUrl: string;
    /** Exact browser origin allowed to call capability-token payment APIs. */
    payPageOrigin: string;
    /** Fallback client IP for the onramp session token (iMessage exposes no end-user IP). */
    onrampClientIpFallback: string;
    /** URL of the headless Apple Pay fund page (basemate-metrics /pay). */
    fundPageUrl: string;
    /** Domain passed to Coinbase headless onramp API for iframe allowlisting. */
    fundPageDomain: string;
    /** If true, use sandbox partnerUserRef prefix and mock Apple Pay sheet. */
    onrampSandbox: boolean;
    /** Headless Onramp API key — sandbox key in dev, production key in prod. */
    onrampApiKeyId: string;
    onrampApiKeySecret: string;
    /** Optional shared secret for POST /api/webhooks/coinbase-onramp (set in CDP portal). */
    onrampWebhookSecret: string;
  };
  phoneEscrow: {
    /** Base contract that holds USDC against salted phone-number hashes. */
    contractAddress: string;
    /** Server-only salt used before hashing normalized E.164 phone numbers. */
    phoneHashSalt: string;
    /** Private key for the release operator. Required only when releasing funds. */
    operatorPrivateKey: string;
    /** True only when the contract address and hash salt are present. */
    enabled: boolean;
    /** True only when the backend can submit release transactions. */
    releaseEnabled: boolean;
    /** Hours a recipient has to claim before funds return to the sender. */
    claimTtlHours: number;
    /** True when the backend can submit refund transactions (same operator key). */
    refundEnabled: boolean;
  };
  mentionHandle: string;
  timezone: string;
  payPage: {
    /** Base origin for the sign page, e.g. https://basemate.app. */
    origin: string;
  };
  /** Redis connection string used by shared runtime queues and strategy warmup state. */
  redisUrl: string;
  /** Partner Muse stock-send API (Apple Pay → phone claim). */
  muse: {
    apiKeys: string[];
    /** Existing Basemate CDP / inbox sender — never a raw Muse user id. */
    senderId: string;
    maxUsd: number;
  };
}

const cdpApiKeyId = process.env.CDP_API_KEY_ID?.trim() || "";
// Strip surrounding double-quotes that Railway sometimes stores literally when pasting values.
const cdpApiKeySecret = process.env.CDP_API_KEY_SECRET?.trim().replace(/^"|"$/g, "") || "";
const cdpWalletSecret = process.env.CDP_WALLET_SECRET?.trim() || "";
const cdpOnrampSandbox =
  process.env.CDP_ONRAMP_SANDBOX === "true" || process.env.CDP_ONRAMP_SANDBOX === "1";
const cdpOnrampApiKeyId =
  process.env.CDP_ONRAMP_API_KEY_ID?.trim() ||
  cdpApiKeyId;
const cdpOnrampApiKeySecret =
  process.env.CDP_ONRAMP_API_KEY_SECRET?.trim().replace(/^"|"$/g, "") ||
  cdpApiKeySecret;
const cdpOnrampSandboxApiKeyId =
  process.env.CDP_ONRAMP_SANDBOX_API_KEY_ID?.trim() ||
  cdpOnrampApiKeyId;
const cdpOnrampSandboxApiKeySecret =
  process.env.CDP_ONRAMP_SANDBOX_API_KEY_SECRET?.trim().replace(/^"|"$/g, "") ||
  cdpOnrampApiKeySecret;
const phoneEscrowOperatorPrivateKey =
  process.env.PHONE_ESCROW_OPERATOR_PRIVATE_KEY?.trim() || process.env.PRIVATE_KEY?.trim() || "";
const smtpHost = process.env.SMTP_HOST?.trim() || "";
const smtpUser = process.env.SMTP_USER?.trim() || "";
const smtpPass = process.env.SMTP_PASS?.trim() || "";
const smtpFrom = process.env.SMTP_FROM?.trim() || "";
const smtpPort = Number.parseInt(process.env.SMTP_PORT?.trim() || "587", 10);
const cdpFundPageUrl = process.env.CDP_FUND_PAGE_URL?.trim() || "https://basemate.app/pay";
const cdpFundPageDomain =
  process.env.CDP_FUND_PAGE_DOMAIN?.trim() ||
  (() => {
    try {
      return new URL(cdpFundPageUrl).hostname;
    } catch {
      return "basemate.app";
    }
  })();
const imessageMiniAppStoreId = Number.parseInt(
  process.env.IMESSAGE_MINIAPP_APP_STORE_ID?.trim() || "",
  10,
);
const whatsappRequestTimeoutMs = Number.parseInt(
  process.env.WHATSAPP_REQUEST_TIMEOUT_MS?.trim() || "20000",
  10,
);

export const config: Config = {
  env: process.env.NODE_ENV ?? "development",
  databaseUrl: requireEnv("DATABASE_URL", process.env.DATABASE_URL),
  xmtp: {
    walletKey: skipXmtpKeys
      ? (process.env.XMTP_WALLET_KEY || process.env.WALLET_KEY || "").trim()
      : requireEnv("WALLET_KEY", (process.env.XMTP_WALLET_KEY || process.env.WALLET_KEY)?.trim()),
    dbEncryptionKey: skipXmtpKeys
      ? (process.env.XMTP_DB_ENCRYPTION_KEY || process.env.DB_ENCRYPTION_KEY || "").trim()
      : requireEnv(
          "DB_ENCRYPTION_KEY",
          (process.env.XMTP_DB_ENCRYPTION_KEY || process.env.DB_ENCRYPTION_KEY)?.trim(),
        ),
    env: process.env.XMTP_ENV?.trim() || "dev",
    volumeMountPath:
      process.env.XMTP_VOLUME_MOUNT_PATH ||
      process.env.RAILWAY_VOLUME_MOUNT_PATH ||
      "./.data/xmtp",
  },
  llm: {
    apiKey: requireEnv("BANKR_LLM_API_KEY", process.env.BANKR_LLM_API_KEY?.trim()),
    baseUrl: process.env.BANKR_LLM_BASE_URL?.trim().replace(/\/$/, "") || "https://llm.bankr.bot/v1",
    defaultModel: process.env.DEFAULT_MODEL?.trim() || "gpt-5.4-mini",
  },
  google: {
    placesApiKey: process.env.GOOGLE_PLACES_API_KEY?.trim(),
  },
  email: {
    enabled: Boolean(smtpHost && smtpUser && smtpPass && smtpFrom),
    smtpHost,
    smtpPort: Number.isFinite(smtpPort) ? smtpPort : 587,
    smtpSecure: process.env.SMTP_SECURE
      ? process.env.SMTP_SECURE === "true" || process.env.SMTP_SECURE === "1"
      : smtpPort === 465,
    smtpUser,
    smtpPass,
    from: smtpFrom,
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || "",
    webhookUrl: process.env.TELEGRAM_WEBHOOK_URL?.trim() || "",
    webhookPort: parseInt(process.env.PORT || "3000", 10),
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || "",
    webhookPath: normalizeExpressPath(
      "TELEGRAM_WEBHOOK_PATH",
      process.env.TELEGRAM_WEBHOOK_PATH,
      "/telegram-webhook",
    ),
    enabled: false,
  },
  spectrum: {
    projectId: process.env.PHOTON_PROJECT_ID?.trim() || "",
    projectSecret: process.env.PHOTON_PROJECT_SECRET?.trim() || "",
    signingSecret: process.env.SPECTRUM_SIGNING_SECRET?.trim() || "",
    webhookPath: normalizeExpressPath(
      "SPECTRUM_WEBHOOK_PATH",
      process.env.SPECTRUM_WEBHOOK_PATH,
      "/spectrum-webhook",
    ),
  },
  whatsapp: {
    accessToken:
      process.env.WHATSAPP_ACCESS_TOKEN?.trim() ||
      process.env.WA_ACCESS_TOKEN?.trim() ||
      "",
    phoneNumberId:
      process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() ||
      process.env.WA_PHONE_NUMBER_ID?.trim() ||
      "",
    appSecret:
      process.env.WHATSAPP_APP_SECRET?.trim() ||
      process.env.WA_APP_SECRET?.trim() ||
      "",
    requestTimeoutMs: Number.isFinite(whatsappRequestTimeoutMs)
      ? whatsappRequestTimeoutMs
      : 20_000,
    cursorKey: process.env.WHATSAPP_CURSOR_KEY?.trim() || "whatsapp:events",
  },
  imessageMiniApp: {
    appName: process.env.IMESSAGE_MINIAPP_APP_NAME?.trim() || "Basemate",
    teamId: process.env.IMESSAGE_MINIAPP_TEAM_ID?.trim() || "",
    extensionBundleId: process.env.IMESSAGE_MINIAPP_EXTENSION_BUNDLE_ID?.trim() || "",
    appStoreId: Number.isFinite(imessageMiniAppStoreId) ? imessageMiniAppStoreId : undefined,
  },
  imessageBackgrounds: {
    address: process.env.IMESSAGE_ADVANCED_ADDRESS?.trim() || "",
    token:
      process.env.IMESSAGE_ADVANCED_TOKEN?.trim() ||
      process.env.IMESSAGE_TOKEN?.trim() ||
      "",
    tradingPath: process.env.IMESSAGE_TRADING_BACKGROUND_PATH?.trim() || "",
    moneyPath: process.env.IMESSAGE_MONEY_BACKGROUND_PATH?.trim() || "",
  },
  flash: {
    apiKey: process.env.FLASH_API_KEY?.trim() || "",
    enabled: Boolean(process.env.FLASH_API_KEY?.trim()),
    integratorFeeBps: process.env.FLASH_INTEGRATOR_FEE_BPS?.trim() || "",
    attributionCode: process.env.FLASH_ATTRIBUTION_CODE?.trim() || "",
  },
  cdp: {
    apiKeyId: cdpApiKeyId,
    apiKeySecret: cdpApiKeySecret,
    walletSecret: cdpWalletSecret,
    enabled: Boolean(cdpApiKeyId && cdpApiKeySecret && cdpWalletSecret),
    paymentsEnabled: Boolean(cdpApiKeyId && cdpApiKeySecret),
    onrampRedirectUrl:
      process.env.CDP_ONRAMP_REDIRECT_URL?.trim() || "https://basemate.app/pay/success",
    offrampRedirectUrl:
      process.env.CDP_OFFRAMP_REDIRECT_URL?.trim() || "https://basemate.app/pay/offramp/return",
    payPageOrigin: process.env.CDP_PAY_PAGE_ORIGIN?.trim() || "https://basemate.app",
    onrampClientIpFallback: process.env.CDP_ONRAMP_CLIENT_IP?.trim() || "",
    /** URL of the headless Apple Pay fund page (basemate-metrics /pay). */
    fundPageUrl: cdpFundPageUrl,
    /** Domain passed to Coinbase headless onramp API for iframe allowlisting (CDP portal: domain allowlist + verification file on basemate.app). */
    fundPageDomain: cdpFundPageDomain,
    /** If true, use sandbox partnerUserRef prefix and mock Apple Pay. */
    onrampSandbox: cdpOnrampSandbox,
    /** Headless Onramp API key — use sandbox credentials only when sandbox mode is enabled. */
    onrampApiKeyId: cdpOnrampSandbox ? cdpOnrampSandboxApiKeyId : cdpOnrampApiKeyId,
    onrampApiKeySecret: cdpOnrampSandbox ? cdpOnrampSandboxApiKeySecret : cdpOnrampApiKeySecret,
    onrampWebhookSecret: process.env.CDP_ONRAMP_WEBHOOK_SECRET?.trim() || "",
  },
  phoneEscrow: {
    contractAddress: process.env.PHONE_ESCROW_CONTRACT_ADDRESS?.trim() || "",
    phoneHashSalt: process.env.PHONE_ESCROW_HASH_SALT?.trim() || "",
    operatorPrivateKey: phoneEscrowOperatorPrivateKey,
    enabled: Boolean(
      process.env.PHONE_ESCROW_CONTRACT_ADDRESS?.trim() &&
        process.env.PHONE_ESCROW_HASH_SALT?.trim(),
    ),
    releaseEnabled: Boolean(
      process.env.PHONE_ESCROW_CONTRACT_ADDRESS?.trim() &&
        process.env.PHONE_ESCROW_HASH_SALT?.trim() &&
        phoneEscrowOperatorPrivateKey,
    ),
    claimTtlHours: Math.max(
      1,
      Number(process.env.PHONE_ESCROW_CLAIM_TTL_HOURS ?? 72) || 72,
    ),
    refundEnabled: Boolean(
      process.env.PHONE_ESCROW_CONTRACT_ADDRESS?.trim() &&
        process.env.PHONE_ESCROW_HASH_SALT?.trim() &&
        phoneEscrowOperatorPrivateKey,
    ),
  },
  mentionHandle: process.env.MENTION_HANDLE || process.env.MENTION_HANDLES || "basemate",
  timezone: process.env.DEFAULT_TIMEZONE ?? "America/Los_Angeles",
  payPage: {
    origin: (process.env.PAY_PAGE_ORIGIN?.trim() || process.env.CDP_PAY_PAGE_ORIGIN?.trim() || "https://basemate.app").replace(/\/$/, ""),
  },
  redisUrl: process.env.REDIS_URL?.trim() || "",
  muse: {
    apiKeys: (process.env.MUSE_API_KEYS?.trim() || process.env.MUSE_API_KEY?.trim() || "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
    senderId: process.env.MUSE_SENDER_ID?.trim() || "",
    maxUsd: Math.max(1, Number(process.env.MUSE_MAX_USD ?? 500) || 500),
  },
};
