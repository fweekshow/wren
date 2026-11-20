import { embedText } from "./embedder.js";
import type { RunScorerParams, ScorerMatch } from "./types.js";

const SCORE_THRESHOLD = 0.55;

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function runScorer(params: RunScorerParams): Promise<void> {
  const { sourceGroupId, message, getGroupCandidates, onMatch } = params;

  const msgEmbedding = await embedText(message);
  if (!msgEmbedding) return;

  const candidates = await getGroupCandidates(sourceGroupId);
  if (candidates.length === 0) return;

  let best: ScorerMatch | null = null;
  let bestScore = SCORE_THRESHOLD;

  for (const candidate of candidates) {
    if (!candidate.embedding) continue;
    const score = cosineSimilarity(msgEmbedding, candidate.embedding);
    if (score > bestScore) {
      bestScore = score;
      best = {
        groupId: candidate.id,
        groupTitle: candidate.title,
        score: Math.round(score * 100),
      };
    }
  }

  if (best) {
    await onMatch(best);
  }
}
