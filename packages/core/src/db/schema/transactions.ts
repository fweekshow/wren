import { bigserial, integer, numeric, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const txConfirmations = pgTable("tx_confirmations", {
  sid: text("sid").primaryKey(),
  senderId: text("sender_id").notNull(),
  fromAddress: text("from_address").notNull(),
  chainId: text("chain_id").notNull(),
  label: text("label"),
  status: text("status").notNull().default("pending"),
  txHash: text("tx_hash"),
  mcpRequestId: text("mcp_request_id"),
  approvalUrl: text("approval_url"),
  recipientPhone: text("recipient_phone"),
  transferAmount: text("transfer_amount"),
  transferAsset: text("transfer_asset"),
  transferMemo: text("transfer_memo"),
  recipientNotificationStatus: text("recipient_notification_status"),
  recipientNotificationAttempts: integer("recipient_notification_attempts").notNull().default(0),
  recipientNotificationNextAttemptAt: timestamp("recipient_notification_next_attempt_at", {
    withTimezone: true,
  }),
  recipientNotificationLastError: text("recipient_notification_last_error"),
  recipientNotificationAcceptedAt: timestamp("recipient_notification_accepted_at", {
    withTimezone: true,
  }),
  recipientClaimStatus: text("recipient_claim_status"),
  recipientClaimProcessingAt: timestamp("recipient_claim_processing_at", {
    withTimezone: true,
  }),
  recipientClaimSentAt: timestamp("recipient_claim_sent_at", {
    withTimezone: true,
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const imessagePhoneEscrows = pgTable("imessage_phone_escrows", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  senderId: text("sender_id").notNull(),
  recipientPhone: text("recipient_phone").notNull(),
  phoneHash: text("phone_hash").notNull(),
  tokenAddress: text("token_address").notNull(),
  tokenSymbol: text("token_symbol").notNull().default("USDC"),
  tokenDecimals: integer("token_decimals").notNull().default(6),
  amountAtomic: numeric("amount_atomic", { precision: 78, scale: 0 }).notNull(),
  amountDisplay: text("amount_display").notNull(),
  status: text("status").notNull().default("link_created"),
  depositTxHash: text("deposit_tx_hash"),
  releaseTxHash: text("release_tx_hash"),
  releasedTo: text("released_to"),
  senderRefundAddress: text("sender_refund_address"),
  depositConfirmedAt: timestamp("deposit_confirmed_at", { withTimezone: true }),
  claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
  refundTxHash: text("refund_tx_hash"),
  refundedAt: timestamp("refunded_at", { withTimezone: true }),
  sourceId: text("source_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const protocolVolumeLog = pgTable("protocol_volume_log", {
  id: serial("id").primaryKey(),
  inboxId: text("inbox_id").notNull(),
  protocol: text("protocol").notNull(),
  action: text("action").notNull(),
  token: text("token"),
  amountUsdc: numeric("amount_usdc"),
  txHash: text("tx_hash"),
  notionalUsdc: numeric("notional_usdc"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tokenLaunchLog = pgTable("token_launch_log", {
  id: serial("id").primaryKey(),
  walletAddress: text("wallet_address").notNull(),
  tokenSymbol: text("token_symbol"),
  tokenName: text("token_name"),
  status: text("status").notNull(),
  httpStatus: integer("http_status"),
  tokenAddress: text("token_address"),
  /** Doppler multicurve pool id (bytes32 hex) — the collectFees lookup key. */
  poolId: text("pool_id"),
  /** B20 numeraire the launch is paired against. */
  pairAddress: text("pair_address"),
  pairSymbol: text("pair_symbol"),
  txHash: text("tx_hash"),
  /** JSON snapshot of the beneficiary split at launch time. */
  beneficiaryJson: text("beneficiary_json"),
  /** Fee payout currency: "both" | "stock". Null = legacy plain multicurve. */
  feeMode: text("fee_mode"),
  /** Doppler initializer / Rehype hook that owns collectFees. Null = legacy. */
  initializer: text("initializer"),
  createdAt: timestamp("created_at").defaultNow(),
});
