import { ContactsAdapter, type ContactRow } from "@/messaging/contacts.adapter.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { formatContactSendDisplay } from "@/messaging/utils/sendDisplay.utils.js";
import {
  canonicalizeSenderId,
  isEmailHandle,
  isPhoneClaimHandle,
} from "@/messaging/utils/senderId.utils.js";
import { resolveSendRecipient } from "@/discovery/services/sendRecipient.service.js";
import {
  matchParticipantByName,
  participantIncludesPhone,
  type GroupParticipant,
} from "@/messaging/utils/groupTag.utils.js";

export type SendTargetCandidate = {
  name: string;
  phone: string | null;
};

export type SendTarget =
  | {
      kind: "wallet";
      display: string;
      address: string;
      phone?: string | null;
      name?: string;
    }
  | {
      kind: "claim_phone";
      display: string;
      phone: string;
      name?: string;
      isOnBasemate: boolean;
      basename?: string | null;
    }
  | {
      kind: "ambiguous";
      display: string;
      candidates: SendTargetCandidate[];
    }
  | {
      kind: "unknown";
      display: string;
    };

export type ResolveSendTargetInput = {
  name?: string;
  phone?: string;
  address?: string;
};

/** Result of group tag resolution, including whether the phone came from participants. */
export type TaggedGroupSendTarget = SendTarget & {
  fromGroupParticipant: boolean;
};

function contactPhone(contact: ContactRow): string | null {
  return contact.contact_phone ?? contact.contact ?? null;
}

async function walletTargetFromContact(
  contact: ContactRow,
  queryName?: string,
): Promise<SendTarget | null> {
  const phone = contactPhone(contact);
  const name = contact.name || queryName || "contact";
  if (phone) {
    const receive = await WalletAdapter.getReceiveAddress(phone);
    if (receive) {
      return {
        kind: "wallet",
        address: receive.toLowerCase(),
        phone,
        name,
        display: formatContactSendDisplay({ name, phone, fallback: name }),
      };
    }
  }
  // Fall back to resolveWallet join (handles digit/+ variants in SQL)
  const resolved = await ContactsAdapter.resolveWallet(
    contact.contact_owner,
    contact.name,
  );
  if (resolved?.address) {
    return {
      kind: "wallet",
      address: resolved.address.toLowerCase(),
      phone: resolved.phone ?? phone,
      name,
      display: formatContactSendDisplay({
        name,
        phone: resolved.phone ?? phone,
        fallback: name,
      }),
    };
  }
  return null;
}

async function claimTargetFromContact(
  contact: ContactRow,
  queryName?: string,
): Promise<SendTarget | null> {
  const phone = contactPhone(contact);
  if (!phone || !isPhoneClaimHandle(phone)) return null;
  const canonicalPhone = canonicalizeSenderId(phone);
  const identity = await WalletAdapter.getIdentity(canonicalPhone);
  const name = contact.name || queryName || "contact";
  return {
    kind: "claim_phone",
    phone: canonicalPhone,
    name,
    display: formatContactSendDisplay({ name, phone: canonicalPhone, fallback: name }),
    isOnBasemate: Boolean(identity),
    basename: identity?.basename ?? null,
  };
}

/**
 * Single send-resolution API for handler + AI tools.
 *
 * Owner-scoped contacts only — never global name search.
 * Exact name → fuzzy → phone → 0x/basename.
 */
export async function resolveSendTarget(
  ownerId: string,
  input: ResolveSendTargetInput,
): Promise<SendTarget> {
  const ownerKey = await WalletAdapter.resolveSenderKey(ownerId);

  // ── Address / basename / ENS ────────────────────────────────────────────
  const addressOrName = input.address?.trim() || "";
  if (addressOrName) {
    const direct = await resolveSendRecipient(addressOrName);
    if (!("error" in direct)) {
      if (/^0x[a-fA-F0-9]{40}$/i.test(addressOrName)) {
        const contact = await ContactsAdapter.findByWalletAddress(ownerKey, addressOrName);
        if (contact) {
          const phone = contactPhone(contact);
          return {
            kind: "wallet",
            address: direct.address,
            phone,
            name: contact.name,
            display: formatContactSendDisplay({
              name: contact.name,
              phone,
              fallback: direct.display,
            }),
          };
        }
      }
      return {
        kind: "wallet",
        address: direct.address,
        display: direct.display,
      };
    }
  }

  // ── Explicit phone ──────────────────────────────────────────────────────
  if (input.phone?.trim()) {
    const phone = ContactsAdapter.normalizeHandle(input.phone) ?? canonicalizeSenderId(input.phone);
    if (isEmailHandle(phone) || !isPhoneClaimHandle(phone)) {
      return { kind: "unknown", display: input.phone.trim() };
    }
    const saved = await ContactsAdapter.findByPhone(ownerKey, phone);
    const name = saved?.name;
    const receive = await WalletAdapter.getReceiveAddress(phone);
    if (receive) {
      return {
        kind: "wallet",
        address: receive.toLowerCase(),
        phone,
        name,
        display: formatContactSendDisplay({
          name,
          phone,
          fallback: phone,
        }),
      };
    }
    const identity = await WalletAdapter.getIdentity(phone);
    return {
      kind: "claim_phone",
      phone,
      name,
      display: formatContactSendDisplay({ name, phone, fallback: phone }),
      isOnBasemate: Boolean(identity),
      basename: identity?.basename ?? null,
    };
  }

  // ── Name (exact → fuzzy) ────────────────────────────────────────────────
  const name = input.name?.trim();
  if (!name) {
    return { kind: "unknown", display: addressOrName || "" };
  }

  const fuzzy = await ContactsAdapter.findByNameFuzzy(ownerKey, name);
  if (fuzzy.ambiguous) {
    return {
      kind: "ambiguous",
      display: name,
      candidates: fuzzy.matches.map((c) => ({
        name: c.name,
        phone: contactPhone(c),
      })),
    };
  }

  const contact = fuzzy.matches[0];
  if (!contact) {
    return { kind: "unknown", display: name };
  }

  const wallet = await walletTargetFromContact(contact, name);
  if (wallet) return wallet;

  const claim = await claimTargetFromContact(contact, name);
  if (claim) return claim;

  return { kind: "unknown", display: name };
}

/**
 * Resolve a tagged group member for send/escrow.
 *
 * 1. Participant display-name match → phone from space
 * 2. Owner contacts matching the tag whose phone is in the participant set
 * 3. Fallback: owner-scoped contact name resolution
 */
export async function resolveTaggedGroupRecipient(
  ownerId: string,
  tagName: string,
  participants: GroupParticipant[],
): Promise<TaggedGroupSendTarget> {
  const name = tagName.trim();
  if (!name) {
    return { kind: "unknown", display: "", fromGroupParticipant: false };
  }

  // 1. Spectrum participant name → phone
  const byParticipantName = matchParticipantByName(name, participants);
  if (byParticipantName) {
    const target = await resolveSendTarget(ownerId, {
      phone: byParticipantName.id,
    });
    // Prefer the tagged / participant display name over a saved contact name.
    if (target.kind === "wallet" || target.kind === "claim_phone") {
      const displayName = byParticipantName.name?.trim() || name;
      return {
        ...target,
        name: displayName,
        display: formatContactSendDisplay({
          name: displayName,
          phone: target.kind === "claim_phone" ? target.phone : target.phone,
          fallback: displayName,
        }),
        fromGroupParticipant: true,
      };
    }
    return { ...target, fromGroupParticipant: true };
  }

  // 2. Contacts matching the tag that are also in this group
  const ownerKey = await WalletAdapter.resolveSenderKey(ownerId);
  const fuzzy = await ContactsAdapter.findByNameFuzzy(ownerKey, name);
  if (participants.length > 0 && fuzzy.matches.length > 0) {
    const inGroup = fuzzy.matches.filter((c) => {
      const phone = contactPhone(c);
      return phone ? participantIncludesPhone(participants, phone) : false;
    });
    if (inGroup.length === 1) {
      const contact = inGroup[0]!;
      const phone = contactPhone(contact);
      if (phone) {
        const target = await resolveSendTarget(ownerId, { phone });
        if (target.kind === "wallet" || target.kind === "claim_phone") {
          return {
            ...target,
            name: contact.name || name,
            display: formatContactSendDisplay({
              name: contact.name || name,
              phone: target.kind === "claim_phone" ? target.phone : target.phone,
              fallback: contact.name || name,
            }),
            fromGroupParticipant: true,
          };
        }
        return { ...target, fromGroupParticipant: true };
      }
    }
    if (inGroup.length > 1) {
      return {
        kind: "ambiguous",
        display: name,
        candidates: inGroup.map((c) => ({
          name: c.name,
          phone: contactPhone(c),
        })),
        fromGroupParticipant: false,
      };
    }
  }

  // 3. Fallback: contact book only
  const fallback = await resolveSendTarget(ownerId, { name });
  return { ...fallback, fromGroupParticipant: false };
}
