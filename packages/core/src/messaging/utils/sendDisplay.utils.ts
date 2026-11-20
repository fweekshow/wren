/**
 * Human-facing recipient label for send confirms.
 * Prefer phone (max abstraction for non-crypto users); never lead with 0x when
 * a contact phone is known.
 */
export function formatContactSendDisplay(opts: {
  name?: string | null;
  phone?: string | null;
  fallback: string;
}): string {
  const phone = opts.phone?.trim() || null;
  const name = opts.name?.trim() || null;
  const nameIsAddress = !!name && /^0x[a-fA-F0-9]{40}$/i.test(name);
  if (name && phone && !nameIsAddress) return `${name} (${phone})`;
  if (phone) return phone;
  if (name && !nameIsAddress) return name;
  return opts.fallback;
}
