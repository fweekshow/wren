// Small formatters shared by the account screens.

/** "$50" for whole dollars, "$50.25" otherwise. */
export function usdShort(n: number): string {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return Number.isInteger(v)
    ? `$${v.toLocaleString('en-US')}`
    : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "Now", "5m", "2h", "Yesterday", "Mon", "Nov 3". */
export function when(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 1) return 'Now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  const d = new Date(t);
  if (days < 7) return d.toLocaleDateString('en-US', { weekday: 'short' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Catalog symbols end in a lowercase c (AAPLc); people know AAPL. */
export function ticker(symbol: string): string {
  return symbol.replace(/c$/, '');
}
