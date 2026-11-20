export const isGreeting = (message: string): boolean => {
  const trimmed = message
    .trim()
    .toLowerCase()
    .replace(/^@\S+\s*/, "")
    // "yo 👀", "gm 🔥" — strip trailing emoji so openers still match
    .replace(/[\s\p{Extended_Pictographic}\p{Emoji_Presentation}]+$/gu, "")
    .trim();
  if (!trimmed) return false;

  if (trimmed.length > 25) return false;

  const words = trimmed.split(/\s+/);

  if (words.length > 2) return false;

  // "what's up" / "whats up" — colloquial greeting, same as "sup"
  if (/^what'?s\s+up[!.?]*$/.test(trimmed)) return true;

  const greetingRegex =
    /^(hi|hello|hey|helo|bye|by|yo+|sup|hiya|gm|bm|good\s(morning|afternoon|evening))(?:\b|[!.? ])*$/i;

  return greetingRegex.test(trimmed);
};
