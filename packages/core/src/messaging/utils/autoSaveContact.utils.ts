import { ContactsAdapter } from "@/messaging/contacts.adapter.js";
import { convKey, stateDelete, stateGet, stateSet } from "@/state/conversationState.store.js";

export type AutoSaveContact = { name: string; phone: string };

const AUTO_SAVE_TTL_SEC = 30 * 60;

function pendingAutoSaveKey(senderId: string, token: string): string {
  return convKey("imessage", senderId, `pendingAutoSave:${token}`);
}

/** Persist auto-save intent until the pending pay tx confirms (or expires). */
export async function stashPendingAutoSaveContact(
  senderId: string,
  token: string,
  contact: AutoSaveContact,
): Promise<void> {
  await stateSet(pendingAutoSaveKey(senderId, token), contact, AUTO_SAVE_TTL_SEC);
}

/**
 * Save a contact after a successful send (idempotent upsert). Fires for any
 * send-to-phone that carried a real recipient name — group tag-to-send *and*
 * DM sends to a named-but-unsaved recipient — so the next send can use the
 * name. No-ops when the phone is already a saved contact.
 */
export async function maybeAutoSaveContact(
  senderId: string,
  contact: AutoSaveContact | null | undefined,
): Promise<void> {
  if (!contact?.name?.trim() || !contact.phone?.trim()) return;
  try {
    const existing = await ContactsAdapter.findByPhone(senderId, contact.phone);
    if (existing) return;
    await ContactsAdapter.saveContact(senderId, contact.name.trim(), contact.phone);
  } catch (err) {
    console.error("⚠️ [iMessage] failed to auto-save contact:", err);
  }
}

/** @deprecated Renamed to {@link maybeAutoSaveContact}. */
export const maybeAutoSaveGroupContact = maybeAutoSaveContact;

/** Consume a stashed auto-save after pending-pay success. */
export async function consumePendingAutoSaveContact(
  senderId: string,
  token: string,
): Promise<void> {
  const key = pendingAutoSaveKey(senderId, token);
  const pending = await stateGet<AutoSaveContact>(key);
  await stateDelete(key);
  await maybeAutoSaveContact(senderId, pending);
}
