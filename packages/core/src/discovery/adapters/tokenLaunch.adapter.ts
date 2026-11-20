import { and, desc, eq, gt } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import { tokenLaunchLog } from "@/db/schema/index.js";
import { db } from "@/discovery/db.js";

let istonksColumnsEnsured = false;

/**
 * Boot repair for the iStonks launch columns (migrations 0023–0024), matching
 * the `ensure*Columns` pattern used elsewhere: deploys don't run migrations,
 * and a missing column would 500 every launch write and iStonks read.
 */
export async function ensureTokenLaunchLogColumns(): Promise<void> {
  if (istonksColumnsEnsured) return;
  await db.query(`
    ALTER TABLE "token_launch_log"
      ADD COLUMN IF NOT EXISTS "pool_id" text,
      ADD COLUMN IF NOT EXISTS "pair_address" text,
      ADD COLUMN IF NOT EXISTS "pair_symbol" text,
      ADD COLUMN IF NOT EXISTS "tx_hash" text,
      ADD COLUMN IF NOT EXISTS "beneficiary_json" text,
      ADD COLUMN IF NOT EXISTS "fee_mode" text,
      ADD COLUMN IF NOT EXISTS "initializer" text
  `);
  istonksColumnsEnsured = true;
}

export type LaunchLogRow = typeof tokenLaunchLog.$inferSelect;

/** Serialized beneficiary split stored on the launch row. */
export interface LaunchBeneficiary {
  beneficiary: string;
  /** Shares in WAD (1e18 = 100%), as a decimal string. */
  shares: string;
}

export interface RecordLaunchAttemptParams {
  wallet: string;
  tokenName: string;
  tokenSymbol: string;
  status: LaunchLogStatus;
  httpStatus?: number;
  tokenAddress?: string;
  /** Doppler multicurve pool id (bytes32 hex). */
  poolId?: string;
  pairAddress?: string;
  pairSymbol?: string;
  txHash?: string;
  beneficiaries?: ReadonlyArray<{ beneficiary: string; shares: bigint | string | number }>;
  /** Fee payout currency: "both" | "stock". */
  feeMode?: string;
  /** Rehype hook / multicurve initializer address. */
  initializer?: string;
}

const MAX_LIST_LIMIT = 200;

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 50;
  return Math.min(Math.floor(limit), MAX_LIST_LIMIT);
}

/** bigint shares aren't JSON-serializable — store them as decimal strings. */
function serializeBeneficiaries(
  entries: RecordLaunchAttemptParams["beneficiaries"],
): string | null {
  if (!entries?.length) return null;
  try {
    const normalized: LaunchBeneficiary[] = entries.map((e) => ({
      beneficiary: e.beneficiary.toLowerCase(),
      shares: e.shares.toString(),
    }));
    return JSON.stringify(normalized);
  } catch (error) {
    console.error("Error serializing launch beneficiaries:", error);
    return null;
  }
}

/** Parse a stored beneficiary snapshot. Returns [] for missing/corrupt JSON. */
export function parseLaunchBeneficiaries(raw: string | null | undefined): LaunchBeneficiary[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (typeof row.beneficiary !== "string") return [];
      return [{ beneficiary: row.beneficiary, shares: String(row.shares ?? "0") }];
    });
  } catch {
    return [];
  }
}

const COOLDOWN_HOURS = parseInt(process.env.LAUNCH_COOLDOWN_HOURS ?? "24", 10);
const MAX_SUCCESSFUL_PER_WINDOW = parseInt(process.env.LAUNCH_MAX_SUCCESSFUL_PER_DAY ?? "3", 10);

export type LaunchLogStatus = "success" | "failed";

export interface LaunchRateLimitRow {
  logStatus: LaunchLogStatus;
  tokenSymbol: string | null;
  createdAt: Date;
}

export type LaunchRateLimitStatus = "allowed" | "limit_reached";

export interface LaunchRateLimitVerdict {
  status: LaunchRateLimitStatus;
  message?: string;
}

/** Pure policy — only successful launches count toward the daily cap. */
export function evaluateLaunchRateLimit(
  rows: LaunchRateLimitRow[],
  nowMs: number,
  opts?: { cooldownHours?: number; maxSuccessful?: number },
): LaunchRateLimitVerdict {
  const cooldownHours = opts?.cooldownHours ?? COOLDOWN_HOURS;
  const maxSuccessful = opts?.maxSuccessful ?? MAX_SUCCESSFUL_PER_WINDOW;
  const windowMs = cooldownHours * 60 * 60 * 1000;

  const successes = rows.filter(
    (r) => r.logStatus === "success" && nowMs - r.createdAt.getTime() < windowMs,
  );

  if (successes.length >= maxSuccessful) {
    return {
      status: "limit_reached",
      message: `you've launched ${maxSuccessful} tokens in the last ${cooldownHours}h — that's the max per wallet. try again tomorrow 👍`,
    };
  }

  return { status: "allowed" };
}

export class TokenLaunchAdapter {
  /** @deprecated Tables are now managed via Drizzle migrations. */
  static async createTable(): Promise<void> {}

  static async checkRateLimit(wallet: string): Promise<LaunchRateLimitVerdict> {
    const normalized = wallet.toLowerCase();
    const cooldownHours = COOLDOWN_HOURS;
    try {
      const cutoff = new Date(Date.now() - cooldownHours * 60 * 60 * 1000);
      const rows = await drizzleDb
        .select({
          status: tokenLaunchLog.status,
          tokenSymbol: tokenLaunchLog.tokenSymbol,
          createdAt: tokenLaunchLog.createdAt,
        })
        .from(tokenLaunchLog)
        .where(
          and(
            eq(tokenLaunchLog.walletAddress, normalized),
            eq(tokenLaunchLog.status, "success"),
            gt(tokenLaunchLog.createdAt, cutoff),
          ),
        )
        .orderBy(desc(tokenLaunchLog.createdAt));

      const mapped: LaunchRateLimitRow[] = rows.map((r) => ({
        logStatus: r.status as LaunchLogStatus,
        tokenSymbol: r.tokenSymbol ?? null,
        createdAt: r.createdAt as Date,
      }));
      return evaluateLaunchRateLimit(mapped, Date.now(), {
        cooldownHours,
        maxSuccessful: MAX_SUCCESSFUL_PER_WINDOW,
      });
    } catch (error) {
      console.error("Error checking token launch rate limit:", error);
      return { status: "allowed" };
    }
  }

  static async recordAttempt(params: RecordLaunchAttemptParams): Promise<void> {
    try {
      await ensureTokenLaunchLogColumns();
      await drizzleDb.insert(tokenLaunchLog).values({
        walletAddress: params.wallet.toLowerCase(),
        tokenSymbol: params.tokenSymbol.toUpperCase(),
        tokenName: params.tokenName,
        status: params.status,
        httpStatus: params.httpStatus ?? null,
        tokenAddress: params.tokenAddress?.toLowerCase() ?? null,
        poolId: params.poolId?.toLowerCase() ?? null,
        pairAddress: params.pairAddress?.toLowerCase() ?? null,
        pairSymbol: params.pairSymbol ?? null,
        txHash: params.txHash?.toLowerCase() ?? null,
        beneficiaryJson: serializeBeneficiaries(params.beneficiaries),
        feeMode: params.feeMode?.trim().toLowerCase() || null,
        initializer: params.initializer?.toLowerCase() ?? null,
      });
    } catch (error) {
      console.error("Error recording token launch attempt:", error);
    }
  }

  /** Successful launches, newest first. Powers the public iStonks feed. */
  static async listSuccessful(limit = 50): Promise<LaunchLogRow[]> {
    await ensureTokenLaunchLogColumns();
    const rows = await drizzleDb
      .select()
      .from(tokenLaunchLog)
      .where(eq(tokenLaunchLog.status, "success"))
      .orderBy(desc(tokenLaunchLog.createdAt))
      .limit(clampLimit(limit));
    return rows;
  }

  /** Every launch attempt for one wallet, newest first. */
  static async listByWallet(wallet: string, limit = 50): Promise<LaunchLogRow[]> {
    const normalized = wallet.trim().toLowerCase();
    if (!normalized) return [];
    await ensureTokenLaunchLogColumns();
    const rows = await drizzleDb
      .select()
      .from(tokenLaunchLog)
      .where(eq(tokenLaunchLog.walletAddress, normalized))
      .orderBy(desc(tokenLaunchLog.createdAt))
      .limit(clampLimit(limit));
    return rows;
  }

  /** Successful launches for one wallet — the fee-claim candidate set. */
  static async listSuccessfulByWallet(wallet: string, limit = 50): Promise<LaunchLogRow[]> {
    const normalized = wallet.trim().toLowerCase();
    if (!normalized) return [];
    await ensureTokenLaunchLogColumns();
    const rows = await drizzleDb
      .select()
      .from(tokenLaunchLog)
      .where(
        and(eq(tokenLaunchLog.walletAddress, normalized), eq(tokenLaunchLog.status, "success")),
      )
      .orderBy(desc(tokenLaunchLog.createdAt))
      .limit(clampLimit(limit));
    return rows;
  }

  /** Most recent launch row for a token address (case-insensitive). */
  static async findByTokenAddress(address: string): Promise<LaunchLogRow | null> {
    const normalized = address.trim().toLowerCase();
    if (!normalized) return null;
    await ensureTokenLaunchLogColumns();
    const rows = await drizzleDb
      .select()
      .from(tokenLaunchLog)
      .where(eq(tokenLaunchLog.tokenAddress, normalized))
      .orderBy(desc(tokenLaunchLog.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /** True when the wallet has ever successfully launched a token. */
  static async hasSuccessfulLaunch(wallet: string): Promise<boolean> {
    const normalized = wallet.trim().toLowerCase();
    if (!normalized) return false;
    const rows = await drizzleDb
      .select({ id: tokenLaunchLog.id })
      .from(tokenLaunchLog)
      .where(
        and(eq(tokenLaunchLog.walletAddress, normalized), eq(tokenLaunchLog.status, "success")),
      )
      .limit(1);
    return rows.length > 0;
  }
}
