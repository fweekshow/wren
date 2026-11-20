import { KeywordAdapter, type KeywordWithBudget } from "@/discovery/adapters/keyword.adapter.js";
import { embedText } from "@/shared/scorer/embedder.js";

const CACHE_TTL_MS = 60_000;
let cache: { at: number; rows: KeywordWithBudget[] } | null = null;

export function invalidateKeywordCache(): void {
  cache = null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const SEMANTIC_THRESHOLD = 0.72;

export interface KeywordMatchCandidate {
  keyword: KeywordWithBudget;
  matchType: "exact" | "semantic";
  similarity?: number;
}

export type KeywordSourcePlatform = "telegram" | "xmtp";

async function scoreAllMatches(
  message: string,
  opts?: { sourcePlatform?: KeywordSourcePlatform },
): Promise<{ kw: KeywordWithBudget; score: number; matchType: "exact" | "semantic"; sim?: number }[]> {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return [];

  const sourcePlatform = opts?.sourcePlatform ?? "telegram";

  const now = Date.now();
  if (!cache || now - cache.at > CACHE_TTL_MS) {
    const rows = await KeywordAdapter.listActiveWithBudget();
    cache = { at: now, rows };
  }
  const rows = cache!.rows;
  if (rows.length === 0) return [];

  type Scored = { kw: KeywordWithBudget; score: number; matchType: "exact" | "semantic"; sim?: number };
  const scored: Scored[] = [];

  let msgEmbedding: number[] | null = null;

  for (const kw of rows) {
    if (sourcePlatform === "xmtp" && kw.target_group_type !== "base") {
      continue;
    }
    const term = kw.keyword.toLowerCase();
    if (term.length > 0 && (normalized.includes(term) || term.includes(normalized))) {
      scored.push({
        kw,
        score: 100 + parseFloat(kw.bid_usdc),
        matchType: "exact",
      });
      continue;
    }

    const emb = kw.keyword_embedding;
    if (emb?.length) {
      try {
        if (!msgEmbedding) {
          msgEmbedding = await embedText(normalized.slice(0, 8000));
        }
        const sim = cosineSimilarity(msgEmbedding!, emb);
        if (sim >= SEMANTIC_THRESHOLD) {
          scored.push({
            kw,
            score: 50 * sim + parseFloat(kw.bid_usdc),
            matchType: "semantic",
            sim,
          });
        }
      } catch {
        /* OpenAI unavailable — skip semantic for this message */
      }
    }
  }

  scored.sort((a, b) => {
    const bidA = parseFloat(a.kw.bid_usdc);
    const bidB = parseFloat(b.kw.bid_usdc);
    if (bidB !== bidA) return bidB - bidA;
    return b.score - a.score;
  });

  return scored;
}

/**
 * Returns up to `limit` keyword matches for the message, ranked by bid then score.
 */
export async function findTopKeywordMatches(
  message: string,
  limit: number,
  opts?: { sourcePlatform?: KeywordSourcePlatform },
): Promise<KeywordMatchCandidate[]> {
  const scored = await scoreAllMatches(message, opts);
  return scored.slice(0, limit).map((s) => ({
    keyword: s.kw,
    matchType: s.matchType,
    similarity: s.sim,
  }));
}

/**
 * Returns the highest-bid keyword match for the message (exact substring first, else semantic).
 * XMTP/Base chats only match keywords that drive traffic to Base (XMTP) groups.
 */
export async function findBestKeywordMatch(
  message: string,
  opts?: { sourcePlatform?: KeywordSourcePlatform },
): Promise<KeywordMatchCandidate | null> {
  const scored = await scoreAllMatches(message, opts);
  if (scored.length === 0) return null;
  const top = scored[0]!;
  return {
    keyword: top.kw,
    matchType: top.matchType,
    similarity: top.sim,
  };
}
