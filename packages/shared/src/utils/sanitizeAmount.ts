/** Strip non-numeric characters and reject non-positive / invalid amounts. */
export function sanitizeAmount(raw: string): string | null {
  const trimmed = raw.trim();
  // Reject scientific notation before stripping — "1e18" would otherwise
  // become "118" after the replace, silently corrupting the value.
  if (/[eE]/.test(trimmed)) return null;
  const cleaned = trimmed.replace(/[^\d.]/g, "");
  if (!cleaned || cleaned === ".") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return cleaned;
}
