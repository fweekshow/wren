import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { listSpotBuyableOffers } from "@/discovery/doppler/stockCatalog.js";
import {
  giftChargeUsd,
  giftSpendUsd,
  quoteStockGift,
  type StockGiftRecipient,
} from "@/discovery/stocks/giftStock.service.js";
import {
  FundSessionAdapter,
  GIFT_FUND_SESSION_TTL_MS,
  type FundSessionIntent,
} from "@/wallet/fundSession.js";
import { formatRecipientLine, museTrackCopy } from "@/api/muse.status.js";
import { basemateAccountOrigin } from "@/wallet/accountOrigin.js";
import { PhoneEscrowAdapter } from "@/wallet/phoneEscrow.js";
import { StockGiftAdapter, type StockGiftIntent } from "@/wallet/stockGift.js";
import { CLAIM_SESSION_TTL_MS, WalletSetupSessionAdapter } from "@/wallet/walletSetupSession.js";
import { OnrampUserDataAdapter } from "@/wallet/onrampUserData.js";
import { config } from "@/config/config.js";
import { db } from "@/discovery/db.js";

export class MuseCheckoutError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MuseCheckoutError";
  }
}

export type MuseCheckoutResult =
  | {
      status: "needs_connect";
      connectUrl: string;
      amountLabel: string;
      chargeUsd: number;
      hint: string;
      headline: string;
      recipientLine: string;
      sayThis: string;
      alreadyOnBasemate: false;
      delivery: "claim";
    }
  | {
      status: "awaiting_payment";
      sendId: string;
      giftId: string;
      payUrl: string;
      amountLabel: string;
      chargeUsd: number;
      headline: string;
      recipientLine: string;
      sayThis: string;
      alreadyOnBasemate: boolean;
      delivery: "wallet" | "claim";
      mustPoll: true;
      pollEveryMs: 1000;
      pollPath: string;
    };

export function listPublicMuseStocks() {
  return listSpotBuyableOffers().map((offer) => ({
    symbol: offer.symbol,
    name: offer.name,
  }));
}

export function assertMusePayUrl(payUrl: string): string {
  const hosts = new Set(
    [config.cdp.fundPageDomain, `www.${config.cdp.fundPageDomain}`].map((h) => h.toLowerCase()),
  );
  let parsed: URL;
  try {
    parsed = new URL(payUrl);
  } catch {
    throw new MuseCheckoutError("Pay URL is invalid.", 500);
  }
  if (!hosts.has(parsed.hostname.toLowerCase()) || !parsed.pathname.toLowerCase().includes("pay")) {
    throw new MuseCheckoutError("Pay URL is not the allowlisted Apple Pay page.", 500);
  }
  return payUrl;
}

function requireE164(raw: string | undefined, label: string): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    throw new MuseCheckoutError(`${label} phone is required (E.164, e.g. +15555550123).`, 400);
  }
  try {
    return PhoneEscrowAdapter.normalizePhone(trimmed);
  } catch {
    throw new MuseCheckoutError(`${label} phone must be E.164 (e.g. +15555550123).`, 400);
  }
}

export async function createMuseStockGiftCheckout(input: {
  symbol: string;
  usd: string;
  memo?: string;
  payer: { phone?: string; email?: string; name?: string };
  recipient: { name?: string; phone?: string; email?: string };
}): Promise<MuseCheckoutResult> {
  const payerPhone = requireE164(input.payer.phone, "Payer");
  const recipientPhone = requireE164(input.recipient.phone, "Recipient");
  const recipientLine = formatRecipientLine(input.recipient.name, recipientPhone);
  const headline = "Stock is ready to send";
  const sayThis = `${headline} to ${recipientLine}`;

  const quoted = await quoteStockGift({ symbol: input.symbol, usd: input.usd });
  if (!quoted.ok) {
    throw new MuseCheckoutError(quoted.error, 400);
  }
  const quote = quoted.quote;
  const spendUsd = giftSpendUsd(quote);
  const walletCharge = giftChargeUsd(spendUsd);
  const appleCharge = giftChargeUsd(spendUsd, { applePay: true });

  let payerId = payerPhone;
  let embedded = await WalletAdapter.getEmbeddedWallet(payerId);
  if (!embedded?.address && input.payer.email?.trim()) {
    const linkedPhone = await OnrampUserDataAdapter.findPhoneByEmail(input.payer.email);
    if (linkedPhone) {
      const byEmail = await WalletAdapter.getEmbeddedWallet(linkedPhone);
      if (byEmail?.address) {
        payerId = linkedPhone;
        embedded = byEmail;
      }
    }
  }
  const payerName = input.payer.name?.trim();
  if (
    payerName &&
    !/^\+?\d{7,15}$/.test(payerName.replace(/[\s-]/g, "")) &&
    !(await WalletAdapter.getDisplayName(payerId))
  ) {
    try {
      await WalletAdapter.setDisplayName(payerId, payerName);
    } catch {
      // Name is best-effort for recipient texts.
    }
  }
  if (!embedded?.address) {
    const token = await WalletSetupSessionAdapter.create(payerPhone, CLAIM_SESSION_TTL_MS);
    const connect = new URL(`${basemateAccountOrigin(config.payPage.origin)}/wallet/connect`);
    connect.searchParams.set("s", token);
    return {
      status: "needs_connect",
      connectUrl: connect.toString(),
      amountLabel: quote.amountLabel,
      chargeUsd: appleCharge.totalUsd,
      headline,
      recipientLine,
      sayThis,
      alreadyOnBasemate: false,
      delivery: "claim",
      hint: "Already have Basemate? Open this link and sign in with the same email. New users create an account on that page. Then send again.",
    };
  }

  const receive = await WalletAdapter.getReceiveAddress(recipientPhone);
  const alreadyOnBasemate = Boolean(receive);
  const display = recipientLine;
  const recipient: StockGiftRecipient = receive
    ? {
        kind: "wallet",
        address: receive,
        display,
        phone: recipientPhone,
        name: input.recipient.name?.trim() || undefined,
      }
    : {
        kind: "claim_phone",
        phone: recipientPhone,
        display,
        name: input.recipient.name?.trim() || undefined,
      };

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

  const gift = await StockGiftAdapter.create({
    senderId: payerId,
    walletAddress: embedded.address,
    intent,
    amountUsd: walletCharge.usdcNeeded,
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
      phone: recipientPhone,
      name: recipient.name,
    },
    quotedAt: intent.quotedAt,
    maxUsd: intent.maxUsd,
    sharePriceUsd: intent.sharePriceUsd,
  };

  const token = await mintMuseFundSession({
    payerPhone: payerId,
    walletAddress: embedded.address,
    amountUsd: appleCharge.totalUsd,
    fundIntent,
  });
  await db.query(`UPDATE stock_gifts SET fund_session_token = $2 WHERE id = $1`, [gift.id, token]);

  const track = museTrackCopy({
    status: "awaiting_payment",
    recipientLine,
    amountLabel: quote.amountLabel,
    alreadyOnBasemate,
  });
  return {
    status: "awaiting_payment",
    sendId: gift.id,
    giftId: gift.id,
    payUrl: assertMusePayUrl(`${config.cdp.fundPageUrl}?s=${token}`),
    amountLabel: quote.amountLabel,
    chargeUsd: appleCharge.totalUsd,
    headline,
    recipientLine,
    sayThis,
    mustPoll: true,
    pollEveryMs: 1000,
    pollPath: `/api/muse/sends/${gift.id}`,
    alreadyOnBasemate: track.alreadyOnBasemate,
    delivery: track.delivery,
  };
}

/** Same split as iMessage confirmGiftStock: pre-mint Apple Pay when onramp is ready. */
async function mintMuseFundSession(input: {
  payerPhone: string;
  walletAddress: string;
  amountUsd: number;
  fundIntent: FundSessionIntent;
}): Promise<string> {
  const userData = config.cdp.enabled ? await OnrampUserDataAdapter.get(input.payerPhone) : null;

  if (OnrampUserDataAdapter.isReadyForOnramp(userData)) {
    const { buildHeadlessFundLinks, isCoinbaseRegionForbiddenError } = await import(
      "@/wallet/onramp.js"
    );
    const partnerUserRef = config.cdp.onrampSandbox
      ? `sandbox-${input.payerPhone.replace(/[^a-z0-9]/gi, "").slice(0, 40)}`
      : `im-${input.payerPhone.replace(/[^a-z0-9]/gi, "").slice(0, 47)}`;
    try {
      const headless = await buildHeadlessFundLinks({
        senderId: input.payerPhone,
        address: input.walletAddress,
        amount: String(input.amountUsd),
        email: userData.email,
        agreementAcceptedAt: userData.tosAcceptedAt,
        phoneNumberVerifiedAt: userData.phoneVerifiedAt,
        partnerUserRef,
      });
      if (headless.paymentLinkOptions.length > 0) {
        return FundSessionAdapter.create(
          input.payerPhone,
          headless.paymentLinkOptions[0].url,
          headless.paymentLinkOptions,
          input.amountUsd,
          input.walletAddress,
          undefined,
          { intent: input.fundIntent, ttlMs: GIFT_FUND_SESSION_TTL_MS },
        );
      }
    } catch (err) {
      if (!isCoinbaseRegionForbiddenError(err)) throw err;
    }
  }

  return FundSessionAdapter.createIntent({
    userPhone: input.payerPhone,
    walletAddress: input.walletAddress,
    amountUsd: input.amountUsd,
    intent: input.fundIntent,
    ttlMs: GIFT_FUND_SESSION_TTL_MS,
  });
}
