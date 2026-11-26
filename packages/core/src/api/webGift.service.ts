import { config } from "@/config/config.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { listSpotBuyableOffers } from "@/discovery/doppler/stockCatalog.js";
import {
  giftChargeUsd,
  giftOnrampUsd,
  readErc20Balance,
  wrenSendCharge,
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
  details?: Record<string, unknown>;
  constructor(message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "WebGiftError";
    this.status = status;
    this.details = details;
  }
}

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

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
  /** "wren": 1.5% per send, at least $0.99, first send free. Default: Basemate's 1%. */
  pricing?: "wren";
  /** "cash": spend USDC already in the account; no card checkout. */
  payFrom?: "card" | "cash";
}): Promise<{
  status: "pay" | "sending";
  payUrl: string;
  giftId: string;
  chargeUsd: number;
  amountLabel: string;
  feeUsd?: number;
  firstSend?: boolean;
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
  let walletCharge = giftChargeUsd(spendUsd);
  let appleChargeUsd = giftOnrampUsd(spendUsd);
  let wren: { feeUsd: number; firstSend: boolean } | null = null;
  if (input.pricing === "wren") {
    const firstSend = (await StockGiftAdapter.countCompletedBySender(input.senderId)) === 0;
    const charge = wrenSendCharge(spendUsd, { firstSend });
    intent.feeUsd = charge.feeUsd;
    intent.app = "wren";
    walletCharge = { ...walletCharge, feeUsd: charge.feeUsd, ourFeeUsd: charge.feeUsd, usdcNeeded: charge.usdcNeeded, totalUsd: charge.usdcNeeded };
    appleChargeUsd = charge.totalUsd;
    wren = { feeUsd: charge.feeUsd, firstSend };
  }

  if (input.saveContact && name && phone) {
    await maybeAutoSaveContact(input.senderId, { name, phone });
  }

  if (input.payFrom === "cash") {
    // Spend cash already in the account. Check it covers stock + fee first.
    const needRaw = BigInt(Math.round(walletCharge.usdcNeeded * 1_000_000));
    const haveRaw = await readErc20Balance(USDC_ADDRESS, embedded.address).catch(() => 0n);
    if (haveRaw < needRaw) {
      throw new WebGiftError("not_enough_cash", 402, {
        cashUsd: Number(haveRaw) / 1_000_000,
        neededUsd: walletCharge.usdcNeeded,
      });
    }
    intent.buyNew = true;
    const gift = await StockGiftAdapter.create({
      senderId: input.senderId,
      walletAddress: embedded.address,
      intent,
      amountUsd: walletCharge.usdcNeeded,
    });
    return {
      status: "sending",
      payUrl: "",
      giftId: gift.id,
      chargeUsd: walletCharge.usdcNeeded,
      amountLabel: quote.amountLabel,
      ...(wren ?? {}),
    };
  }

  // Card: always through Apple Pay — don't silently send from holdings.
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
    ...(wren ?? {}),
  };
}
