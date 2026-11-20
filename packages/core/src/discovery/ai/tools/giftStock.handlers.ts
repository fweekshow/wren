/**
 * gift_stock — send a Coinbase B20 tokenized equity.
 *
 * Wizard:
 *   1. Resolve recipient (phone / pick if ambiguous)
 *   2. Quote (shares or $ notional)
 *   3. One message: who + number + optional note (skip ok)
 *   4. Send from holdings if the wallet already holds the stock; else the Apple Pay link
 *   5. Buy+send after Apple Pay clears
 */

import { config } from "@/config/config.js";
import type { RespondCtx, ToolResult } from "@/discovery/ai/toolbox.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import {
  formatUsdAmount,
  giftChargeUsd,
  giftOnrampUsd,
  giftSpendUsd,
  quoteStockGift,
  readErc20Balance,
  walletHasStockGiftShares,
  type StockGiftQuote,
  type StockGiftRecipient,
} from "@/discovery/stocks/giftStock.service.js";
import { ContactsAdapter, type ContactRow } from "@/messaging/contacts.adapter.js";
import { smsOptInAskFor } from "@/messaging/smsConsentGate.js";
import { maybeAutoSaveContact } from "@/messaging/utils/autoSaveContact.utils.js";
import { extractGiftPhone } from "@/discovery/ai/intents.js";
import { formatPhoneDisplay } from "@/messaging/utils/contacts.utils.js";
import { convKey, stateSet } from "@/state/conversationState.store.js";
import {
  FundSessionAdapter,
  GIFT_FUND_SESSION_TTL_MS,
  type FundSessionIntent,
} from "@/wallet/fundSession.js";
import {
  fulfillStockGift,
  scheduleStockGiftFulfill,
  StockGiftAdapter,
  type StockGiftIntent,
} from "@/wallet/stockGift.js";

export type PendingGiftStock = {
  createdAt: number;
  step: "phone" | "pick" | "note" | "pay" | "confirm";
  to: string;
  stock: string;
  amount: string;
  isUsd: boolean;
  memo?: string;
  hasWalletStock?: boolean;
  recipient?: StockGiftRecipient;
  candidates?: { name: string; phone: string }[];
  quote: {
    plainName: string;
    amountLabel: string;
    usdcCostHuman: string;
    notionalUsd: number;
    maxUsd: number;
    sharesHuman: string;
    symbol: string;
    sharePriceUsd: number;
  };
};

export function pendingGiftStockKey(platform: string, senderId: string): string {
  return convKey(platform, senderId, "pendingGiftStock");
}

export function looksLikeCancelGift(text: string): boolean {
  return /^(cancel|nvm|stop|no)$/i.test(text.trim());
}

export function looksLikeRetryGift(text: string): boolean {
  return /^retry(?:\s+gift)?$/i.test(text.trim());
}

/** Bare "apple" is the stock, not the pay method. */
export function looksLikeGiftApplePay(text: string): boolean {
  return /^(?:apple\s*pay|use apple pay|pay|card)$/i.test(text.trim());
}

export function whoLabel(recipient: StockGiftRecipient): string {
  const name = recipient.name?.trim();
  const phone = recipient.phone?.trim();
  const prettyPhone = phone ? formatPhoneDisplay(phone) : null;
  if (name && prettyPhone) return `${name} · ${prettyPhone}`;
  if (prettyPhone) return prettyPhone;
  return name || recipient.display;
}

function whoForPending(pending: PendingGiftStock): string {
  if (pending.recipient) return whoLabel(pending.recipient);
  const phone = extractGiftPhone(pending.to);
  return phone ? formatPhoneDisplay(phone) : pending.to;
}

function snapshotQuote(quote: StockGiftQuote): PendingGiftStock["quote"] {
  return {
    plainName: quote.plainName,
    amountLabel: quote.amountLabel,
    usdcCostHuman: quote.usdcCostHuman,
    notionalUsd: quote.notionalUsd,
    maxUsd: quote.maxUsd,
    sharesHuman: quote.sharesHuman,
    symbol: quote.entry.symbol,
    sharePriceUsd: quote.sharePriceUsd,
  };
}

export function formatGiftNotePrompt(pending: PendingGiftStock): string {
  const who = whoForPending(pending);
  const from = pending.hasWalletStock ? " from your account" : "";
  return [
    `I'm going to send ${pending.quote.amountLabel}${from} to ${who}.`,
    "",
    "Want to add a note? Type anything, or say skip.",
  ].join("\n");
}

export function formatGiftPayNudge(pending: PendingGiftStock): string {
  return `Reply APPLE PAY for the link, or NO to cancel sending ${pending.quote.amountLabel}.`;
}

export function formatGiftHoldingsNudge(pending: PendingGiftStock): string {
  return `Reply YES to send ${pending.quote.amountLabel} from your account, or NO to cancel.`;
}

export function formatGiftApplePayLink(args: {
  amountUsd: number;
  fundUrl: string;
  amountLabel: string;
  who: string;
}): string {
  return [
    `Tap this link and pay $${formatUsdAmount(args.amountUsd)} with Apple Pay.`,
    args.fundUrl,
    "",
    `After it clears I'll send ${args.amountLabel} to ${args.who}.`,
  ].join("\n");
}

export function formatGiftSent(pending: PendingGiftStock, claimUrl?: string | null): string {
  const who = whoForPending(pending);
  const claim = claimUrl ? `\n\nShare this claim link:\n${claimUrl}` : "";
  return `Sent ${pending.quote.amountLabel} to ${who} from your account.${claim}`;
}

function contactPhone(row: ContactRow): string | null {
  return ContactsAdapter.normalizeHandle(row.contact_phone ?? row.contact ?? "");
}

function formatAmbiguousContacts(query: string, matches: ContactRow[]): string {
  const numbered = matches
    .map((c, i) => {
      const phone = contactPhone(c);
      return `${i + 1}. ${c.name}${phone ? ` (${formatPhoneDisplay(phone)})` : ""}`;
    })
    .join("\n");
  return `a couple of your contacts match "${query}":\n${numbered}\n\nwhich one did you mean?`;
}

async function recipientFromPhone(phone: string, name?: string): Promise<StockGiftRecipient> {
  const wallet = await WalletAdapter.getEmbeddedWallet(phone);
  const display = name?.trim() || phone;
  if (wallet?.address) {
    return { kind: "wallet", address: wallet.address, display, phone, name };
  }
  return { kind: "claim_phone", phone, display, name };
}

type RecipientResolve =
  | StockGiftRecipient
  | { error: string }
  | { ambiguous: true; query: string; matches: ContactRow[] };

async function resolveGiftRecipient(senderId: string, to: string): Promise<RecipientResolve> {
  const trimmed = to.trim();
  const isAddress = /^0x[a-fA-F0-9]{40}$/i.test(trimmed);
  const isEns = /\.(base\.)?eth$/i.test(trimmed);
  if (isAddress || isEns) {
    const { resolveSendTarget } = await import("@/messaging/resolveSendTarget.js");
    const target = await resolveSendTarget(senderId, { address: trimmed });
    if (target.kind === "wallet") {
      return {
        kind: "wallet",
        address: target.address,
        display: target.display,
        phone: target.phone,
        name: target.name,
      };
    }
    return {
      error: `i don't have a wallet for "${trimmed}". send to a contact, phone, 0x, or basename.`,
    };
  }

  const phone = extractGiftPhone(trimmed);
  if (phone) {
    const saved = await ContactsAdapter.findByPhone(senderId, phone);
    return recipientFromPhone(phone, saved?.name);
  }

  const fuzzy = await ContactsAdapter.findByNameFuzzy(senderId, trimmed);
  if (fuzzy.ambiguous && fuzzy.matches.length > 1) {
    return { ambiguous: true, query: trimmed, matches: fuzzy.matches };
  }
  const hit = fuzzy.matches[0];
  const hitPhone = hit ? contactPhone(hit) : null;
  if (hit && hitPhone) {
    return recipientFromPhone(hitPhone, hit.name);
  }

  const { resolveSendTarget } = await import("@/messaging/resolveSendTarget.js");
  const target = await resolveSendTarget(senderId, { name: trimmed });
  if (target.kind === "wallet") {
    return {
      kind: "wallet",
      address: target.address,
      display: target.display,
      phone: target.phone,
      name: target.name,
    };
  }
  if (target.kind === "claim_phone") {
    return {
      kind: "claim_phone",
      phone: target.phone,
      display: target.display,
      name: target.name,
      isOnBasemate: target.isOnBasemate,
    };
  }
  if (target.kind === "ambiguous") {
    const matches: ContactRow[] = target.candidates.flatMap((c, i) =>
      c.phone
        ? [
            {
              id: i,
              name: c.name,
              contact_owner: senderId,
              contact: c.phone,
              contact_phone: c.phone,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ]
        : [],
    );
    if (matches.length > 1) {
      return { ambiguous: true, query: trimmed, matches };
    }
  }
  return {
    error:
      `i don't have "${trimmed}" saved. share their contact card, or send the number with the country code already on it ` +
      `(like +380… or +1…). i won't guess +1.`,
  };
}

async function senderHoldsGiftStock(
  senderId: string,
  quote: PendingGiftStock["quote"],
): Promise<boolean> {
  const embedded = await WalletAdapter.getEmbeddedWallet(senderId);
  if (!embedded?.address) return false;
  return walletHasStockGiftShares(embedded.address, quote.symbol, quote.sharesHuman).catch(
    () => false,
  );
}

async function beginNoteStep(
  platform: string,
  senderId: string,
  pending: Omit<PendingGiftStock, "step" | "createdAt"> & { recipient: StockGiftRecipient },
): Promise<string> {
  const next: PendingGiftStock = {
    ...pending,
    step: "note",
    createdAt: Date.now(),
    to: pending.recipient.phone ?? pending.to,
    hasWalletStock: await senderHoldsGiftStock(senderId, pending.quote),
  };
  await stateSet(pendingGiftStockKey(platform, senderId), next, 30 * 60);
  return formatGiftNotePrompt(next);
}

/**
 * After the note: send from holdings, or hand back the Apple Pay link. No extra
 * confirm step. If the link can't be built, park on "pay" so "apple pay" retries.
 */
async function finishGiftStock(
  platform: string,
  senderId: string,
  pending: PendingGiftStock,
): Promise<{ messages: string[]; clear: boolean }> {
  const result = await confirmGiftStock(platform, senderId, pending);
  if (!result.clear) {
    await stateSet(
      pendingGiftStockKey(platform, senderId),
      { ...pending, step: "pay", createdAt: Date.now() },
      30 * 60,
    );
  }
  return result;
}

function platformOf(ctx: RespondCtx): string {
  return ctx.copyPlatform === "whatsapp" ? "whatsapp" : "imessage";
}

export async function gift_stock(
  ctx: RespondCtx,
  args: {
    to: string;
    stock: string;
    amount: string;
    isUsd?: boolean;
    memo?: string;
  },
): Promise<ToolResult> {
  const senderId = ctx.inboxId;
  if (!senderId) {
    return {
      data: { error: "no sender" },
      control: {
        type: "text",
        text: "connect your Basemate account first, then I'll send that stock.",
      },
    };
  }

  const embedded = await WalletAdapter.getEmbeddedWallet(senderId);
  if (!embedded?.address) {
    return {
      data: { error: "no wallet" },
      control: {
        type: "text",
        text: "connect your Basemate wallet on app.basemate.app first, then send the stock.",
      },
    };
  }

  const isUsd = args.isUsd === true;
  const quoted = await quoteStockGift({
    symbol: args.stock,
    qty: isUsd ? undefined : args.amount,
    usd: isUsd ? args.amount : undefined,
  });
  if (!quoted.ok) {
    return { data: { error: quoted.error }, control: { type: "text", text: quoted.error } };
  }

  const platform = platformOf(ctx);
  const pendingKey = pendingGiftStockKey(platform, senderId);
  const quote = snapshotQuote(quoted.quote);
  const memo =
    typeof args.memo === "string" && args.memo.trim() ? args.memo.trim() : undefined;

  const resolved = await resolveGiftRecipient(senderId, args.to);
  if ("error" in resolved) {
    const pending: PendingGiftStock = {
      createdAt: Date.now(),
      step: "phone",
      to: args.to,
      stock: args.stock,
      amount: args.amount,
      isUsd,
      memo,
      quote,
    };
    await stateSet(pendingKey, pending, 30 * 60);
    return { data: { step: "phone" }, control: { type: "text", text: resolved.error } };
  }
  if ("ambiguous" in resolved) {
    const pending: PendingGiftStock = {
      createdAt: Date.now(),
      step: "pick",
      to: args.to,
      stock: args.stock,
      amount: args.amount,
      isUsd,
      memo,
      candidates: resolved.matches.flatMap((c) => {
        const phone = contactPhone(c);
        return phone ? [{ name: c.name, phone }] : [];
      }),
      quote,
    };
    await stateSet(pendingKey, pending, 30 * 60);
    return {
      data: { step: "pick" },
      control: { type: "text", text: formatAmbiguousContacts(resolved.query, resolved.matches) },
    };
  }

  if (!memo) {
    const text = await beginNoteStep(platform, senderId, {
      to: resolved.phone ?? args.to,
      stock: args.stock,
      amount: args.amount,
      isUsd,
      recipient: resolved,
      quote,
    });
    return { data: { step: "note", quote }, control: { type: "text", text } };
  }

  const done = await finishGiftStock(platform, senderId, {
    createdAt: Date.now(),
    step: "note",
    to: resolved.phone ?? args.to,
    stock: args.stock,
    amount: args.amount,
    isUsd,
    memo,
    recipient: resolved,
    quote,
  });
  return {
    data: { step: done.clear ? "done" : "pay", quote },
    control: { type: "text", text: done.messages.join("\n\n") },
  };
}

export async function continueGiftStockNote(
  platform: string,
  senderId: string,
  pending: PendingGiftStock,
  reply: string,
): Promise<{ messages: string[]; clear: boolean }> {
  const trimmed = reply.trim();
  if (!trimmed) {
    return {
      messages: ["Want to add a note? Type anything, or say skip."],
      clear: false,
    };
  }
  const memo = /^skip$/i.test(trimmed) ? undefined : trimmed.slice(0, 140);
  return finishGiftStock(platform, senderId, { ...pending, memo });
}

export async function continueGiftStockPick(
  platform: string,
  senderId: string,
  pending: PendingGiftStock,
  reply: string,
): Promise<{ messages: string[]; clear: boolean }> {
  const asPhone = extractGiftPhone(reply);
  if (asPhone) {
    const recipient = await recipientFromPhone(asPhone);
    return {
      messages: [await beginNoteStep(platform, senderId, { ...pending, recipient })],
      clear: false,
    };
  }
  const pick = /^(\d{1,2})$/.exec(reply.trim());
  const index = pick ? Number(pick[1]) - 1 : -1;
  const chosen = pending.candidates?.[index];
  if (!chosen) {
    return {
      messages: ["reply with the number next to their name, send a +phone, or say cancel."],
      clear: false,
    };
  }
  const recipient = await recipientFromPhone(chosen.phone, chosen.name);
  return {
    messages: [
      await beginNoteStep(platform, senderId, { ...pending, recipient, candidates: undefined }),
    ],
    clear: false,
  };
}

export async function continueGiftStockPhone(
  platform: string,
  senderId: string,
  pending: PendingGiftStock,
  reply: string,
): Promise<{ messages: string[]; clear: boolean }> {
  const phone = extractGiftPhone(reply);
  if (!phone) {
    return {
      messages: [
        "that number needs a country code. send the full number with it already on there, like +380… or +1…, or say cancel.",
      ],
      clear: false,
    };
  }
  const saved = await ContactsAdapter.findByPhone(senderId, phone);
  const recipient = await recipientFromPhone(phone, saved?.name);
  return {
    messages: [await beginNoteStep(platform, senderId, { ...pending, recipient })],
    clear: false,
  };
}

export async function confirmGiftStock(
  platform: string,
  senderId: string,
  pending: PendingGiftStock,
  opts?: { forceApplePay?: boolean },
): Promise<{ messages: string[]; clear: boolean }> {
  const embedded = await WalletAdapter.getEmbeddedWallet(senderId);
  if (!embedded?.address) {
    return {
      messages: [
        "connect your Basemate wallet on app.basemate.app first, then say YES again.",
      ],
      clear: false,
    };
  }
  if (!pending.recipient) {
    return {
      messages: ["i still need their phone number with a country code."],
      clear: false,
    };
  }

  const quoted = await quoteStockGift({
    symbol: pending.stock,
    qty: pending.isUsd ? undefined : pending.amount,
    usd: pending.isUsd ? pending.amount : undefined,
  });
  if (!quoted.ok) {
    return { messages: [quoted.error], clear: true };
  }
  const quote = quoted.quote;
  const stockBal = await readErc20Balance(quote.entry.address, embedded.address).catch(() => 0n);
  const hasWalletStock = stockBal >= quote.sharesRaw;
  const intent: StockGiftIntent = {
    kind: "gift_stock",
    symbol: quote.entry.symbol,
    qty: pending.isUsd ? undefined : pending.amount,
    usd: pending.isUsd ? pending.amount : undefined,
    memo: pending.memo,
    recipient: pending.recipient,
    quotedAt: new Date().toISOString(),
    maxUsd: quote.maxUsd,
    sharePriceUsd: quote.sharePriceUsd,
  };

  const spendUsd = giftSpendUsd(quote);
  const walletCharge = giftChargeUsd(spendUsd);
  const appleChargeUsd = giftOnrampUsd(spendUsd);

  if (!opts?.forceApplePay && hasWalletStock) {
    const gift = await StockGiftAdapter.create({
      senderId,
      walletAddress: embedded.address,
      intent,
      amountUsd: walletCharge.usdcNeeded,
    });
    const claimed = await StockGiftAdapter.claimGiftStart(gift.id);
    if (!claimed) {
      return {
        messages: ["that send is already in progress. hang tight."],
        clear: true,
      };
    }
    const result = await fulfillStockGift(gift.id, { notifySender: false });
    if (result.ok) {
      const phone = pending.recipient.phone ?? pending.to;
      const name = pending.recipient.name?.trim();
      if (name && phone) {
        await maybeAutoSaveContact(senderId, { name, phone });
      }
      const sent = formatGiftSent({ ...pending, quote: snapshotQuote(quote) }, result.claimUrl);
      const optInAsk = await smsOptInAskFor(phone);
      return {
        messages: [optInAsk ? `${sent}\n\n${optInAsk}` : sent],
        clear: true,
      };
    }
    if (result.needsReauth) {
      return {
        messages: [
          'reconnect your Basemate wallet on app.basemate.app, then reply "retry gift".',
        ],
        clear: true,
      };
    }
    return {
      messages: [result.error ?? 'could not send just now. reply "retry gift".'],
      clear: true,
    };
  }

  const gift = await StockGiftAdapter.create({
    senderId,
    walletAddress: embedded.address,
    intent,
    amountUsd: walletCharge.usdcNeeded,
  });
  const fundIntent: FundSessionIntent = {
    kind: "gift_stock",
    giftId: gift.id,
    symbol: intent.symbol,
    qty: intent.qty,
    usd: intent.usd,
    memo: intent.memo,
    recipient: {
      kind: pending.recipient.kind,
      display: pending.recipient.display,
      address: pending.recipient.kind === "wallet" ? pending.recipient.address : undefined,
      phone:
        pending.recipient.kind === "claim_phone"
          ? pending.recipient.phone
          : pending.recipient.phone ?? undefined,
      name: pending.recipient.name,
      isOnBasemate:
        pending.recipient.kind === "claim_phone" ? pending.recipient.isOnBasemate : undefined,
    },
    quotedAt: intent.quotedAt,
    maxUsd: intent.maxUsd,
    sharePriceUsd: intent.sharePriceUsd,
  };

  try {
    const { buildHeadlessFundLinks, isCoinbaseRegionForbiddenError } = await import(
      "@/wallet/onramp.js"
    );
    const { OnrampUserDataAdapter } = await import("@/wallet/onrampUserData.js");
    const userData = config.cdp.enabled ? await OnrampUserDataAdapter.get(senderId) : null;
    const who = whoLabel(pending.recipient);
    const fundPage = config.cdp.fundPageUrl.replace(/\/$/, "");

    if (!userData?.email || !userData.tosAcceptedAt || !userData.emailVerifiedAt) {
      const token = await FundSessionAdapter.createIntent({
        userPhone: senderId,
        walletAddress: embedded.address,
        amountUsd: appleChargeUsd,
        intent: fundIntent,
        ttlMs: GIFT_FUND_SESSION_TTL_MS,
      });
      await StockGiftAdapter.setFundSessionToken(gift.id, token);
      return {
        messages: [
          formatGiftApplePayLink({
            amountUsd: appleChargeUsd,
            fundUrl: `${fundPage}?s=${token}`,
            amountLabel: quote.amountLabel,
            who,
          }),
        ],
        clear: true,
      };
    }

    const partnerUserRef = config.cdp.onrampSandbox
      ? `sandbox-${senderId.replace(/[^a-z0-9]/gi, "").slice(0, 40)}`
      : `im-${senderId.replace(/[^a-z0-9]/gi, "").slice(0, 47)}`;

    let paymentLinkOptions: Awaited<
      ReturnType<typeof buildHeadlessFundLinks>
    >["paymentLinkOptions"] = [];
    try {
      const headless = await buildHeadlessFundLinks({
        senderId,
        address: embedded.address,
        amount: String(appleChargeUsd),
        email: userData.email,
        agreementAcceptedAt: userData.tosAcceptedAt,
        phoneNumberVerifiedAt: userData.phoneVerifiedAt ?? new Date(),
        partnerUserRef,
      });
      paymentLinkOptions = headless.paymentLinkOptions;
    } catch (err) {
      if (!isCoinbaseRegionForbiddenError(err)) throw err;
    }

    if (paymentLinkOptions.length === 0) {
      const token = await FundSessionAdapter.createIntent({
        userPhone: senderId,
        walletAddress: embedded.address,
        amountUsd: appleChargeUsd,
        intent: fundIntent,
        ttlMs: GIFT_FUND_SESSION_TTL_MS,
      });
      await StockGiftAdapter.setFundSessionToken(gift.id, token);
      return {
        messages: [
          formatGiftApplePayLink({
            amountUsd: appleChargeUsd,
            fundUrl: `${fundPage}?s=${token}`,
            amountLabel: quote.amountLabel,
            who,
          }),
        ],
        clear: true,
      };
    }

    const token = await FundSessionAdapter.create(
      senderId,
      paymentLinkOptions[0].url,
      paymentLinkOptions,
      appleChargeUsd,
      embedded.address,
      undefined,
      { intent: fundIntent, ttlMs: GIFT_FUND_SESSION_TTL_MS },
    );
    await StockGiftAdapter.setFundSessionToken(gift.id, token);
    return {
      messages: [
        formatGiftApplePayLink({
          amountUsd: appleChargeUsd,
          fundUrl: `${fundPage}?s=${token}`,
          amountLabel: quote.amountLabel,
          who,
        }),
      ],
      clear: true,
    };
  } catch (err) {
    console.error("⚠️ [gift_stock] fund link failed:", err);
    return {
      messages: ["couldn't create the payment link. try again in a moment."],
      clear: false,
    };
  }
}

export async function retryOpenStockGift(senderId: string): Promise<string[]> {
  const embedded = await WalletAdapter.getEmbeddedWallet(senderId);
  if (!embedded?.address) {
    return ['connect your Basemate wallet first, then reply "retry gift".'];
  }
  let gift = await StockGiftAdapter.findOpenByWallet(embedded.address);
  if (!gift) {
    const { db } = await import("@/discovery/db.js");
    const result = await db.query(
      `SELECT * FROM stock_gifts
       WHERE sender_id = $1
         AND gift_tx_hash IS NULL
         AND (gift_failed_at IS NULL OR retry_count < 3)
       ORDER BY created_at DESC LIMIT 1`,
      [senderId],
    );
    if (result.rows[0]) gift = await StockGiftAdapter.get(String(result.rows[0].id));
  }
  if (!gift) return ["no pending stock gift to retry."];
  if (gift.giftTxHash) return ["that gift already went through."];
  if (!gift.giftStartedAt) {
    const locked = await StockGiftAdapter.claimGiftStart(gift.id);
    if (!locked) return ["that send is already running. hang tight."];
    gift = locked;
  }
  scheduleStockGiftFulfill(gift.id);
  return [`retrying your ${gift.intent.symbol} gift to ${gift.intent.recipient.display} now…`];
}
