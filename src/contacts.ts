// Load, normalize, and shape the address book for the Someone screen.
// Rules:
//   - Hide email-only contacts.
//   - Keep a contact only if at least one phone number is parseable E.164
//     (leading +, 7–15 digits after it).
//   - A phone with no + is NOT confidently international, so it does not
//     open Amount by itself — we surface the country sheet instead.
//   - Last name is rendered gray only when two people share a first name.

import * as Contacts from 'expo-contacts';

export type PhoneOption = {
  label?: string;
  raw: string; // what the user had typed
  e164?: string; // normalized if we could
};

export type Person = {
  id: string;
  firstName: string;
  lastName: string;
  phones: PhoneOption[];
  // Best guess for the single phone to send to (first E.164, else first raw).
  bestPhone?: PhoneOption;
  // Precomputed search tokens, lowercase.
  firstLower: string;
  lastLower: string;
  // True when the contact has any usable E.164 phone (i.e. appears in the
  // import payload and can continue without the country picker).
  hasE164: boolean;
};

const E164 = /^\+\d{7,15}$/;

function normalizeDigits(raw: string): string {
  return raw.replace(/[^\d+]/g, '');
}

export function toE164(raw: string): string | undefined {
  const s = normalizeDigits(raw);
  if (!s) return undefined;
  if (s.startsWith('+')) {
    const candidate = '+' + s.slice(1).replace(/\D/g, '');
    return E164.test(candidate) ? candidate : undefined;
  }
  return undefined;
}

export function applyDialCode(raw: string, dial: string): string | undefined {
  const digits = normalizeDigits(raw).replace(/^\+/, '').replace(/\D/g, '');
  if (!digits) return undefined;
  const candidate = `${dial}${digits}`;
  return E164.test(candidate) ? candidate : undefined;
}

function cleanName(s: string | null | undefined): string {
  return (s ?? '').trim();
}

function splitDisplayName(display: string | null | undefined): { first: string; last: string } {
  const name = cleanName(display);
  if (!name) return { first: '', last: '' };
  const parts = name.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

export async function requestContactsPermission(): Promise<Contacts.ContactsPermissionResponse> {
  return Contacts.requestPermissionsAsync();
}

export async function getContactsPermission(): Promise<Contacts.ContactsPermissionResponse> {
  return Contacts.getPermissionsAsync();
}

export async function loadContacts(): Promise<Person[]> {
  const { data } = await Contacts.getContactsAsync({
    fields: [
      Contacts.Fields.FirstName,
      Contacts.Fields.LastName,
      Contacts.Fields.Name,
      Contacts.Fields.PhoneNumbers,
    ],
  });
  const people: Person[] = [];
  for (const c of data) {
    const phonesRaw = c.phoneNumbers ?? [];
    if (!phonesRaw.length) continue; // hide email-only contacts

    const phones: PhoneOption[] = [];
    for (const p of phonesRaw) {
      const raw = p.number ?? p.digits ?? '';
      if (!raw) continue;
      const e164 = toE164(raw);
      phones.push({ label: p.label ?? undefined, raw, e164 });
    }
    if (!phones.length) continue;

    let first = cleanName(c.firstName);
    let last = cleanName(c.lastName);
    if (!first && !last) {
      const split = splitDisplayName(c.name);
      first = split.first;
      last = split.last;
    }
    if (!first && !last) continue;

    const bestPhone = phones.find((p) => p.e164) ?? phones[0];
    people.push({
      id: c.id ?? `${first}-${last}-${phones[0].raw}`,
      firstName: first,
      lastName: last,
      phones,
      bestPhone,
      firstLower: first.toLowerCase(),
      lastLower: last.toLowerCase(),
      hasE164: phones.some((p) => !!p.e164),
    });
  }
  // Alphabetize for the main list.
  people.sort((a, b) => {
    const f = a.firstLower.localeCompare(b.firstLower);
    return f !== 0 ? f : a.lastLower.localeCompare(b.lastLower);
  });
  return people;
}

// Matches first and last name as whole-word "starts with" against each token.
// "pri" matches "Priya Mehta". "me" matches "Priya Mehta" via last name.
export function searchPeople(people: Person[], q: string): Person[] {
  const t = q.trim().toLowerCase();
  if (!t) return people;
  return people.filter(
    (p) => p.firstLower.startsWith(t) || p.lastLower.startsWith(t),
  );
}

// If two people in the result share a first name, the last name is shown in
// gray next to each to disambiguate. This helper returns that set.
export function duplicatedFirstNames(list: Person[]): Set<string> {
  const counts = new Map<string, number>();
  for (const p of list) {
    counts.set(p.firstLower, (counts.get(p.firstLower) ?? 0) + 1);
  }
  const dups = new Set<string>();
  counts.forEach((n, k) => {
    if (n > 1) dups.add(k);
  });
  return dups;
}
