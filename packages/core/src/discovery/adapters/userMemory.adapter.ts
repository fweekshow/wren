import { eq, sql } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import { userMemory } from "@/db/schema/index.js";
import { ConversationMemoryAdapter } from "@/discovery/adapters/conversationMemory.adapter.js";

export interface UserMemory {
  inbox_id: string;
  preferred_earn_venues: string[];
  last_trade_pair: string | null;
  last_earn_asset: string | null;
  notable: string | null;
  trade_count: number;
  earn_count: number;
  updated_at: Date;
}

/** Earn-tool name → canonical venue label stored on the user's memory. */
const EARN_TOOL_VENUES: Record<string, string> = {
  morpho_prepare_deposit: "morpho",
  moonwell_prepare_supply: "moonwell",
  aave_prepare_supply: "aave",
};

/** Perp tools that imply the user opened/traded a pair. */
const PERP_TOOLS = new Set<string>([
  "avantis_prepare_trade",
  "avantis_guided_trade",
]);

const MAX_NOTABLE_CHARS = 200;
const MAX_VENUES = 4;

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Lightweight per-user memory snapshot. Written fire-and-forget after a
 * successful tool execution and read once at the start of a turn as a frozen
 * note appended to the system prompt (never mutated mid-conversation, so the
 * stable prompt prefix stays cacheable). Risk tier is NOT stored here — it is
 * read live from perp_profiles to avoid duplicating that source of truth.
 */
export class UserMemoryAdapter {
  /** @deprecated Tables are now managed via Drizzle migrations. */
  static async createTable(): Promise<void> {}

  static async getMemory(inboxId: string): Promise<UserMemory | null> {
    try {
      const row = await drizzleDb.query.userMemory.findFirst({
        where: (m, { eq }) => eq(m.inboxId, inboxId),
      });
      if (!row) return null;
      return {
        inbox_id: row.inboxId,
        preferred_earn_venues: Array.isArray(row.preferredEarnVenues) ? row.preferredEarnVenues : [],
        last_trade_pair: row.lastTradePair ?? null,
        last_earn_asset: row.lastEarnAsset ?? null,
        notable: row.notable ?? null,
        trade_count: Number(row.tradeCount ?? 0),
        earn_count: Number(row.earnCount ?? 0),
        updated_at: row.updatedAt ?? new Date(),
      };
    } catch (error) {
      console.error("UserMemoryAdapter.getMemory error:", error);
      return null;
    }
  }

  /**
   * Build a compact, plain-text memory note for the system prompt. Returns null
   * when there is nothing worth telling the model (keeps the prompt lean for
   * brand-new users). Pulls risk tier live from perp_profiles.
   */
  static async buildUserMemoryNote(inboxId: string, queryText?: string): Promise<string | null> {
    if (!inboxId) return null;
    const [memory, semanticMemories] = await Promise.all([
      UserMemoryAdapter.getMemory(inboxId),
      queryText?.trim()
        ? ConversationMemoryAdapter.searchRelevant(inboxId, queryText, { limit: 3 }).catch(() => [])
        : Promise.resolve([]),
    ]);

    const parts: string[] = [];
    if (memory?.last_trade_pair) {
      parts.push(`last traded ${memory.last_trade_pair} perps`);
    }
    if (memory?.last_earn_asset) {
      const venue = memory.preferred_earn_venues[0];
      parts.push(
        venue
          ? `earned on ${memory.last_earn_asset} via ${venue}`
          : `earned on ${memory.last_earn_asset}`,
      );
    } else if (memory?.preferred_earn_venues.length) {
      parts.push(`prefers ${memory.preferred_earn_venues.join(", ")}`);
    }
    if (memory?.notable) parts.push(memory.notable);
    if (semanticMemories.length) {
      const relevant = semanticMemories.map((m) => m.content.replace(/\s+/g, " ").trim()).join("; ");
      parts.push(`Relevant past context: ${relevant}`);
    }

    if (!parts.length) return null;
    return parts.join(". ") + ".";
  }

  /**
   * Fire-and-forget: update the snapshot from a successful tool execution.
   * Infers what changed from the tool name + args. Never throws.
   */
  static async updateUserMemory(
    inboxId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    if (!inboxId || !toolName) return;
    try {
      const isPerp = PERP_TOOLS.has(toolName);
      const venue = EARN_TOOL_VENUES[toolName];
      const isEarn = Boolean(venue);
      if (!isPerp && !isEarn) return;

      const existing = await UserMemoryAdapter.getMemory(inboxId);
      const venues = new Set(existing?.preferred_earn_venues ?? []);

      let lastTradePair = existing?.last_trade_pair ?? null;
      let lastEarnAsset = existing?.last_earn_asset ?? null;
      let tradeCount = existing?.trade_count ?? 0;
      let earnCount = existing?.earn_count ?? 0;

      if (isPerp) {
        const pair = firstString(args.pair, args.base, args.symbol, args.market);
        if (pair) lastTradePair = pair.toUpperCase();
        tradeCount += 1;
      }
      if (isEarn) {
        const asset = firstString(args.asset, args.token);
        if (asset) lastEarnAsset = asset.toUpperCase();
        venues.add(venue);
        earnCount += 1;
      }

      const venuesArr = Array.from(venues).slice(-MAX_VENUES);
      const notable = existing?.notable ? existing.notable.slice(0, MAX_NOTABLE_CHARS) : null;

      await drizzleDb
        .insert(userMemory)
        .values({
          inboxId,
          preferredEarnVenues: venuesArr,
          lastTradePair,
          lastEarnAsset,
          notable,
          tradeCount: String(tradeCount),
          earnCount: String(earnCount),
          updatedAt: sql`NOW()`,
        })
        .onConflictDoUpdate({
          target: userMemory.inboxId,
          set: {
            preferredEarnVenues: venuesArr,
            lastTradePair,
            lastEarnAsset,
            notable,
            tradeCount: String(tradeCount),
            earnCount: String(earnCount),
            updatedAt: sql`NOW()`,
          },
        });
    } catch (error) {
      console.error("UserMemoryAdapter.updateUserMemory error:", error);
    }
  }
}
