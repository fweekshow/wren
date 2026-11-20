import { db } from "@/discovery/db.js";

export interface OnrampUserData {
  userPhone: string;
  email: string | null;
  tosAcceptedAt: Date | null;
  phoneVerifiedAt: Date | null;
  emailVerifiedAt: Date | null;
  pendingPhoneOtp: string | null;
  pendingPhoneOtpExpiresAt: Date | null;
  pendingEmailOtp: string | null;
  pendingEmailOtpExpiresAt: Date | null;
}

export type OnrampUserDataUpdate = Partial<Omit<OnrampUserData, "userPhone">>;

const PHONE_REVERIFY_DAYS = 60;

/**
 * Stores per-user verification data required by the Coinbase Headless Onramp API.
 *
 * This is the canonical email store for iMessage users. All fields are nullable
 * to support incremental collection — users can onboard in steps.
 *
 * Can be promoted to a general user_profiles table later if email is needed
 * for other features (price alert emails, portfolio digests, etc.).
 */
export class OnrampUserDataAdapter {
  static async createTable(): Promise<void> {
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS onramp_user_data (
          user_phone                   TEXT PRIMARY KEY,
          email                        TEXT,
          tos_accepted_at              TIMESTAMPTZ,
          phone_verified_at            TIMESTAMPTZ,
          email_verified_at            TIMESTAMPTZ,
          pending_phone_otp            VARCHAR(6),
          pending_phone_otp_expires_at TIMESTAMPTZ,
          pending_email_otp            VARCHAR(6),
          pending_email_otp_expires_at TIMESTAMPTZ,
          created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
    } catch (error) {
      console.error("Error creating onramp_user_data table:", error);
    }
  }

  static async findPhoneByEmail(email: string): Promise<string | null> {
    const normalized = email.trim().toLowerCase();
    if (!normalized || !normalized.includes("@")) return null;
    const result = await db.query(
      `SELECT user_phone FROM onramp_user_data
        WHERE lower(trim(email)) = $1
        ORDER BY updated_at DESC
        LIMIT 1`,
      [normalized],
    );
    const phone = result.rows[0]?.user_phone;
    return typeof phone === "string" && phone.trim() ? phone : null;
  }

  static async get(userPhone: string): Promise<OnrampUserData | null> {
    const result = await db.query(
      `SELECT user_phone, email, tos_accepted_at, phone_verified_at, email_verified_at,
              pending_phone_otp, pending_phone_otp_expires_at,
              pending_email_otp, pending_email_otp_expires_at
       FROM onramp_user_data WHERE user_phone = $1`,
      [userPhone],
    );
    const row = result.rows[0];
    if (!row) return null;
    return mapRow(row);
  }

  static async upsert(userPhone: string, updates: OnrampUserDataUpdate): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [userPhone];

    const fieldMap: Record<keyof OnrampUserDataUpdate, string> = {
      email: "email",
      tosAcceptedAt: "tos_accepted_at",
      phoneVerifiedAt: "phone_verified_at",
      emailVerifiedAt: "email_verified_at",
      pendingPhoneOtp: "pending_phone_otp",
      pendingPhoneOtpExpiresAt: "pending_phone_otp_expires_at",
      pendingEmailOtp: "pending_email_otp",
      pendingEmailOtpExpiresAt: "pending_email_otp_expires_at",
    };

    for (const [key, col] of Object.entries(fieldMap) as [keyof OnrampUserDataUpdate, string][]) {
      if (key in updates) {
        values.push(updates[key] instanceof Date ? (updates[key] as Date).toISOString() : updates[key]);
        fields.push(`${col} = $${values.length}`);
      }
    }

    if (fields.length === 0) return;

    await db.query(
      `INSERT INTO onramp_user_data (user_phone, ${fields.map((f) => f.split(" = ")[0]).join(", ")}, updated_at)
       VALUES ($1, ${fields.map((_, i) => `$${i + 2}`).join(", ")}, NOW())
       ON CONFLICT (user_phone) DO UPDATE SET
         ${fields.join(", ")},
         updated_at = NOW()`,
      values,
    );
  }

  /**
   * Returns true when the user has all required verifications for Coinbase's
   * Headless Onramp API: email verified, phone verified within 60 days, ToS accepted.
   */
  static isReadyForOnramp(data: OnrampUserData | null): data is OnrampUserData & {
    email: string;
    tosAcceptedAt: Date;
    phoneVerifiedAt: Date;
    emailVerifiedAt: Date;
  } {
    if (!data) return false;
    if (!data.email) return false;
    if (!data.tosAcceptedAt) return false;
    if (!data.emailVerifiedAt) return false;
    if (!data.phoneVerifiedAt) return false;

    const daysSinceVerified =
      (Date.now() - data.phoneVerifiedAt.getTime()) / (1000 * 60 * 60 * 24);
    return daysSinceVerified < PHONE_REVERIFY_DAYS;
  }

  /** True when phone needs fresh OTP (never verified or >60 days ago). */
  static needsPhoneReverification(data: OnrampUserData | null): boolean {
    if (!data?.phoneVerifiedAt) return true;
    const daysSince = (Date.now() - data.phoneVerifiedAt.getTime()) / (1000 * 60 * 60 * 24);
    return daysSince >= PHONE_REVERIFY_DAYS;
  }
}

function mapRow(row: Record<string, unknown>): OnrampUserData {
  return {
    userPhone: row.user_phone as string,
    email: (row.email as string | null) ?? null,
    tosAcceptedAt: row.tos_accepted_at ? new Date(row.tos_accepted_at as string) : null,
    phoneVerifiedAt: row.phone_verified_at ? new Date(row.phone_verified_at as string) : null,
    emailVerifiedAt: row.email_verified_at ? new Date(row.email_verified_at as string) : null,
    pendingPhoneOtp: (row.pending_phone_otp as string | null) ?? null,
    pendingPhoneOtpExpiresAt: row.pending_phone_otp_expires_at
      ? new Date(row.pending_phone_otp_expires_at as string)
      : null,
    pendingEmailOtp: (row.pending_email_otp as string | null) ?? null,
    pendingEmailOtpExpiresAt: row.pending_email_otp_expires_at
      ? new Date(row.pending_email_otp_expires_at as string)
      : null,
  };
}
