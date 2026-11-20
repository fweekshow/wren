import { drizzleDb } from "@/db/client.js";
import { smsConsents } from "@/db/schema/index.js";

import type { SmsConsentStamp, SmsConsentStatus } from "./smsConsent.js";

function asStatus(value: string): SmsConsentStatus | null {
  if (value === "pending" || value === "opted_in" || value === "opted_out") return value;
  return null;
}

export class SmsConsentAdapter {
  static async getStatus(phone: string): Promise<SmsConsentStatus | null> {
    const row = await drizzleDb.query.smsConsents.findFirst({
      where: (table, { eq }) => eq(table.phone, phone),
    });
    return row ? asStatus(row.status) : null;
  }

  static async save(
    phone: string,
    status: SmsConsentStatus,
    stamp: SmsConsentStamp,
  ): Promise<void> {
    const now = new Date();
    const update: {
      status: SmsConsentStatus;
      updatedAt: Date;
      optedInAt?: Date;
      optedOutAt?: Date;
    } = { status, updatedAt: now };
    if (stamp === "opted_in") update.optedInAt = now;
    if (stamp === "opted_out") update.optedOutAt = now;

    await drizzleDb
      .insert(smsConsents)
      .values({
        phone,
        status,
        optedInAt: stamp === "opted_in" ? now : null,
        optedOutAt: stamp === "opted_out" ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: smsConsents.phone,
        set: update,
      });
  }
}
