/**
 * Base App markdown treats ~ as strikethrough delimiters. Replace approximate
 * tildes and unwrap accidental ~~strike~~ from model copy before sending.
 */
export function sanitizeXmptMarkdown(text: string): string {
  return (
    text
      // unwrap ~~strikethrough~~ — keep inner text
      .replace(/~~([^~]*)~~/g, "$1")
      // ~$100 → about $100
      .replace(/~\$/g, "about $")
      // ~12 min, ~3-5x, (~12 min)
      .replace(/~(\d)/g, "about $1")
      // any remaining lone tildes
      .replace(/~/g, "")
  );
}
