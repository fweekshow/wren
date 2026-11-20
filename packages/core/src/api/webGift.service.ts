import { config } from "@/config/config.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { listSpotBuyableOffers } from "@/discovery/doppler/stockCatalog.js";
import {
  giftChargeUsd,
  giftOnrampUsd,
  giftSpendUsd,
  quoteStockGift,
  type GiftDeliveryChannel,
  type StockGiftRecipient,
} from "@/discovery/stocks/giftStock.service.js";
import { ContactsAdapter } from "@/messaging/contacts.adapter.js";
import { maybeAutoSaveContact } from "@/messaging/utils/autoSaveContact.utils.js";
import {
  FundSessionAdapter,
  GIFT_FUND_SESSION_TTL_MS,
  type FundSessionIntent,
} from "@/wallet/fundSession.js";
import { StockGiftAdapter, type StockGiftIntent } from "@/wallet/stockGift.js";

export class WebGiftError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "WebGiftError";
    this.status = status;
  }
}

export const WEB_GIFT_CHANNELS = ["imessage", "text", "email", "whatsapp"] as const;

export function isWebGiftChannel(value: unknown): value is GiftDeliveryChannel {
  return typeof value === "string" && (WEB_GIFT_CHANNELS as readonly string[]).includes(value);
}

export function listPublicStocks() {
  return listSpotBuyableOffers().map((offer) => ({
    symbol: offer.symbol,
    name: offer.name,
  }));
}

export async function createWebStockGiftCheckout(input: {
  senderId: string;
  channel: GiftDeliveryChannel;
  symbol: string;
  usd: string;
  memo?: string;
  recipient: { name?: string; phone?: string; contactId?: number };
  saveContact?: boolean;
}): Promise<{
  status: "pay";
  payUrl: string;
  giftId: string;
  chargeUsd: number;
  amountLabel: string;
}> {
  const embedded = await WalletAdapter.getEmbeddedWallet(input.senderId);
  if (!embedded?.address) {
    throw new WebGiftError("Sign in again, then try.", 404);
  }

  let name = input.recipient.name?.trim() || "";
  let phoneRaw = input.recipient.phone?.trim() || "";

  if (input.recipient.contactId) {
    const contacts = await ContactsAdapter.listContacts(input.senderId);
    const saved = contacts.find((c) => c.id === input.recipient.contactId);
    if (!saved) throw new WebGiftError("That contact isn't in your list.");
    name = name || saved.name;
    phoneRaw = phoneRaw || saved.contact_phone || saved.contact || "";
  }

  const channel: GiftDeliveryChannel =
    input.channel === "email" || input.channel === "text" ? "imessage" : input.channel;

  const phone = ContactsAdapter.normalizeHandle(phoneRaw);
  if (!phone) {
    throw new WebGiftError("Add their number with a country code, like +1…");
  }

  const display = name || phone || "them";
  const receiveAddress = await WalletAdapter.getReceiveAddress(phone);

  let recipient: StockGiftRecipient;
  if (receiveAddress) {
    recipient = {
      kind: "wallet",
      address: receiveAddress,
      display,
      phone,
      name: name || undefined,
      channel,
    };
  } else {
    recipient = {
      kind: "claim_phone",
      phone,
      display,
      name: name || undefined,
      channel,
    };
  }

  const quoted = await quoteStockGift({ symbol: input.symbol, usd: input.usd });
  if (!quoted.ok) throw new WebGiftError(quoted.error);

  const quote = quoted.quote;
  const intent: StockGiftIntent = {
    kind: "gift_stock",
    symbol: quote.entry.symbol,
    usd: input.usd.trim(),
    memo: input.memo?.trim() || undefined,
    recipient,
    quotedAt: new Date().toISOString(),
    maxUsd: quote.maxUsd,
    sharePriceUsd: quote.sharePriceUsd,
  };

  const spendUsd = giftSpendUsd(quote);
  const walletCharge = giftChargeUsd(spendUsd);
  const appleChargeUsd = giftOnrampUsd(spendUsd);

  if (input.saveContact && name && phone) {
    await maybeAutoSaveContact(input.senderId, { name, phone });
  }

  // Web always goes through Apple Pay — don't silently send from holdings.
  const gift = await StockGiftAdapter.create({
    senderId: input.senderId,
    walletAddress: embedded.address,
    intent,
    amountUsd: walletCharge.usdcNeeded,
  });
  await StockGiftAdapter.abandonUnpaidCheckouts({
    senderId: input.senderId,
    walletAddress: embedded.address,
    exceptGiftId: gift.id,
  });
  const fundIntent: FundSessionIntent = {
    kind: "gift_stock",
    giftId: gift.id,
    symbol: intent.symbol,
    usd: intent.usd,
    memo: intent.memo,
    recipient: {
      kind: recipient.kind,
      display: recipient.display,
      address: recipient.kind === "wallet" ? recipient.address : undefined,
      phone: recipient.phone ?? undefined,
      name: recipient.name,
    },
    quotedAt: intent.quotedAt,
    maxUsd: intent.maxUsd,
    sharePriceUsd: intent.sharePriceUsd,
  };

  const token = await FundSessionAdapter.createIntent({
    userPhone: input.senderId,
    walletAddress: embedded.address,
    amountUsd: appleChargeUsd,
    intent: fundIntent,
    ttlMs: GIFT_FUND_SESSION_TTL_MS,
  });
  await StockGiftAdapter.setFundSessionToken(gift.id, token);
  const payUrl = `${config.cdp.fundPageUrl.replace(/\/$/, "")}?s=${token}`;

  return {
    status: "pay",
    payUrl,
    giftId: gift.id,
    chargeUsd: appleChargeUsd,
    amountLabel: quote.amountLabel,
  };
}
