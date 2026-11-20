import { createHash } from "node:crypto";

import { vectorDb } from "@/discovery/db.js";
import { embedText } from "@/shared/scorer/embedder.js";

export type ConversationMemoryKind = "tool_outcome" | "preference" | "note";

export interface ConversationMemoryRow {
  id: number;
  inbox_id: string;
  conversation_id: string | null;
  kind: ConversationMemoryKind;
  content: string;
  importance: number;
  metadata: Record<string, unknown>;
  similarity?: number;
  created_at: Date;
  last_used_at: Date | null;
}

const EMBEDDING_DIMENSIONS = 1536;
const DEFAULT_LIMIT = 3;
const MAX_SEARCH_CANDIDATES = 8;
const MIN_SIMILARITY = 0.55;
const MAX_CONTENT_CHARS = 600;
const MIN_CONTENT_CHARS = 18;
const RECENT_DUPLICATE_DAYS = 30;

let memoryAvailable: boolean | null = null;
let unavailableLogged = false;

const EARN_TOOL_VENUES: Record<string, string> = {
  morpho_prepare_deposit: "Morpho",
  moonwell_prepare_supply: "Moonwell",
  aave_prepare_supply: "Aave",
};

const PERP_TOOLS = new Set(["avantis_prepare_trade", "avantis_guided_trade"]);

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/g, " ").slice(0, MAX_CONTENT_CHARS);
}

function contentHash(content: string): string {
  return createHash("sha256").update(content.toLowerCase()).digest("hex");
}

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function metadataJson(metadata: Record<string, unknown> | undefined): string {
  return JSON.stringify(metadata ?? {});
}

function pgErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function markUnavailable(reason: string, error?: unknown): void {
  memoryAvailable = false;
  if (unavailableLogged) return;
  unavailableLogged = true;
  const detail = error instanceof Error ? `: ${error.message}` : "";
  console.warn(`Conversation memory disabled (${reason})${detail}`);
}

function formatToolMemory(toolName: string, args: Record<string, unknown>): string | null {
  if (PERP_TOOLS.has(toolName)) {
    const pair = firstString(args.pair, args.base, args.symbol, args.market)?.toUpperCase();
    const side = firstString(args.side, args.direction)?.toLowerCase();
    const leverage = firstString(args.leverage, args.leverageMultiplier);
    const pieces = [
      pair ? `${pair} perps` : "perps",
      side ? `${side} bias` : "",
      leverage ? `${leverage}x leverage` : "",
    ].filter(Boolean);
    return `User prepared ${pieces.join(", ")}.`;
  }

  const venue = EARN_TOOL_VENUES[toolName];
  if (venue) {
    const asset = firstString(args.asset, args.token)?.toUpperCase();
    return asset
      ? `User prepared an earn deposit for ${asset} on ${venue}.`
      : `User prepared an earn deposit on ${venue}.`;
  }

  return null;
}

function inferPreferenceMemory(message: string): string | null {
  const text = message.trim();
  const lower = text.toLowerCase();
  const facts: string[] = [];

  if (/\b(low[-\s]?risk|conservative|safer|safe)\b/.test(lower)) {
    facts.push("prefers lower-risk strategies");
  } else if (/\b(high[-\s]?risk|aggressive|degen|ape)\b/.test(lower)) {
    facts.push("is comfortable with higher-risk strategies");
  } else if (/\bmedium[-\s]?risk\b/.test(lower)) {
    facts.push("prefers medium-risk strategies");
  }

  const preferredAsset = lower.match(
    /\b(?:i\s+(?:like|prefer|favor|favour)|favorite|favourite|main asset is)\b[^.!?\n]{0,80}\b(eth|btc|usdc|weth|aero|degen|toshi)\b/i,
  )?.[1];
  if (preferredAsset) facts.push(`prefers ${preferredAsset.toUpperCase()}`);

  const preferredProtocol = lower.match(
    /\b(?:i\s+(?:like|prefer|favor|favour)|favorite|favourite)\b[^.!?\n]{0,80}\b(morpho|aave|moonwell|avantis|uniswap)\b/i,
  )?.[1];
  if (preferredProtocol) facts.push(`prefers ${preferredProtocol}`);

  const avoidMatch = lower.match(/\b(?:avoid|don't use|do not use|not interested in)\b[^.!?\n]{0,80}\b(morpho|aave|moonwell|avantis|uniswap|perps?|leverage)\b/i);
  if (avoidMatch?.[1]) facts.push(`wants to avoid ${avoidMatch[1]}`);

  if (!facts.length && /\bremember\b/i.test(text) && text.length <= 220) {
    return `User asked Basemate to remember: ${text}`;
  }

  if (!facts.length) return null;
  return `User ${Array.from(new Set(facts)).join(" and ")}.`;
}

export class ConversationMemoryAdapter {
  static async createTable(): Promise<void> {
    if (!vectorDb) {
      markUnavailable("VECTOR_DATABASE_URL is not set");
      return;
    }

    const client = await vectorDb.connect();
    try {
      await client.query(`
        CREATE EXTENSION IF NOT EXISTS vector;

        CREATE TABLE IF NOT EXISTS conversation_memory (
          id BIGSERIAL PRIMARY KEY,
          inbox_id TEXT NOT NULL,
          conversation_id TEXT,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          embedding VECTOR(${EMBEDDING_DIMENSIONS}) NOT NULL,
          importance REAL NOT NULL DEFAULT 0.5,
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_used_at TIMESTAMPTZ
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_memory_inbox_hash
          ON conversation_memory(inbox_id, content_hash);
        CREATE INDEX IF NOT EXISTS idx_conversation_memory_inbox_created
          ON conversation_memory(inbox_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_conversation_memory_embedding
          ON conversation_memory USING ivfflat (embedding vector_cosine_ops)
          WITH (lists = 10);
      `);
      memoryAvailable = true;
      unavailableLogged = false;
      console.log("conversation_memory table created or already exists.");
    } catch (error) {
      const code = pgErrorCode(error);
      if (code === "0A000" || code === "58P01") {
        markUnavailable("pgvector extension is not installed on this Postgres server", error);
      } else {
        markUnavailable("conversation_memory table could not be initialized", error);
        console.error("Error creating conversation_memory table:", error);
      }
    } finally {
      client.release();
    }
  }

  static async remember(input: {
    inboxId: string;
    conversationId?: string | null;
    kind: ConversationMemoryKind;
    content: string;
    importance?: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const content = normalizeContent(input.content);
    if (!input.inboxId || content.length < MIN_CONTENT_CHARS) return;
    if (memoryAvailable === false) return;
    if (!vectorDb) {
      markUnavailable("VECTOR_DATABASE_URL is not set");
      return;
    }

    try {
      const hash = contentHash(content);
      const recent = await vectorDb.query(
        `SELECT 1 FROM conversation_memory
         WHERE inbox_id = $1 AND content_hash = $2
           AND created_at > NOW() - ($3::int * INTERVAL '1 day')
         LIMIT 1`,
        [input.inboxId, hash, RECENT_DUPLICATE_DAYS],
      );
      if ((recent.rowCount ?? 0) > 0) return;

      const embedding = await embedText(content);
      if (!embedding?.length) return;

      await vectorDb.query(
        `INSERT INTO conversation_memory
           (inbox_id, conversation_id, kind, content, content_hash, embedding, importance, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8::jsonb)
         ON CONFLICT (inbox_id, content_hash) DO UPDATE SET
           importance = GREATEST(conversation_memory.importance, EXCLUDED.importance),
           metadata = conversation_memory.metadata || EXCLUDED.metadata,
           last_used_at = NOW()`,
        [
          input.inboxId,
          input.conversationId ?? null,
          input.kind,
          content,
          hash,
          vectorLiteral(embedding),
          Math.max(0, Math.min(1, input.importance ?? 0.5)),
          metadataJson(input.metadata),
        ],
      );
    } catch (error) {
      if (pgErrorCode(error) === "42P01") {
        markUnavailable("conversation_memory table does not exist", error);
        return;
      }
      console.error("ConversationMemoryAdapter.remember error:", error);
    }
  }

  static async rememberToolOutcome(input: {
    inboxId: string;
    conversationId?: string | null;
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<void> {
    const content = formatToolMemory(input.toolName, input.args);
    if (!content) return;
    await ConversationMemoryAdapter.remember({
      inboxId: input.inboxId,
      conversationId: input.conversationId,
      kind: "tool_outcome",
      content,
      importance: 0.7,
      metadata: { toolName: input.toolName },
    });
  }

  static async rememberPreferenceFromTurn(input: {
    inboxId: string;
    conversationId?: string | null;
    userMessage: string;
  }): Promise<void> {
    const content = inferPreferenceMemory(input.userMessage);
    if (!content) return;
    await ConversationMemoryAdapter.remember({
      inboxId: input.inboxId,
      conversationId: input.conversationId,
      kind: "preference",
      content,
      importance: 0.8,
      metadata: { source: "user_message" },
    });
  }

  static async searchRelevant(
    inboxId: string,
    queryText: string,
    options: { limit?: number; minSimilarity?: number } = {},
  ): Promise<ConversationMemoryRow[]> {
    if (!inboxId || !queryText.trim()) return [];
    if (memoryAvailable === false) return [];
    if (!vectorDb) {
      markUnavailable("VECTOR_DATABASE_URL is not set");
      return [];
    }

    try {
      const embedding = await embedText(queryText);
      if (!embedding?.length) return [];

      const limit = Math.max(1, Math.min(10, options.limit ?? DEFAULT_LIMIT));
      const minSimilarity = options.minSimilarity ?? MIN_SIMILARITY;
      const res = await vectorDb.query<ConversationMemoryRow & { similarity: number }>(
        `SELECT id, inbox_id, conversation_id, kind, content, importance, metadata,
                created_at, last_used_at,
                1 - (embedding <=> $2::vector) AS similarity
         FROM conversation_memory
         WHERE inbox_id = $1
         ORDER BY embedding <=> $2::vector
         LIMIT $3`,
        [inboxId, vectorLiteral(embedding), Math.max(limit, MAX_SEARCH_CANDIDATES)],
      );

      const memories = res.rows
        .filter((row) => Number(row.similarity ?? 0) >= minSimilarity)
        .sort((a, b) => {
          const aScore = Number(a.similarity ?? 0) + Number(a.importance ?? 0) * 0.05;
          const bScore = Number(b.similarity ?? 0) + Number(b.importance ?? 0) * 0.05;
          return bScore - aScore;
        })
        .slice(0, limit);

      if (memories.length) {
        void vectorDb.query(`UPDATE conversation_memory SET last_used_at = NOW() WHERE id = ANY($1::bigint[])`, [
          memories.map((m) => m.id),
        ]);
      }

      return memories;
    } catch (error) {
      if (pgErrorCode(error) === "42P01") {
        markUnavailable("conversation_memory table does not exist", error);
        return [];
      }
      console.error("ConversationMemoryAdapter.searchRelevant error:", error);
      return [];
    }
  }
}
