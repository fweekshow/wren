import {
  boolean,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const imessageWallets = pgTable("imessage_wallets", {
  senderId: text("sender_id").primaryKey(),
  accountName: text("account_name").notNull(),
  address: text("address").notNull(),
  displayName: text("display_name"),
  /** Cached reverse ENS / basename (e.g. "aritra.base.eth"). */
  basename: text("basename"),
  firstSeenAt: timestamp("first_seen_at").defaultNow(),
  lastActiveAt: timestamp("last_active_at").defaultNow(),
  /** Retained legacy columns; embedded-only runtime code does not read or write them. */
  txPref: text("tx_pref"),
  payMode: text("pay_mode"),
  /**
   * Embedded-wallet signing mode: 'manual' (confirm every tx, default) | 'quick'
   * (auto-execute up to autoSendLimitUsd).
   */
  embeddedPayMode: text("embedded_pay_mode"),
  /** Per-transaction USD ceiling for embedded auto-execute in 'quick' mode. */
  autoSendLimitUsd: numeric("auto_send_limit_usd", { precision: 36, scale: 2 }),
  /** Opt into Alexander swear-jar auto-debit ($1 USDC per swear in armed groups). */
  swearJarOptIn: boolean("swear_jar_opt_in").default(false),
  /** CDP Embedded Wallet: end-user id, wallet address, and delegation grant for server-side signing. */
  cdpUserId: text("cdp_user_id"),
  embeddedAddress: text("embedded_address"),
  delegationId: text("delegation_id"),
  delegationExpiresAt: timestamp("delegation_expires_at", { withTimezone: true }),
  provisionedViaContact: boolean("provisioned_via_contact").default(false),
  /** Last dashboard portfolio JSON. Home reads this; chain refresh writes it. */
  portfolioSnapshot: jsonb("portfolio_snapshot"),
  portfolioSnapshotAt: timestamp("portfolio_snapshot_at", { withTimezone: true }),
  privyUserId: text("privy_user_id"),
  imessageOptedInAt: timestamp("imessage_opted_in_at", { withTimezone: true }),
  imessageService: text("imessage_service"),
  whatsappOptedInAt: timestamp("whatsapp_opted_in_at", { withTimezone: true }),
  whatsappDisplayName: text("whatsapp_display_name"),
  pushTokens: jsonb("push_tokens"),
});

/** Retained legacy table definition for schema compatibility; no active runtime uses it. */
export const baseMcpOauth = pgTable("base_mcp_oauth", {
  senderId: text("sender_id").primaryKey(),
  accountAddress: text("account_address"),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  scope: text("scope"),
  clientId: text("client_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const fundSessions = pgTable("fund_sessions", {
  token: varchar("token", { length: 32 }).primaryKey(),
  paymentLinkUrl: text("payment_link_url").notNull(),
  paymentLinkOptions: jsonb("payment_link_options"),
  userPhone: text("user_phone").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Server-side store for a transaction awaiting embedded-wallet confirmation.
 * The URL carries only the random `token`; the page reads this row from the
 * shared DB and writes back `tx_hash` / `status`.
 */
export const pendingPayTransactions = pgTable("pending_pay_transactions", {
  token: varchar("token", { length: 32 }).primaryKey(),
  senderId: text("sender_id").notNull(),
  fromAddress: text("from_address").notNull(),
  chainId: text("chain_id").notNull(),
  calls: jsonb("calls").notNull(),
  label: text("label"),
  recipientDisplay: text("recipient_display"),
  amount: text("amount"),
  tokenSymbol: text("token_symbol"),
  transferMemo: text("transfer_memo"),
  /** Active records use the embedded server-execute lane. */
  walletKind: text("wallet_kind"),
  /**
   * `calls` = wallet_sendCalls batch (default).
   * `flash` = Definitive Flash order; `flashPrepared` holds the quote snapshot.
   */
  executionKind: text("execution_kind").notNull().default("calls"),
  /** FlashPreparedOrder JSON when executionKind is flash. */
  flashPrepared: jsonb("flash_prepared"),
  /** Original chat route for receipt-gated confirmations and group copy-trade. */
  conversationId: text("conversation_id"),
  isGroup: boolean("is_group").notNull().default(false),
  deliveryPhone: text("delivery_phone"),
  copyTradeContext: jsonb("copy_trade_context"),
  status: text("status").notNull().default("pending"),
  txHash: text("tx_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/**
 * Open Definitive Flash orders awaiting a fill so we can write Activity once
 * Flash reports ORDER_STATUS_FILLED (market fills often resolve immediately;
 * limit / stop / TWAP may take longer).
 */
export const pendingFlashOrders = pgTable("pending_flash_orders", {
  orderId: text("order_id").primaryKey(),
  senderId: text("sender_id").notNull(),
  funderAddress: text("funder_address").notNull(),
  label: text("label").notNull(),
  amount: text("amount"),
  asset: text("asset"),
  /** Snapshot used to rebuild the activity row on fill. */
  prepared: jsonb("prepared").notNull(),
  status: text("status").notNull().default("open"),
  fillTxHash: text("fill_tx_hash"),
  activitySid: text("activity_sid"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const offrampSessions = pgTable(
  "offramp_sessions",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    capabilityHash: text("capability_hash").notNull(),
    platform: text("platform").notNull(),
    userKey: text("user_key").notNull(),
    sourceAddress: text("source_address").notNull(),
    partnerUserRef: varchar("partner_user_ref", { length: 50 }).notNull(),
    requestedAmount: numeric("requested_amount", { precision: 36, scale: 6 }).notNull(),
    status: text("status").notNull().default("draft"),
    coinbaseTransactionId: text("coinbase_transaction_id"),
    coinbaseStatus: text("coinbase_status"),
    sellAmount: numeric("sell_amount", { precision: 36, scale: 6 }),
    fiatTotal: numeric("fiat_total", { precision: 36, scale: 2 }),
    fiatCurrency: varchar("fiat_currency", { length: 12 }),
    coinbaseFee: numeric("coinbase_fee", { precision: 36, scale: 2 }),
    toAddress: text("to_address"),
    baseMcpRequestId: text("base_mcp_request_id"),
    baseMcpApprovalUrl: text("base_mcp_approval_url"),
    txConfirmationSid: text("tx_confirmation_sid"),
    txHash: text("tx_hash"),
    launchExpiresAt: timestamp("launch_expires_at", { withTimezone: true }).notNull(),
    transferExpiresAt: timestamp("transfer_expires_at", { withTimezone: true }),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("offramp_sessions_capability_hash_idx").on(table.capabilityHash),
    uniqueIndex("offramp_sessions_partner_user_ref_idx").on(table.partnerUserRef),
    uniqueIndex("offramp_sessions_coinbase_transaction_id_idx").on(table.coinbaseTransactionId),
  ],
);

export const onrampUserData = pgTable("onramp_user_data", {
  userPhone: text("user_phone").primaryKey(),
  email: text("email"),
  tosAcceptedAt: timestamp("tos_accepted_at", { withTimezone: true }),
  phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  pendingPhoneOtp: varchar("pending_phone_otp", { length: 6 }),
  pendingPhoneOtpExpiresAt: timestamp("pending_phone_otp_expires_at", { withTimezone: true }),
  pendingEmailOtp: varchar("pending_email_otp", { length: 6 }),
  pendingEmailOtpExpiresAt: timestamp("pending_email_otp_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
