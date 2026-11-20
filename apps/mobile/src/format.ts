import { COUNTRIES } from './countries';
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

/** The time under your finger on a chart: "2:30 PM" for a day, "Tue 2:30 PM" for a week, else "Nov 18". */
export function chartTime(ms: number, range: '1D' | '1W' | '1M' | '1Y'): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (range === '1D') return time;
  if (range === '1W') return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(range === '1Y' ? { year: 'numeric' } : {}) });
}

// +1 numbers read as (555) 010-0100. Others: the country code from the
// known list (longest match), then the rest in groups of four from the end:
// +65 9739 0081, +44 7700 900123 → +44 77 0090 0123.
export function formatPhone(e164: string): string {
  const d = e164.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) {
    return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  }
  if (!e164.startsWith('+')) return e164;
  const dial = COUNTRIES.map((c) => c.dial.slice(1))
    .filter((code) => d.startsWith(code))
    .sort((a, b) => b.length - a.length)[0];
  const cc = dial ?? d.slice(0, 2);
  const rest = d.slice(cc.length);
  const groups: string[] = [];
  for (let end = rest.length; end > 0; end -= 4) groups.unshift(rest.slice(Math.max(0, end - 4), end));
  return `+${cc} ${groups.join(' ')}`;
}
