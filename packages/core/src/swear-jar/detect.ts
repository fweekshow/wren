/**
 * Word-boundary swear detector for Alexander the swear jar.
 * Must match film lines like "this is bullshit" (bare \bshit\b does not).
 * $1 is charged per message that hits, not per hit inside the message.
 */

const PHRASES: RegExp[] = [
  /\bbull\s*shit\b/i,
  /\bwhat\s+the\s+hell\b/i,
  /\boh\s+hell\s+no\b/i,
  /\bdamn\s+it\b/i,
  /\bgod\s*damn\b/i,
  /\bwtf\b/i,
  /\bfuck(?:ing|ed|er|s)?\b/i,
  /\bmotherfucker\b/i,
  /\bmother[\W_]*f[\W_]*u[\W_]*c[\W_]*k(?:er|ing)?\b/i,
  /\bshit(?:ty|s)?\b/i,
  /\bsh[i1!]t(?:ty|s)?\b/i,
  /\bbitch(?:es|y)?\b/i,
  /\bb[i1]tch(?:es|y)?\b/i,
  /\basshole\b/i,
  /\bcunt\b/i,
  /\bf+[\W_]*u*[\W_]*c[\W_]*k(?:ing|ed|er|s)?\b/i,
  /\bfvck(?:ing|ed|er|s)?\b/i,
];

export function detectSwear(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return PHRASES.some((re) => re.test(t));
}
