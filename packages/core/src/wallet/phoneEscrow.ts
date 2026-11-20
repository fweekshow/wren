import type { WalletCall } from "@basemate/shared";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  http,
  isAddress,
  keccak256,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { config } from "@/config/config.js";
import { db } from "@/discovery/db.js";
import { ContactsAdapter } from "@/messaging/contacts.adapter.js";
import { logger } from "@/utils/logger.js";
import { CDP_NETWORK, getCdpClient } from "@/wallet/cdp.js";
import { ensurePhoneEscrowClaimExpiryColumns } from "@/wallet/phoneEscrow.schema.js";

export const PHONE_ESCROW_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "phoneHash", type: "bytes32" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "release",
    stateMutability: "nonpayable",
    inputs: [
      { name: "phoneHash", type: "bytes32" },
      { name: "token", type: "address" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [
      { name: "phoneHash", type: "bytes32" },
      { name: "token", type: "address" },
      { name: "sender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "balances",
    stateMutability: "view",
    inputs: [
      { name: "phoneHash", type: "bytes32" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "operators",
    stateMutability: "view",
    inputs: [{ name: "operator", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "setOperator",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "enabled", type: "bool" },
    ],
    outputs: [],
  },
] as const;

const ESCROW_OPERATOR_ACCOUNT_NAME = "phone-escrow-op";
const ESCROW_OPERATOR_SMART_NAME = "sa-phone-escrow-op";

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

type EscrowPublicClient = {
  readContract(args: {
    address: Address;
    abi: typeof PHONE_ESCROW_ABI;
    functionName: "balances" | "operators" | "owner";
    args?: readonly unknown[];
  }): Promise<unknown>;
};

let publicClient: EscrowPublicClient | null = null;
let operatorSmartReady = false;

function getPublicClient(): EscrowPublicClient {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: base,
      transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
    }) as EscrowPublicClient;
  }
  return publicClient;
}

function escrowAddress(): Address {
  if (!config.phoneEscrow.enabled || !isAddress(config.phoneEscrow.contractAddress)) {
    throw new Error("phone escrow is not configured");
  }
  return config.phoneEscrow.contractAddress as Address;
}

function operatorPrivateKeyHex(): Hex {
  if (!config.phoneEscrow.releaseEnabled && !config.phoneEscrow.refundEnabled) {
    throw new Error("phone escrow operator is not configured");
  }
  const key = config.phoneEscrow.operatorPrivateKey.startsWith("0x")
    ? config.phoneEscrow.operatorPrivateKey
    : `0x${config.phoneEscrow.operatorPrivateKey}`;
  return key as Hex;
}

function operatorAccount() {
  return privateKeyToAccount(operatorPrivateKeyHex());
}

/** CDP owner EOA (imported operator key) + smart account for paymaster-sponsored ops. */
async function getEscrowOperatorSmartAccount() {
  const cdp = getCdpClient();
  const eoa = operatorAccount();
  let owner;
  try {
    owner = await cdp.evm.getAccount({ address: eoa.address as `0x${string}` });
  } catch {
    owner = await cdp.evm.importAccount({
      privateKey: operatorPrivateKeyHex(),
      name: ESCROW_OPERATOR_ACCOUNT_NAME,
    });
  }
  const smartAccount = await cdp.evm.getOrCreateSmartAccount({
    name: ESCROW_OPERATOR_SMART_NAME,
    owner,
  });
  return { owner, smartAccount, eoaAddress: eoa.address as Address };
}

/**
 * Escrow onlyOperator allows owner EOA or operators[addr]. Sponsored userOps
 * come from the smart account — grant it once (setOperator) if needed.
 */
async function ensureEscrowSmartAccountIsOperator(): Promise<Address> {
  const { smartAccount, eoaAddress } = await getEscrowOperatorSmartAccount();
  const escrow = escrowAddress();
  const client = getPublicClient();
  const ownerOnChain = (await client.readContract({
    address: escrow,
    abi: PHONE_ESCROW_ABI,
    functionName: "owner",
  })) as Address;
  const already =
    smartAccount.address.toLowerCase() === ownerOnChain.toLowerCase() ||
    Boolean(
      await client.readContract({
        address: escrow,
        abi: PHONE_ESCROW_ABI,
        functionName: "operators",
        args: [smartAccount.address],
      }),
    );
  if (already) {
    operatorSmartReady = true;
    return smartAccount.address as Address;
  }

  // One-time grant from the owner EOA (needs a tiny bit of ETH once).
  logger.warn(
    {
      smartAccount: smartAccount.address,
      ownerEoa: eoaAddress,
      escrow,
    },
    "[phone-escrow] authorizing smart account as operator (one-time setOperator)",
  );
  try {
    const wallet = createWalletClient({
      account: operatorAccount(),
      chain: base,
      transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
    });
    const hash = await wallet.writeContract({
      address: escrow,
      abi: PHONE_ESCROW_ABI,
      functionName: "setOperator",
      args: [smartAccount.address as Address, true],
    });
    logger.info({ hash, smartAccount: smartAccount.address }, "[phone-escrow] setOperator submitted");
    operatorSmartReady = true;
    return smartAccount.address as Address;
  } catch (err) {
    throw new Error(
      `phone-escrow smart account ${smartAccount.address} is not an operator yet. ` +
        `From owner ${eoaAddress} call setOperator(${smartAccount.address}, true) once ` +
        `(needs a tiny ETH for that one tx), then allowlist the escrow contract on CDP Paymaster. ` +
        `Detail: ${(err as Error)?.message || err}`,
    );
  }
}

/** Sponsored operator call (Portal paymaster) — no ETH on the operator EOA after setOperator. */
async function sendEscrowOperatorUserOp(args: {
  functionName: "release" | "refund";
  args: readonly unknown[];
}): Promise<Hex> {
  if (!operatorSmartReady) {
    await ensureEscrowSmartAccountIsOperator();
  }
  const { smartAccount } = await getEscrowOperatorSmartAccount();
  const data = encodeFunctionData({
    abi: PHONE_ESCROW_ABI,
    functionName: args.functionName,
    args: args.args as never,
  });
  const cdp = getCdpClient();
  const userOp = await cdp.evm.sendUserOperation({
    smartAccount,
    network: CDP_NETWORK,
    calls: [
      {
        to: escrowAddress(),
        data,
        value: 0n,
      },
    ],
  });
  const receipt = await cdp.evm.waitForUserOperation({
    smartAccountAddress: smartAccount.address,
    userOpHash: userOp.userOpHash,
  });
  if (receipt.status !== "complete") {
    throw new Error(`phone-escrow user operation ${receipt.status}`);
  }
  if (!("transactionHash" in receipt) || !receipt.transactionHash) {
    throw new Error("phone-escrow user operation completed without a transaction hash");
  }
  return receipt.transactionHash as Hex;
}

/** Boot helper — log smart account address operators must allowlist / setOperator. */
export async function logPhoneEscrowOperatorSmartAccount(): Promise<void> {
  if (!config.phoneEscrow.releaseEnabled && !config.phoneEscrow.refundEnabled) return;
  try {
    const { smartAccount, eoaAddress } = await getEscrowOperatorSmartAccount();
    logger.info(
      {
        ownerEoa: eoaAddress,
        smartAccount: smartAccount.address,
        escrow: config.phoneEscrow.contractAddress,
      },
      "[phone-escrow] operator smart account ready for paymaster (allowlist escrow + setOperator if needed)",
    );
  } catch (err) {
    logger.warn({ err }, "[phone-escrow] could not resolve operator smart account at boot");
  }
}

export interface PhoneEscrowDepositDraft {
  phone: string;
  phoneHash: Hex;
  tokenAddress: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  amountAtomic: bigint;
  amount: string;
  calls: WalletCall[];
}

export interface PhoneEscrowPosition {
  phone: string;
  tokenAddress: Address;
  tokenSymbol: string;
  tokenDecimals: number;
}

export interface PhoneEscrowReleaseResult {
  phone: string;
  phoneHash: Hex;
  tokenAddress: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  amount: string;
  amountAtomic: bigint;
  transactionHash: Hex;
}

export interface PhoneEscrowDepositRow {
  id: string;
  senderId: string;
  recipientPhone: string;
  phoneHash: Hex;
  tokenAddress: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  amountAtomic: bigint;
  amountDisplay: string;
  status: string;
  senderRefundAddress: Address | null;
  depositTxHash: string | null;
  claimExpiresAt: Date | null;
}

export interface PhoneEscrowRefundResult {
  id: string;
  phone: string;
  phoneHash: Hex;
  tokenAddress: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  amount: string;
  amountAtomic: bigint;
  senderRefundAddress: Address;
  senderId: string;
  transactionHash: Hex;
}

function mapDepositRow(row: {
  id: string | number | bigint;
  sender_id: string;
  recipient_phone: string;
  phone_hash: string;
  token_address: string;
  token_symbol: string;
  token_decimals: number;
  amount_atomic: string;
  amount_display: string;
  status: string;
  sender_refund_address: string | null;
  deposit_tx_hash: string | null;
  claim_expires_at: Date | string | null;
}): PhoneEscrowDepositRow {
  return {
    id: String(row.id),
    senderId: row.sender_id,
    recipientPhone: row.recipient_phone,
    phoneHash: row.phone_hash as Hex,
    tokenAddress: row.token_address as Address,
    tokenSymbol: row.token_symbol,
    tokenDecimals: Number(row.token_decimals),
    amountAtomic: BigInt(row.amount_atomic),
    amountDisplay: row.amount_display,
    status: row.status,
    senderRefundAddress:
      row.sender_refund_address && isAddress(row.sender_refund_address)
        ? (row.sender_refund_address as Address)
        : null,
    depositTxHash: row.deposit_tx_hash,
    claimExpiresAt: row.claim_expires_at ? new Date(row.claim_expires_at) : null,
  };
}

export class PhoneEscrowAdapter {
  static async createTable(): Promise<void> {
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS imessage_phone_escrows (
          id BIGSERIAL PRIMARY KEY,
          sender_id TEXT NOT NULL,
          recipient_phone TEXT NOT NULL,
          phone_hash TEXT NOT NULL,
          token_address TEXT NOT NULL,
          token_symbol TEXT NOT NULL DEFAULT 'USDC',
          token_decimals INTEGER NOT NULL DEFAULT 6,
          amount_atomic NUMERIC(78, 0) NOT NULL,
          amount_display TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'link_created',
          deposit_tx_hash TEXT,
          release_tx_hash TEXT,
          released_to TEXT,
          sender_refund_address TEXT,
          deposit_confirmed_at TIMESTAMPTZ,
          claim_expires_at TIMESTAMPTZ,
          refund_tx_hash TEXT,
          refunded_at TIMESTAMPTZ,
          source_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_imessage_phone_escrows_hash_status
          ON imessage_phone_escrows(phone_hash, status);
        CREATE INDEX IF NOT EXISTS idx_imessage_phone_escrows_recipient_phone
          ON imessage_phone_escrows(recipient_phone);
      `);
      await db.query(`
        ALTER TABLE imessage_phone_escrows
          ADD COLUMN IF NOT EXISTS token_symbol TEXT NOT NULL DEFAULT 'USDC'
      `);
      await db.query(`
        ALTER TABLE imessage_phone_escrows
          ADD COLUMN IF NOT EXISTS token_decimals INTEGER NOT NULL DEFAULT 6
      `);
      await ensurePhoneEscrowClaimExpiryColumns();
    } catch (error) {
      console.error("Error creating imessage_phone_escrows table:", error);
      throw error;
    }
  }

  static normalizePhone(phone: string): string {
    const normalized = ContactsAdapter.normalizeHandle(phone);
    if (!normalized) {
      throw new Error("phone number must be normalized E.164");
    }
    return normalized;
  }

  static phoneHash(phone: string): Hex {
    const normalized = this.normalizePhone(phone);
    if (!config.phoneEscrow.phoneHashSalt) {
      throw new Error("PHONE_ESCROW_HASH_SALT is required");
    }
    return keccak256(toHex(`${config.phoneEscrow.phoneHashSalt}:${normalized}`));
  }

  static buildDepositDraft(
    phone: string,
    amount: string,
    token: { address: string; symbol: string; decimals: number },
  ): PhoneEscrowDepositDraft {
    const normalized = this.normalizePhone(phone);
    const phoneHash = this.phoneHash(normalized);
    if (!isAddress(token.address)) {
      throw new Error(`invalid escrow token address: ${token.address}`);
    }
    if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255) {
      throw new Error(`invalid escrow token decimals: ${token.decimals}`);
    }
    const tokenAddress = token.address as Address;
    const tokenSymbol = token.symbol.trim();
    if (!tokenSymbol) throw new Error("escrow token symbol is required");
    const amountAtomic = parseUnits(amount, token.decimals);
    if (amountAtomic <= 0n) {
      throw new Error("escrow amount must be greater than 0");
    }

    const escrow = escrowAddress();
    const calls: WalletCall[] = [
      {
        to: tokenAddress,
        data: encodeFunctionData({
          abi: ERC20_APPROVE_ABI,
          functionName: "approve",
          args: [escrow, amountAtomic],
        }),
        value: "0x0",
        metadata: {
          description: `Approve ${amount} ${tokenSymbol} so they can claim`,
          transactionType: "approve",
        },
      },
      {
        to: escrow,
        data: encodeFunctionData({
          abi: PHONE_ESCROW_ABI,
          functionName: "deposit",
          args: [phoneHash, tokenAddress, amountAtomic],
        }),
        value: "0x0",
        metadata: {
          description: `Send ${amount} ${tokenSymbol} for them to claim (72h)`,
          transactionType: "escrow_deposit",
        },
      },
    ];

    return {
      phone: normalized,
      phoneHash,
      tokenAddress,
      tokenSymbol,
      tokenDecimals: token.decimals,
      amountAtomic,
      amount,
      calls,
    };
  }

  static async recordDepositIntent(params: {
    senderId: string;
    phone: string;
    phoneHash: Hex;
    tokenAddress: Address;
    tokenSymbol: string;
    tokenDecimals: number;
    amountAtomic: bigint;
    amount: string;
    sourceId?: string | null;
  }): Promise<"inserted" | "duplicate"> {
    const sourceId = params.sourceId?.trim() || null;
    if (sourceId) {
      const dup = await db.query(
        `SELECT id FROM imessage_phone_escrows
          WHERE sender_id = $1 AND source_id = $2 LIMIT 1`,
        [params.senderId, sourceId],
      );
      if ((dup.rowCount ?? 0) > 0) return "duplicate";
      await db.query(
        `INSERT INTO imessage_phone_escrows
          (sender_id, recipient_phone, phone_hash, token_address, token_symbol,
           token_decimals, amount_atomic, amount_display, source_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          params.senderId,
          this.normalizePhone(params.phone),
          params.phoneHash,
          params.tokenAddress.toLowerCase(),
          params.tokenSymbol,
          params.tokenDecimals,
          params.amountAtomic.toString(),
          params.amount,
          sourceId,
        ],
      );
      return "inserted";
    }
    await db.query(
      `INSERT INTO imessage_phone_escrows
        (sender_id, recipient_phone, phone_hash, token_address, token_symbol,
         token_decimals, amount_atomic, amount_display)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        params.senderId,
        this.normalizePhone(params.phone),
        params.phoneHash,
        params.tokenAddress.toLowerCase(),
        params.tokenSymbol,
        params.tokenDecimals,
        params.amountAtomic.toString(),
        params.amount,
      ],
    );
    return "inserted";
  }

  /** Batch lookup escrows for dashboard claim pills (by on-chain deposit tx). */
  static async listByDepositTxHashes(
    senderId: string,
    txHashes: string[],
  ): Promise<
    Array<{
      depositTxHash: string;
      status: string;
      claimExpiresAt: Date | null;
      recipientPhone: string;
    }>
  > {
    const hashes = [...new Set(txHashes.map((h) => h.trim().toLowerCase()).filter(Boolean))];
    if (!hashes.length) return [];
    const result = await db.query<{
      deposit_tx_hash: string;
      status: string;
      claim_expires_at: Date | string | null;
      recipient_phone: string;
    }>(
      `SELECT deposit_tx_hash, status, claim_expires_at, recipient_phone
         FROM imessage_phone_escrows
        WHERE sender_id = $1
          AND deposit_tx_hash = ANY($2::text[])`,
      [senderId, hashes],
    );
    return result.rows.map((r) => ({
      depositTxHash: r.deposit_tx_hash.toLowerCase(),
      status: r.status,
      claimExpiresAt: r.claim_expires_at ? new Date(r.claim_expires_at) : null,
      recipientPhone: r.recipient_phone,
    }));
  }

  /**
   * Mark a previously recorded deposit intent as confirmed on-chain and start
   * the claim TTL clock. Idempotent when the same deposit_tx_hash is already set.
   */
  static async confirmDeposit(params: {
    senderId: string;
    recipientPhone: string;
    depositTxHash: string;
    senderRefundAddress: string;
    amountDisplay?: string | null;
    tokenSymbol?: string | null;
    tokenAddress?: string | null;
    amountAtomic?: string | bigint | null;
  }): Promise<PhoneEscrowDepositRow | null> {
    if (!params.depositTxHash?.trim()) return null;
    if (!isAddress(params.senderRefundAddress)) {
      throw new Error(`invalid sender refund address: ${params.senderRefundAddress}`);
    }

    const phone = this.normalizePhone(params.recipientPhone);
    const existing = await db.query<{
      id: string | number | bigint;
      sender_id: string;
      recipient_phone: string;
      phone_hash: string;
      token_address: string;
      token_symbol: string;
      token_decimals: number;
      amount_atomic: string;
      amount_display: string;
      status: string;
      sender_refund_address: string | null;
      deposit_tx_hash: string | null;
      claim_expires_at: Date | string | null;
    }>(
      `SELECT id, sender_id, recipient_phone, phone_hash, token_address, token_symbol,
              token_decimals, amount_atomic::text AS amount_atomic, amount_display, status,
              sender_refund_address, deposit_tx_hash, claim_expires_at
         FROM imessage_phone_escrows
        WHERE deposit_tx_hash = $1
        LIMIT 1`,
      [params.depositTxHash],
    );
    if (existing.rows[0]) {
      return mapDepositRow(existing.rows[0]);
    }

    const ttlHours = config.phoneEscrow.claimTtlHours;
    const result = await db.query<{
      id: string | number | bigint;
      sender_id: string;
      recipient_phone: string;
      phone_hash: string;
      token_address: string;
      token_symbol: string;
      token_decimals: number;
      amount_atomic: string;
      amount_display: string;
      status: string;
      sender_refund_address: string | null;
      deposit_tx_hash: string | null;
      claim_expires_at: Date | string | null;
    }>(
      `UPDATE imessage_phone_escrows
          SET status = 'deposited',
              deposit_tx_hash = $1,
              sender_refund_address = $2,
              deposit_confirmed_at = NOW(),
              claim_expires_at = NOW() + make_interval(hours => $3),
              updated_at = NOW()
        WHERE id = (
          SELECT id FROM imessage_phone_escrows
           WHERE sender_id = $4
             AND recipient_phone = $5
             AND status = 'link_created'
             AND ($6::text IS NULL OR amount_display = $6)
             AND ($7::text IS NULL OR upper(token_symbol) = upper($7))
             AND ($8::text IS NULL OR lower(token_address) = lower($8))
             AND ($9::text IS NULL OR amount_atomic::text = $9)
           ORDER BY created_at DESC
           LIMIT 1
        )
        RETURNING id, sender_id, recipient_phone, phone_hash, token_address, token_symbol,
                  token_decimals, amount_atomic::text AS amount_atomic, amount_display, status,
                  sender_refund_address, deposit_tx_hash, claim_expires_at`,
      [
        params.depositTxHash,
        params.senderRefundAddress.toLowerCase(),
        ttlHours,
        params.senderId,
        phone,
        params.amountDisplay?.trim() || null,
        params.tokenSymbol?.trim() || null,
        params.tokenAddress?.trim() || null,
        params.amountAtomic != null ? String(params.amountAtomic) : null,
      ],
    );
    const row = result.rows[0];
    return row ? mapDepositRow(row) : null;
  }

  /** Mark a pre-deposit intent cancelled when the user tx fails/reverts. */
  static async cancelDepositIntent(params: {
    senderId: string;
    recipientPhone: string;
    amountDisplay?: string | null;
    tokenSymbol?: string | null;
  }): Promise<boolean> {
    const phone = this.normalizePhone(params.recipientPhone);
    const result = await db.query(
      `UPDATE imessage_phone_escrows
          SET status = 'cancelled', updated_at = NOW()
        WHERE id = (
          SELECT id FROM imessage_phone_escrows
           WHERE sender_id = $1
             AND recipient_phone = $2
             AND status = 'link_created'
             AND ($3::text IS NULL OR amount_display = $3)
             AND ($4::text IS NULL OR upper(token_symbol) = upper($4))
           ORDER BY created_at DESC
           LIMIT 1
        )`,
      [
        params.senderId,
        phone,
        params.amountDisplay?.trim() || null,
        params.tokenSymbol?.trim() || null,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Distinct phone/token positions that haven't been released yet, newest-first
   * and age-bounded so we don't poll abandoned rows forever.
   * Only includes deposited (confirmed) rows — not unconfirmed intents or refunds.
   */
  static async listUnreleasedPositions(opts?: {
    maxAgeDays?: number;
    limit?: number;
    recipientPhone?: string;
  }): Promise<PhoneEscrowPosition[]> {
    const maxAgeDays = opts?.maxAgeDays ?? 30;
    const limit = opts?.limit ?? 100;
    const recipientPhone = opts?.recipientPhone
      ? this.normalizePhone(opts.recipientPhone)
      : null;
    const result = await db.query<{
      recipient_phone: string;
      token_address: string;
      token_symbol: string;
      token_decimals: number;
    }>(
      `SELECT recipient_phone, token_address, token_symbol, token_decimals,
              MAX(created_at) AS latest
         FROM imessage_phone_escrows
        WHERE status IN ('deposited', 'releasing', 'link_created')
          AND created_at > NOW() - make_interval(days => $1)
          AND ($3::text IS NULL OR recipient_phone = $3)
        GROUP BY recipient_phone, token_address, token_symbol, token_decimals
        ORDER BY latest DESC
        LIMIT $2`,
      [maxAgeDays, limit, recipientPhone],
    );
    return result.rows
      .filter((r) => isAddress(r.token_address))
      .map((r) => ({
        phone: r.recipient_phone,
        tokenAddress: r.token_address as Address,
        tokenSymbol: r.token_symbol,
        tokenDecimals: Number(r.token_decimals),
      }));
  }

  /**
   * Lock deposited rows for release (`releasing`). Returns true only for the
   * caller that won the transition. Excludes refunded/refunding rows.
   */
  static async claimForRelease(position: PhoneEscrowPosition): Promise<boolean> {
    const result = await db.query(
      `UPDATE imessage_phone_escrows
          SET status = 'releasing', updated_at = NOW()
        WHERE recipient_phone = $1
          AND lower(token_address) = lower($2)
          AND status IN ('deposited', 'link_created')`,
      [this.normalizePhone(position.phone), position.tokenAddress],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Roll a `releasing` lock back to deposited (or link_created if never confirmed). */
  static async unclaimForRelease(position: PhoneEscrowPosition): Promise<void> {
    await db.query(
      `UPDATE imessage_phone_escrows
          SET status = CASE
                WHEN deposit_tx_hash IS NOT NULL THEN 'deposited'
                ELSE 'link_created'
              END,
              updated_at = NOW()
        WHERE recipient_phone = $1
          AND lower(token_address) = lower($2)
          AND status = 'releasing'`,
      [this.normalizePhone(position.phone), position.tokenAddress],
    );
  }

  static async getClaimableBalance(phone: string, tokenAddress: Address): Promise<bigint> {
    const amount = await getPublicClient().readContract({
      address: escrowAddress(),
      abi: PHONE_ESCROW_ABI,
      functionName: "balances",
      args: [this.phoneHash(phone), tokenAddress],
    });
    return amount as bigint;
  }

  static async releaseToWalletAddress(params: {
    position: PhoneEscrowPosition;
    recipientAddress: string;
  }): Promise<PhoneEscrowReleaseResult | null> {
    const normalized = this.normalizePhone(params.position.phone);
    if (!isAddress(params.recipientAddress)) {
      throw new Error(`invalid recipient address: ${params.recipientAddress}`);
    }
    if (!isAddress(params.position.tokenAddress)) {
      throw new Error(`invalid escrow token address: ${params.position.tokenAddress}`);
    }
    const amountAtomic = await this.getClaimableBalance(
      normalized,
      params.position.tokenAddress,
    );
    if (amountAtomic <= 0n) return null;

    const phoneHash = this.phoneHash(normalized);
    const transactionHash = await sendEscrowOperatorUserOp({
      functionName: "release",
      args: [phoneHash, params.position.tokenAddress, params.recipientAddress as Address],
    });

    await db.query(
      `UPDATE imessage_phone_escrows
       SET status = 'released',
           release_tx_hash = $2,
           released_to = $3,
           updated_at = NOW()
       WHERE phone_hash = $1
         AND lower(token_address) = lower($4)
         AND status <> 'released'
         AND status <> 'refunded'`,
      [
        phoneHash,
        transactionHash,
        params.recipientAddress.toLowerCase(),
        params.position.tokenAddress,
      ],
    );

    return {
      phone: normalized,
      phoneHash,
      tokenAddress: params.position.tokenAddress,
      tokenSymbol: params.position.tokenSymbol,
      tokenDecimals: params.position.tokenDecimals,
      amount: formatUnits(amountAtomic, params.position.tokenDecimals),
      amountAtomic,
      transactionHash,
    };
  }

  /** Expired deposited rows ready for auto-refund to sender. */
  static async listExpiredDeposits(opts?: {
    limit?: number;
  }): Promise<PhoneEscrowDepositRow[]> {
    const limit = opts?.limit ?? 50;
    const result = await db.query<{
      id: string | number | bigint;
      sender_id: string;
      recipient_phone: string;
      phone_hash: string;
      token_address: string;
      token_symbol: string;
      token_decimals: number;
      amount_atomic: string;
      amount_display: string;
      status: string;
      sender_refund_address: string | null;
      deposit_tx_hash: string | null;
      claim_expires_at: Date | string | null;
    }>(
      `SELECT id, sender_id, recipient_phone, phone_hash, token_address, token_symbol,
              token_decimals, amount_atomic::text AS amount_atomic, amount_display, status,
              sender_refund_address, deposit_tx_hash, claim_expires_at
         FROM imessage_phone_escrows
        WHERE status = 'deposited'
          AND claim_expires_at IS NOT NULL
          AND claim_expires_at < NOW()
          AND sender_refund_address IS NOT NULL
        ORDER BY claim_expires_at ASC
        LIMIT $1`,
      [limit],
    );
    return result.rows
      .filter((r) => isAddress(r.token_address))
      .map(mapDepositRow);
  }

  /** Lock a single deposit row for refund. Returns true if this caller won. */
  static async claimForRefund(rowId: string): Promise<boolean> {
    const result = await db.query(
      `UPDATE imessage_phone_escrows
          SET status = 'refunding', updated_at = NOW()
        WHERE id = $1
          AND status = 'deposited'`,
      [rowId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Roll a refunding lock back to deposited when refund did not complete. */
  static async unclaimForRefund(rowId: string): Promise<void> {
    await db.query(
      `UPDATE imessage_phone_escrows
          SET status = 'deposited', updated_at = NOW()
        WHERE id = $1
          AND status = 'refunding'`,
      [rowId],
    );
  }

  static async refundToSender(row: PhoneEscrowDepositRow): Promise<PhoneEscrowRefundResult | null> {
    if (!row.senderRefundAddress || !isAddress(row.senderRefundAddress)) {
      throw new Error(`missing sender refund address for escrow ${row.id}`);
    }
    if (!isAddress(row.tokenAddress)) {
      throw new Error(`invalid escrow token address: ${row.tokenAddress}`);
    }
    if (row.amountAtomic <= 0n) return null;

    const available = await this.getClaimableBalance(row.recipientPhone, row.tokenAddress);
    if (available < row.amountAtomic) return null;

    const phoneHash = this.phoneHash(row.recipientPhone);
    const transactionHash = await sendEscrowOperatorUserOp({
      functionName: "refund",
      args: [
        phoneHash,
        row.tokenAddress,
        row.senderRefundAddress,
        row.amountAtomic,
      ],
    });

    await db.query(
      `UPDATE imessage_phone_escrows
          SET status = 'refunded',
              refund_tx_hash = $2,
              refunded_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
          AND status = 'refunding'`,
      [row.id, transactionHash],
    );

    return {
      id: row.id,
      phone: row.recipientPhone,
      phoneHash,
      tokenAddress: row.tokenAddress,
      tokenSymbol: row.tokenSymbol,
      tokenDecimals: row.tokenDecimals,
      amount: formatUnits(row.amountAtomic, row.tokenDecimals),
      amountAtomic: row.amountAtomic,
      senderRefundAddress: row.senderRefundAddress,
      senderId: row.senderId,
      transactionHash,
    };
  }
}
