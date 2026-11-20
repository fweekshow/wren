import { config } from "@/config/config.js";
import { canonicalizeSenderId } from "@/messaging/utils/senderId.utils.js";
import { scoreFuzzyContactName } from "@/messaging/utils/fuzzyName.utils.js";

/** Group member handle from Spectrum space.participants. */
export type GroupParticipant = {
  id: string;
  name?: string;
};

const PERSON_TAG_RE = /(?:^|[^A-Za-z0-9_])@([A-Za-z][A-Za-z0-9_-]{0,39})\b/g;

/** Configured bot mention handles (bare forms), lowercased. */
function botMentionNames(): Set<string> {
  const names = new Set<string>();
  for (const raw of config.mentionHandle.split(",")) {
    const bare = raw.trim().replace(/\.(base\.)?eth$/i, "").toLowerCase();
    if (bare) names.add(bare);
  }
  if (names.size === 0) names.add("basemate");
  return names;
}

/**
 * Extract @person tags from text, excluding the Basemate bot mention.
 * Returns display names without the leading @, in order of appearance.
 */
export function extractPersonTags(text: string): string[] {
  const bot = botMentionNames();
  const tags: string[] = [];
  const seen = new Set<string>();
  PERSON_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PERSON_TAG_RE.exec(text)) !== null) {
    const name = match[1]!.trim();
    const key = name.toLowerCase();
    if (bot.has(key) || seen.has(key)) continue;
    seen.add(key);
    tags.push(name);
  }
  return tags;
}

/** First non-bot @tag in the message, if any. */
export function extractPrimaryPersonTag(text: string): string | null {
  return extractPersonTags(text)[0] ?? null;
}

/**
 * Normalize Spectrum `space.participants` (string handles or objects) into
 * canonical group participant records.
 */
export function normalizeGroupParticipants(raw: unknown): GroupParticipant[] {
  if (!Array.isArray(raw)) return [];
  const out: GroupParticipant[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    let idRaw: string | null = null;
    let name: string | undefined;

    if (typeof entry === "string") {
      idRaw = entry.trim();
    } else if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      const idCandidate =
        (typeof obj.id === "string" && obj.id) ||
        (typeof obj.handle === "string" && obj.handle) ||
        (typeof obj.phone === "string" && obj.phone) ||
        (typeof obj.address === "string" && obj.address) ||
        null;
      idRaw = idCandidate?.trim() || null;
      const nameCandidate =
        (typeof obj.name === "string" && obj.name) ||
        (typeof obj.displayName === "string" && obj.displayName) ||
        (typeof obj.formatted === "string" && obj.formatted) ||
        null;
      if (nameCandidate?.trim()) name = nameCandidate.trim();
    }

    if (!idRaw) continue;
    const id = canonicalizeSenderId(idRaw);
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    out.push(name ? { id, name } : { id });
  }

  return out;
}

/**
 * Best unique participant whose display name fuzzy-matches `tagName`.
 * Returns null when no match or multiple equally good matches.
 */
export function matchParticipantByName(
  tagName: string,
  participants: GroupParticipant[],
): GroupParticipant | null {
  const named = participants.filter((p) => p.name?.trim());
  if (named.length === 0) return null;

  const scored = named
    .map((p) => {
      const score = scoreFuzzyContactName(tagName, p.name!);
      return score ? { participant: p, score } : null;
    })
    .filter(
      (x): x is { participant: GroupParticipant; score: NonNullable<ReturnType<typeof scoreFuzzyContactName>> } =>
        !!x,
    )
    .sort((a, b) => a.score.rank - b.score.rank || a.score.distance - b.score.distance);

  if (scored.length === 0) return null;
  const best = scored[0]!;
  const ties = scored.filter(
    (s) => s.score.rank === best.score.rank && s.score.distance === best.score.distance,
  );
  const uniqueIds = new Set(ties.map((t) => t.participant.id.toLowerCase()));
  if (uniqueIds.size !== 1) return null;
  return best.participant;
}

/** Participant phone/id set for membership checks (canonical + lowercase). */
export function participantPhoneSet(participants: GroupParticipant[]): Set<string> {
  const set = new Set<string>();
  for (const p of participants) {
    set.add(p.id.toLowerCase());
    const digits = p.id.replace(/\D/g, "");
    if (digits) set.add(digits);
  }
  return set;
}

export function participantIncludesPhone(
  participants: GroupParticipant[],
  phone: string,
): boolean {
  const set = participantPhoneSet(participants);
  const canonical = canonicalizeSenderId(phone).toLowerCase();
  if (set.has(canonical)) return true;
  const digits = phone.replace(/\D/g, "");
  return Boolean(digits && set.has(digits));
}
