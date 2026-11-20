import { config } from "@/config/config.js";
import type { TxConfirmationRow } from "@/discovery/adapters/txConfirmation.adapter.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { WalletSetupSessionAdapter, CLAIM_SESSION_TTL_MS } from "@/wallet/walletSetupSession.js";

import { ContactsAdapter } from "./contacts.adapter.js";

export async function resolveSenderDisplayName(
  recipientPhone: string,
  senderId: string,
): Promise<string> {
  const senderPhone = ContactsAdapter.normalizeHandle(senderId);
  if (senderPhone) {
    const savedContact = await ContactsAdapter.findByPhone(recipientPhone, senderPhone);
    if (savedContact?.name.trim()) return savedContact.name.trim();
  }

  const profileName =
    (await WalletAdapter.getDisplayName(senderId)) ||
    (senderPhone && senderPhone !== senderId ? await WalletAdapter.getDisplayName(senderPhone) : null);
  if (profileName) return profileName;
  return senderPhone ?? senderId;
}

async function mintClaimUrl(phone: string, giftId: string): Promise<string> {
  const token = await WalletSetupSessionAdapter.create(phone, CLAIM_SESSION_TTL_MS);
  const url = new URL(`wren://g/${encodeURIComponent(giftId)}`);
  url.searchParams.set("s", token);
  return url.toString();
}

export async function buildRecipientTransferNotification(
  row: TxConfirmationRow,
): Promise<{ phone: string; message: string; requiresClaim: boolean } | null> {
  const phone = ContactsAdapter.normalizeHandle(row.recipient_phone);
  const amount = row.transfer_amount?.trim();
  // A bundle send stores its whole summary in `amount` (e.g. "5 USDC + 10 ETH")
  // and leaves asset empty, so only phone + amount are required here.
  const asset = row.transfer_asset?.trim().toUpperCase();
  const memo = row.transfer_memo?.trim();
  if (!phone || !amount) return null;
  const amountLabel = asset ? `${amount} ${asset}` : amount;
  const memoLine = memo ? `"${memo}"` : null;

  const senderName = await resolveSenderDisplayName(phone, row.sender_id);

  const recipientBaseAddress = await WalletAdapter.getReceiveAddress(phone);
  const requiresClaim = !recipientBaseAddress;
  const claimUrl = requiresClaim ? await mintClaimUrl(phone, row.sid) : null;

  const deadline = requiresClaim
    ? `Open it within ${config.phoneEscrow.claimTtlHours} hours or it goes back.`
    : null;

  const message = requiresClaim
    ? [`${senderName} sent you ${amountLabel}.`, memoLine, claimUrl, deadline]
        .filter(Boolean)
        .join("\n\n")
    : [`${senderName} sent you ${amountLabel}.`, memoLine].filter(Boolean).join("\n\n");

  return { phone, message, requiresClaim };
}

export async function buildDeferredRecipientClaimNotification(
  recipientPhone: string,
  rows: TxConfirmationRow[],
): Promise<{ phone: string; message: string } | null> {
  const phone = ContactsAdapter.normalizeHandle(recipientPhone);
  if (!phone || rows.length === 0) return null;

  // The recipient may have completed setup through another path after the
  // proactive transfer notice. In that case the claimed rows can be closed
  // without sending a redundant setup link.
  if (await WalletAdapter.getReceiveAddress(phone)) return null;

  const transferLabels = rows.flatMap((row) => {
    const amount = row.transfer_amount?.trim();
    if (!amount) return [];
    const asset = row.transfer_asset?.trim().toUpperCase();
    return [asset ? `${amount} ${asset}` : amount];
  });
  if (transferLabels.length === 0) return null;

  const setupUrl = await mintClaimUrl(phone, rows[0]?.sid ?? phone);
  const summary = transferLabels.join(" + ");
  const readyText = transferLabels.length === 1 ? `${summary} is ready` : `${summary} is ready`;

  return {
    phone,
    message:
      `${readyText}.\n\n` +
      `${setupUrl}\n\n` +
      `Open it within ${config.phoneEscrow.claimTtlHours} hours or it goes back.`,
  };
}
