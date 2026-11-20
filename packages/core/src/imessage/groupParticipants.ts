import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";

import { ContactsAdapter } from "@/messaging/contacts.adapter.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { canonicalizeSenderId } from "@/messaging/utils/senderId.utils.js";
import {
  normalizeGroupParticipants,
  type GroupParticipant,
} from "@/messaging/utils/groupTag.utils.js";

type GroupChatClient = {
  chats: Pick<AdvancedIMessage["chats"], "get">;
  messages: Pick<AdvancedIMessage["messages"], "get">;
};

function isLikelyHandle(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!v || v.includes(";")) return false;
  return /^\+?[0-9]{6,15}$/.test(v) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
}

function upsertParticipant(
  byId: Map<string, GroupParticipant>,
  idRaw: string,
  name?: string,
): void {
  const id = canonicalizeSenderId(idRaw);
  if (!id || !isLikelyHandle(id)) return;
  const key = id.toLowerCase();
  const existing = byId.get(key);
  const trimmedName = name?.trim();
  if (existing) {
    if (!existing.name?.trim() && trimmedName) {
      byId.set(key, { id: existing.id, name: trimmedName });
    }
    return;
  }
  byId.set(key, trimmedName ? { id, name: trimmedName } : { id });
}

/**
 * Attach display names from the sender's contact book and Basemate profiles
 * so plain-text "send to Shivam" can match group roster phones.
 */
export async function enrichGroupParticipantNames(
  ownerId: string,
  participants: GroupParticipant[],
): Promise<GroupParticipant[]> {
  if (participants.length === 0) return participants;

  return Promise.all(
    participants.map(async (p) => {
      if (p.name?.trim()) return p;
      try {
        const contact = await ContactsAdapter.findByPhone(ownerId, p.id);
        const contactName = contact?.name?.trim();
        if (contactName) return { id: p.id, name: contactName };
      } catch {
        // best-effort
      }
      try {
        const display = await WalletAdapter.getDisplayName(p.id);
        const displayName = display?.trim();
        if (displayName) return { id: p.id, name: displayName };
      } catch {
        // best-effort
      }
      return p;
    }),
  );
}

/**
 * Spectrum webhooks do not include `space.participants` (only id/type/phone).
 * Resolve the live roster via Photon's chat APIs and enrich with known names.
 *
 * @see https://photon.codes/docs/spectrum-ts/spaces-and-users
 * @see https://photon.codes/docs/advanced-kits/imessage/chats
 */
export async function resolveLiveGroupParticipants(opts: {
  client: GroupChatClient | undefined;
  spaceId: string;
  senderId: string;
  messageId?: string;
  /** Optional seed from webhook/stream payload (usually empty). */
  seed?: unknown;
}): Promise<GroupParticipant[]> {
  const byId = new Map<string, GroupParticipant>();

  for (const p of normalizeGroupParticipants(opts.seed)) {
    upsertParticipant(byId, p.id, p.name);
  }

  if (opts.client && opts.spaceId.trim()) {
    try {
      const chat = await opts.client.chats.get(opts.spaceId.trim());
      for (const part of chat.participants ?? []) {
        upsertParticipant(byId, part.address);
      }
    } catch (err) {
      console.warn(
        `⚠️ [iMessage] failed to fetch group participants for ${opts.spaceId}:`,
        err,
      );
    }

    if (opts.messageId?.trim()) {
      try {
        const msg = await opts.client.messages.get(opts.messageId.trim());
        const text = msg.content?.text ?? "";
        for (const mention of msg.content?.mentions ?? []) {
          const slice = text.slice(mention.start, mention.start + mention.length);
          const name = slice.replace(/^@/, "").trim();
          upsertParticipant(byId, mention.address, name || undefined);
        }
      } catch (err) {
        // Mentions are optional enrichment — roster from chats.get is enough.
        console.warn(
          `⚠️ [iMessage] failed to load mentions for ${opts.messageId}:`,
          err,
        );
      }
    }
  }

  return enrichGroupParticipantNames(opts.senderId, [...byId.values()]);
}
