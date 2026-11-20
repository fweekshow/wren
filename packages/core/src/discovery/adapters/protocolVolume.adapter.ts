import { drizzleDb } from "@/db/client.js";
import { db } from "@/discovery/db.js";
import { protocolVolumeLog } from "@/db/schema/index.js";

export type ProtocolVolumeProtocol =
  | "moonwell"
  | "morpho"
  | "aave"
  | "avantis"
  | "uniswap"
  | "aerodrome"
  | "bankr";

export interface ProtocolVolumeRecordInput {
  inboxId: string;
  protocol: ProtocolVolumeProtocol;
  action: string;
  token?: string | null;
  amountUsdc?: number | null;
  notionalUsdc?: number | null;
  txHash?: string | null;
}

export interface ProtocolVolumeTotals {
  allTimeUsdc: string;
  last24hUsdc: string;
  txCount: number;
}

export class ProtocolVolumeAdapter {
  /** @deprecated Tables are now managed via Drizzle migrations. */
  static async createTable(): Promise<void> {}

  static async record(input: ProtocolVolumeRecordInput): Promise<void> {
    await drizzleDb.insert(protocolVolumeLog).values({
      inboxId: input.inboxId,
      protocol: input.protocol,
      action: input.action,
      token: input.token ?? null,
      amountUsdc: input.amountUsdc != null ? String(input.amountUsdc) : null,
      notionalUsdc: input.notionalUsdc != null ? String(input.notionalUsdc) : null,
      txHash: input.txHash ?? null,
    });
  }

  static async sumByProtocol(protocol: ProtocolVolumeProtocol): Promise<ProtocolVolumeTotals> {
    const res = await db.query<{
      all_time: string;
      last_24h: string;
      tx_count: string;
    }>(
      `SELECT
         COALESCE(SUM(amount_usdc), 0)::text AS all_time,
         COALESCE(SUM(CASE WHEN confirmed_at > NOW() - INTERVAL '24 hours' THEN amount_usdc ELSE 0 END), 0)::text AS last_24h,
         COUNT(*)::text AS tx_count
       FROM protocol_volume_log
       WHERE protocol = $1`,
      [protocol],
    );
    const row = res.rows[0] ?? { all_time: "0", last_24h: "0", tx_count: "0" };
    return {
      allTimeUsdc: row.all_time,
      last24hUsdc: row.last_24h,
      txCount: Number(row.tx_count),
    };
  }

  /**
   * Sum `notional_usdc` (margin × leverage) rather than `amount_usdc` (collateral).
   * Used for perp volume analytics where notional exposure is the relevant metric.
   */
  static async sumNotionalByProtocol(protocol: ProtocolVolumeProtocol): Promise<ProtocolVolumeTotals> {
    const res = await db.query<{
      all_time: string;
      last_24h: string;
      tx_count: string;
    }>(
      `SELECT
         COALESCE(SUM(notional_usdc), 0)::text AS all_time,
         COALESCE(SUM(CASE WHEN confirmed_at > NOW() - INTERVAL '24 hours' THEN notional_usdc ELSE 0 END), 0)::text AS last_24h,
         COUNT(*)::text AS tx_count
       FROM protocol_volume_log
       WHERE protocol = $1 AND notional_usdc IS NOT NULL`,
      [protocol],
    );
    const row = res.rows[0] ?? { all_time: "0", last_24h: "0", tx_count: "0" };
    return {
      allTimeUsdc: row.all_time,
      last24hUsdc: row.last_24h,
      txCount: Number(row.tx_count),
    };
  }
}
