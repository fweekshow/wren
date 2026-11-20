/** Strip spaces/punctuation for fuzzy contact name comparison. */
export function normalizeContactNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Normalize a saved name into comparable first/middle/last-name tokens. */
export function contactNameTokens(name: string): string[] {
  return name
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(normalizeContactNameKey)
    .filter(Boolean);
}

/**
 * Whether a single-name query exactly matches the first or last part of a
 * saved full name, without treating middle names or multi-word phrases as exact.
 */
export function isExactContactNameToken(
  query: string,
  candidate: string,
): boolean {
  const queryTokens = contactNameTokens(query);
  if (queryTokens.length !== 1) return false;
  const candidateTokens = contactNameTokens(candidate);
  if (candidateTokens.length === 0) return false;
  const queryToken = queryTokens[0]!;
  return (
    candidateTokens[0] === queryToken ||
    candidateTokens[candidateTokens.length - 1] === queryToken
  );
}

/** Classic Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

/**
 * Max edit distance allowed for a fuzzy hit.
 * Short names stay exact/prefix-only to avoid wrong-person sends.
 */
export function fuzzyEditDistanceBudget(normalizedLength: number): number {
  if (normalizedLength < 5) return 0;
  if (normalizedLength < 8) return 1;
  return 2;
}

export type FuzzyNameScore = {
  distance: number;
  /** Lower is better. Exact = 0. */
  rank: number;
};

/**
 * Score a candidate contact name against a query.
 * Returns null when the candidate is not a plausible match.
 *
 * Also matches individual name tokens so "Shivam" hits "Shivam Sarkar".
 */
export function scoreFuzzyContactName(
  query: string,
  candidate: string,
): FuzzyNameScore | null {
  const q = normalizeContactNameKey(query);
  const c = normalizeContactNameKey(candidate);
  if (!q || !c) return null;
  if (q === c) return { distance: 0, rank: 0 };

  // Prefix / contains (after normalization) — strong signal for "degen" → "degeneer"
  if (c.startsWith(q) || q.startsWith(c)) {
    return { distance: Math.abs(c.length - q.length), rank: 1 };
  }
  if (c.includes(q) || q.includes(c)) {
    return { distance: Math.abs(c.length - q.length), rank: 2 };
  }

  // Token match: "Shivam" ↔ "Shivam Sarkar" / "Sarkar, Shivam"
  const queryTokens = contactNameTokens(query);
  const candidateTokens = contactNameTokens(candidate);
  if (queryTokens.length > 0 && candidateTokens.length > 0) {
    const allQueryTokensHit = queryTokens.every((qt) =>
      candidateTokens.some((ct) => {
        const qk = normalizeContactNameKey(qt);
        const ck = normalizeContactNameKey(ct);
        if (!qk || !ck) return false;
        if (qk === ck) return true;
        if (qk.length >= 3 && (ck.startsWith(qk) || qk.startsWith(ck))) return true;
        return false;
      }),
    );
    if (allQueryTokensHit) {
      return {
        distance: Math.abs(c.length - q.length),
        rank: 2,
      };
    }
  }

  const budget = fuzzyEditDistanceBudget(Math.min(q.length, c.length));
  if (budget <= 0) return null;
  const distance = levenshtein(q, c);
  if (distance > budget) return null;
  return { distance, rank: 3 + distance };
}
