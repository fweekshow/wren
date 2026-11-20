import { sanitizeAmount, type WalletCall } from "@basemate/shared";

import { config } from "@/config/config.js";
import { type AIResponse } from "@/discovery/ai.js";
import {
  singleBubbleTextOutbound,
  stripMarkdown,
  type ImessageOutbound,
} from "@/imessage/outbound.js";
import { stateSet } from "@/state/conversationState.store.js";
import { OnrampUserDataAdapter } from "@/wallet/onrampUserData.js";
import { FundSessionAdapter } from "@/wallet/fundSession.js";
import {
  buildHeadlessFundLinks,
  isCoinbaseRegionForbiddenError,
  ONRAMP_MIN_USD,
} from "@/wallet/onramp.js";
import { createOfframpDraft, OfframpValidationError } from "@/wallet/offramp.js";
import { PhoneEscrowAdapter } from "@/wallet/phoneEscrow.js";
import {
  formatSweepPreview,
  formatSweepResult,
  resolveCustodialSweepWallets,
  sweepCustodialWallets,
  type SweepWalletTarget,
} from "@/wallet/sweep.js";
import { GasEstimationError, InsufficientGasError, withdraw as cdpWithdraw } from "@/wallet/cdp.js";
import { EmbeddedWalletAdapter, EmbeddedWalletError } from "@/wallet/embeddedWallet.js";
import {
  WalletAdapter,
  DEFAULT_AUTO_SEND_LIMIT_USD,
} from "@/discovery/adapters/wallet.adapter.js";
import { TxConfirmationAdapter } from "@/discovery/adapters/txConfirmation.adapter.js";
import { PendingPayAdapter } from "@/wallet/pendingPay.js";
import { fetchTokenPriceUsd, resolveTokenAsync } from "@/discovery/ai/tokens.js";
import { cleanTxLabel, formatConfirmedChatTitle } from "@/tx-confirmations/poller.js";

import { smsOptInAskFor } from "../smsConsentGate.js";
import { APP_ACTIVITY_HINT, formatReceipt } from "../utils/wallet.utils.js";
import {
  connectBasemateAccountMessages,
  getConnectedWalletAddress,
  transactionApprovalOutbound,
} from "./account.handler.js";
import type {
  ContactTransferNotification,
  TradeDeliveryContext,
} from "../handler.types.js";
import type { ImessageIntent } from "../intentEngine.js";
import type { HandlerCtx } from "../handler.ctx.js";

/** Base mainnet chain id (hex), used for every iMessage transaction. */
const BASE_CHAIN_ID = "0x2105" as const;

export interface PendingSweep {
  destination: string;
  userKey: string;
  mainWallet: SweepWalletTarget;
  createdAt: number;
}

export interface PendingWithdraw {
  to: string;
  amount: string;
  asset: string;
  label: string;
  accountName: string;
  createdAt: number;
}

/**
 * Core Apple Pay onramp handler. Called once we have a dollar amount.
 * Checks verification state and either sends the fund link or starts an OTP flow.
 */
export async function handleFundAmount(
  ctx: HandlerCtx,
  senderId: string,
  walletAddress: string,
  amount: string,
  opts?: {
    intent?: import("@/wallet/fundSession.js").FundSessionIntent | null;
    ttlMs?: number;
  },
): Promise<ImessageOutbound[]> {
  const { K } = ctx;
  const paymentLabel = "Apple Pay or Google Pay";
  if (amount === "0") {
    await stateSet(K.pendingFundAmount(senderId), { createdAt: Date.now() });
    return [`how much? reply 25, 50, 100, or any dollar amount. (minimum $${ONRAMP_MIN_USD})`];
  }
  if (Number(amount) < ONRAMP_MIN_USD) {
    return [`minimum is $${ONRAMP_MIN_USD} — try "add $${ONRAMP_MIN_USD}" or more.`];
  }

  const userData = config.cdp.enabled ? await OnrampUserDataAdapter.get(senderId) : null;

  if (!userData?.email || !userData.tosAcceptedAt) {
    await stateSet(K.pendingOnrampEmail(senderId), { createdAt: Date.now(), pendingAmount: amount });
    return [
      [
        `to add $${amount} via ${paymentLabel} i need your email first.`,
        "",
        "by continuing you agree to Coinbase's Guest Checkout Terms (pay.coinbase.com/legal).",
        "",
        "reply with your email address:",
      ].join("\n"),
    ];
  }

  if (!userData.emailVerifiedAt) {
    await stateSet(K.pendingEmailOtpVerification(senderId), { createdAt: Date.now(), pendingAmount: amount });
    return ["please verify your email first — check for a code i sent you, or say \"resend code\"."];
  }

  let phoneVerifiedAt = userData.phoneVerifiedAt;
  if (OnrampUserDataAdapter.needsPhoneReverification(userData)) {
    // iMessage users prove phone ownership by texting from it — auto-verify, no OTP needed.
    phoneVerifiedAt = new Date();
    await OnrampUserDataAdapter.upsert(senderId, {
      phoneVerifiedAt,
    });
  }
  if (!phoneVerifiedAt) {
    return ["please verify your phone number before using Apple Pay or Google Pay."];
  }

  // Fully verified — headless Create Order + fund session (iframe URLs ready before /pay opens).
  if (!config.cdp.enabled) {
    return ["CDP is not configured — cannot create an onramp order."];
  }

  const verifiedUserData = {
    ...userData,
    email: userData.email,
    tosAcceptedAt: userData.tosAcceptedAt,
    phoneVerifiedAt,
  };

  try {
    const partnerUserRef = config.cdp.onrampSandbox
      ? `sandbox-${senderId.replace(/[^a-z0-9]/gi, "").slice(0, 40)}`
      : `im-${senderId.replace(/[^a-z0-9]/gi, "").slice(0, 47)}`;

    let paymentLinkOptions: Awaited<ReturnType<typeof buildHeadlessFundLinks>>["paymentLinkOptions"] = [];
    let regionForbidden = false;

    try {
      const headless = await buildHeadlessFundLinks({
        senderId,
        address: walletAddress,
        amount,
        email: verifiedUserData.email,
        agreementAcceptedAt: verifiedUserData.tosAcceptedAt,
        phoneNumberVerifiedAt: verifiedUserData.phoneVerifiedAt,
        partnerUserRef,
      });
      paymentLinkOptions = headless.paymentLinkOptions;
    } catch (err) {
      regionForbidden = isCoinbaseRegionForbiddenError(err);
      if (!regionForbidden) throw err;
    }

    if (paymentLinkOptions.length === 0) {
      if (regionForbidden) {
        return [
          [
            "Coinbase can't process Guest Checkout for this user right now.",
            "",
            "Headless Onramp is currently US-only and Coinbase rejected the region check. If you're in the US, try again from a US network or contact support.",
          ].join("\n"),
        ];
      }
      return ["couldn't generate a payment link — try again in a moment."];
    }

    const token = await FundSessionAdapter.create(
      senderId,
      paymentLinkOptions[0].url,
      paymentLinkOptions,
      Number(amount),
      walletAddress,
      undefined,
      {
        intent: opts?.intent ?? null,
        ttlMs: opts?.ttlMs,
      },
    );
    const fundUrl = `${config.cdp.fundPageUrl}?s=${token}`;
    const ttlMins = Math.round((opts?.ttlMs ?? 10 * 60 * 1000) / 60_000);

    return [
      singleBubbleTextOutbound(
        [
          `tap to add $${Number(amount).toFixed(0)} USDC via ${paymentLabel}:`,
          "",
          fundUrl,
          "",
          `(link expires in ${ttlMins} minutes)`,
        ].join("\n"),
      ),
    ];
  } catch (err) {
    console.error("⚠️ [onramp] fund session intent failed:", err);
    return ["couldn't create the payment link right now — try again in a moment."];
  }
}

export async function handleOfframpIntent(args: {
  platform: HandlerCtx["platform"];
  senderId: string;
  walletAddress: string;
  amount: string;
}): Promise<ImessageOutbound[]> {
  const amount = sanitizeAmount(args.amount);
  if (!amount || Number(amount) <= 0) return ["how much USDC should i cash out?"];

  try {
    const draft = await createOfframpDraft({
      platform: args.platform,
      userKey: args.senderId,
      sourceAddress: args.walletAddress,
      amount,
    });

    return [
      [
        `tap to cash out ${formatRampAmount(amount)} USDC to fiat via Coinbase:`,
        "",
        draft.url,
        "",
        "(you'll review the Coinbase order, then confirm the USDC transfer from your Basemate Account)",
      ].join("\n"),
    ];
  } catch (err) {
    console.error("⚠️ [offramp] link creation failed:", err);
    if (err instanceof OfframpValidationError) return [err.message];
    return ["couldn't create the cash-out link right now — try again in a moment."];
  }
}

function formatRampAmount(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

export async function startSweepFromChat(
  ctx: HandlerCtx,
  args: {
    senderId: string;
    intent: ImessageIntent;
    walletAddress: string;
    custodialAccountName?: string;
  },
): Promise<ImessageOutbound[]> {
  const { K, platform } = ctx;
  const { senderId, intent, walletAddress, custodialAccountName } = args;
  if (!custodialAccountName || !walletAddress) {
    return ["i couldn't load your server wallet right now — try again in a moment."];
  }
  const destination = intent.targetAddress || (await getConnectedWalletAddress(ctx, senderId));
  if (!destination) {
    return ["where should i sweep the funds? send `sweep to 0x...` with the destination wallet."];
  }

  const mainWallet: SweepWalletTarget = {
    label: "Main wallet",
    accountName: custodialAccountName,
    address: walletAddress,
  };
  const targets = await resolveCustodialSweepWallets({
    platform,
    userKey: senderId,
    mainWallet,
  });
  if (targets.length === 0) {
    return ["i couldn't find any Basemate server wallets to sweep."];
  }

  await stateSet(K.pendingSweep(senderId), {
    destination,
    userKey: senderId,
    mainWallet,
    createdAt: Date.now(),
  });
  return [formatSweepPreview(targets, destination)];
}

export async function executePendingSweep(
  ctx: HandlerCtx,
  pending: PendingSweep,
): Promise<ImessageOutbound[]> {
  const { platform } = ctx;
  try {
    const result = await sweepCustodialWallets({
      platform,
      userKey: pending.userKey,
      destination: pending.destination,
      mainWallet: pending.mainWallet,
    });
    return [formatSweepResult(result)];
  } catch (err) {
    if (err instanceof InsufficientGasError) {
      return ["i couldn't sweep yet — your server wallet has no ETH for gas."];
    }
    if (err instanceof GasEstimationError) {
      console.error("⚠️ [iMessage] sweep gas estimation failed:", err);
      return ["i couldn't sweep — one of the transactions failed simulation. check balances/positions and try again."];
    }
    console.error("⚠️ [iMessage] sweep failed:", err);
    return ["i couldn't complete the sweep right now — try again in a moment."];
  }
}

export async function buildPhoneEscrowDepositLink(
  ctx: HandlerCtx,
  args: {
    senderId: string;
    phone: string;
    contactName: string;
    amount: string;
    tokenAddress: string;
    tokenSymbol: string;
    tokenDecimals: number;
    senderWalletAddress: string;
    memo?: string;
    autoSaveContact?: { name: string; phone: string };
    /** Original USDC spend when corridor-routing; triggers fresh USDC→local swap on confirm. */
    sourceUsdcAmount?: string;
    quotedLocalAmount?: string;
  },
): Promise<ImessageOutbound[]> {
  if (!config.phoneEscrow.enabled) {
    return ["sending to a phone isn't set up yet — try sending to a wallet address instead."];
  }
  if (args.tokenAddress === "ETH" || args.tokenSymbol.toUpperCase() === "ETH") {
    return [
      "phone escrow doesn't support ETH directly — swap a small amount to USDC first, then send that to them. want me to help with the swap?",
    ];
  }
  try {
    const { BASE_TOKENS } = await import("@/discovery/ai/tokens.js");
    const { resolveCorridorStable } = await import("@/portfolio/corridorRouting.js");
    const { buildCorridorSendCalls } = await import("@/portfolio/corridorSend.js");

    const tryCorridor =
      typeof args.sourceUsdcAmount === "string" && args.sourceUsdcAmount.trim().length > 0;

    type DepositPlan = {
      calls: WalletCall[];
      phone: string;
      phoneHash: `0x${string}`;
      tokenAddress: `0x${string}`;
      tokenSymbol: string;
      tokenDecimals: number;
      amount: string;
      amountAtomic: bigint;
      label: string;
      amountUsd: number | null;
    };

    let plan: DepositPlan | null = null;

    if (tryCorridor) {
      const corridor = resolveCorridorStable(args.phone);
      if (corridor?.address) {
        const routed = await buildCorridorSendCalls({
          mode: "escrow",
          usdcAmount: args.sourceUsdcAmount!.trim(),
          localStable: corridor,
          senderAddress: args.senderWalletAddress,
          phone: args.phone,
        });
        if (!routed.fallback) {
          const draft = PhoneEscrowAdapter.buildDepositDraft(args.phone, routed.localAmount, {
            address: corridor.address,
            symbol: corridor.symbol,
            decimals: corridor.decimals,
          });
          plan = {
            calls: routed.calls,
            phone: draft.phone,
            phoneHash: draft.phoneHash,
            tokenAddress: draft.tokenAddress as `0x${string}`,
            tokenSymbol: draft.tokenSymbol,
            tokenDecimals: draft.tokenDecimals,
            amount: draft.amount,
            amountAtomic: draft.amountAtomic,
            label:
              `Convert ${args.sourceUsdcAmount} USDC → ~${routed.quotedLocalAmount} ${draft.tokenSymbol} ` +
              `for ${args.contactName} to claim (${config.phoneEscrow.claimTtlHours}h)` +
              (args.memo ? ` — ${args.memo}` : ""),
            amountUsd: await estimateAmountUsd(args.sourceUsdcAmount, "USDC"),
          };
        }
      }
    }

    if (!plan) {
      // Corridor miss / no route: deposit the configured token. If we were
      // mid-corridor, fall back to the original USDC spend amount.
      const fallbackAmount = tryCorridor ? args.sourceUsdcAmount!.trim() : args.amount;
      const fallbackToken = tryCorridor
        ? {
            address: BASE_TOKENS.USDC.address,
            symbol: "USDC",
            decimals: BASE_TOKENS.USDC.decimals,
          }
        : {
            address: args.tokenAddress,
            symbol: args.tokenSymbol,
            decimals: args.tokenDecimals,
          };
      const draft = PhoneEscrowAdapter.buildDepositDraft(args.phone, fallbackAmount, fallbackToken);
      plan = {
        calls: draft.calls,
        phone: draft.phone,
        phoneHash: draft.phoneHash,
        tokenAddress: draft.tokenAddress as `0x${string}`,
        tokenSymbol: draft.tokenSymbol,
        tokenDecimals: draft.tokenDecimals,
        amount: draft.amount,
        amountAtomic: draft.amountAtomic,
        label:
          `Send ${draft.amount} ${draft.tokenSymbol} for ${args.contactName} to claim ` +
          `(${config.phoneEscrow.claimTtlHours}h)` +
          (args.memo ? ` — ${args.memo}` : ""),
        amountUsd: await estimateAmountUsd(draft.amount, draft.tokenSymbol),
      };
    }

    await PhoneEscrowAdapter.recordDepositIntent({
      senderId: args.senderId,
      phone: plan.phone,
      phoneHash: plan.phoneHash,
      tokenAddress: plan.tokenAddress,
      tokenSymbol: plan.tokenSymbol,
      tokenDecimals: plan.tokenDecimals,
      amountAtomic: plan.amountAtomic,
      amount: plan.amount,
    });
    // Route through the embedded wallet executor. The recipient gets a setup
    // message once the deposit lands, via the contactTransfer metadata.
    return executeUserTransaction(ctx, {
      senderId: args.senderId,
      calls: plan.calls,
      chainId: BASE_CHAIN_ID,
      label: plan.label,
      amountUsd: plan.amountUsd,
      contactTransfer: {
        recipientPhone: plan.phone,
        amount: plan.amount,
        asset: plan.tokenSymbol,
        ...(args.memo ? { memo: args.memo } : {}),
        ...(args.autoSaveContact ? { autoSaveContact: args.autoSaveContact } : {}),
      },
    });
  } catch (err) {
    console.error("⚠️ [phone-escrow] failed to create escrow deposit:", err);
    return ["couldn't create that claim link — try again in a moment."];
  }
}

const STABLE_SYMBOLS = new Set(["USDC", "USDBC", "USDT", "DAI", "USD"]);

/**
 * Best-effort USD value of a transfer, for the `auto_send_limit_usd` cap. Cheap
 * for stablecoins; otherwise a DexScreener price lookup. Returns null when the
 * value can't be determined — the caller treats that as "require confirm".
 */
export async function estimateAmountUsd(
  amount: string | null | undefined,
  asset: string | null | undefined,
): Promise<number | null> {
  const n = Number((amount ?? "").toString().replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const sym = (asset ?? "").trim().toUpperCase();
  if (!sym) return null;
  if (STABLE_SYMBOLS.has(sym)) return n;
  try {
    const token = await resolveTokenAsync(sym);
    if (!token.resolved || !token.address || token.address === "ETH") return null;
    const price = await fetchTokenPriceUsd(token.address);
    return price != null ? n * price : null;
  } catch {
    return null;
  }
}

/**
 * Run the calls on the user's embedded smart account now (delegated, gas
 * sponsored) and record the recipient notification. Shared by the quick-mode
 * auto path and the /pay confirm endpoint so the notification fires exactly once.
 */
export async function runEmbeddedTransaction(
  ctx: HandlerCtx,
  args: {
    senderId: string;
    embedded: { cdpUserId: string; address: string };
    calls: WalletCall[];
    chainId: `0x${string}`;
    label: string;
    contactTransfer?: ContactTransferNotification;
    tradeContext?: TradeDeliveryContext;
    /** Defaults to true. False = the smart account pays its own gas. */
    useCdpPaymaster?: boolean;
  },
): Promise<ImessageOutbound[]> {
  const { senderId, embedded, calls, chainId, label, contactTransfer, tradeContext } = args;
  try {
    const result = await EmbeddedWalletAdapter.sendCalls({
      userId: embedded.cdpUserId,
      address: embedded.address,
      calls,
      useCdpPaymaster: args.useCdpPaymaster ?? true,
    });

    // Log every execution to the activity feed; schedule a recipient text only
    // when it's a person-to-person transfer.
    try {
      await TxConfirmationAdapter.recordConfirmedActivity({
        senderId,
        fromAddress: embedded.address,
        chainId,
        label: cleanTxLabel(label),
        txHash: result.txHash,
        recipientPhone: contactTransfer?.recipientPhone ?? null,
        transferAmount: contactTransfer?.amount ?? null,
        transferAsset: contactTransfer?.asset ?? null,
        transferMemo: contactTransfer?.memo ?? null,
      });
    } catch (err) {
      console.error("⚠️ [iMessage] failed to record activity/notification:", err);
    }

    // Start the 72h claim clock for phone-escrow deposits (no-op for direct sends).
    if (contactTransfer?.recipientPhone && result.txHash) {
      try {
        await PhoneEscrowAdapter.confirmDeposit({
          senderId,
          recipientPhone: contactTransfer.recipientPhone,
          depositTxHash: result.txHash,
          senderRefundAddress: embedded.address,
          amountDisplay: contactTransfer.amount,
          tokenSymbol: contactTransfer.asset,
        });
      } catch (err) {
        console.error("⚠️ [iMessage] failed to confirm phone escrow deposit:", err);
      }
    }

    if (contactTransfer?.autoSaveContact) {
      const { maybeAutoSaveContact } = await import(
        "@/messaging/utils/autoSaveContact.utils.js"
      );
      await maybeAutoSaveContact(senderId, contactTransfer.autoSaveContact);
    }

    const confirmedLine = formatConfirmedChatTitle(label);
    const optInAsk = await smsOptInAskFor(contactTransfer?.recipientPhone);
    if (tradeContext?.isGroup && tradeContext.copyTradeCtx) {
      await stateSet(
        ctx.K.pendingGroupCopyTrade(tradeContext.conversationId),
        {
          ...tradeContext.copyTradeCtx,
          label: cleanTxLabel(label),
          originSenderId: tradeContext.originSenderId,
          deliveryPhone: tradeContext.deliveryPhone,
          expiresAt: Date.now() + 5 * 60_000,
        },
        5 * 60,
      );
      // Group: confirm + COPY only; activity lives in the app (no explorer link).
      return [
        formatReceipt({
          title: confirmedLine,
          footer: "Reply COPY to copy this trade.",
        }),
      ];
    }
    if (tradeContext?.isGroup) {
      return [optInAsk ? `${confirmedLine}\n\n${optInAsk}` : confirmedLine];
    }
    return [
      formatReceipt({
        title: confirmedLine,
        footer: [APP_ACTIVITY_HINT, optInAsk].filter(Boolean).join("\n\n"),
      }),
    ];
  } catch (err) {
    if (err instanceof EmbeddedWalletError && err.needsReauth) {
      return connectBasemateAccountMessages(ctx, senderId, { reauth: true });
    }
    if (err instanceof EmbeddedWalletError && err.message.startsWith("GAS_NOT_SPONSORED")) {
      const looksLikeSwap =
        /\bswap\b/i.test(label) ||
        calls.some(
          (c) =>
            typeof c.metadata?.transactionType === "string" &&
            c.metadata.transactionType.toLowerCase() === "swap",
        );
      if (looksLikeSwap) {
        return [
          "that swap didn't go through — gas sponsorship didn't cover it. try again in a moment.",
        ];
      }
      return [
        "we only sponsor gas for USDC sends right now — swap that token to USDC first, then send. try \"swap [amount] [token] to USDC\".",
      ];
    }
    console.error("⚠️ [iMessage] embedded transaction failed:", err);
    return ["that didn't go through — try again in a moment."];
  }
}

/**
 * Store the calls and hand the user a plain-English /pay confirm link that,
 * on tap, executes via the embedded wallet server-side (no signing popup).
 */
async function buildEmbeddedConfirmLink(
  ctx: HandlerCtx,
  args: {
    senderId: string;
    embeddedAddress: string;
    calls: WalletCall[];
    chainId: `0x${string}`;
    label: string;
    contactTransfer?: ContactTransferNotification;
    tradeContext?: TradeDeliveryContext;
    note?: string;
  },
): Promise<ImessageOutbound[]> {
  const {
    senderId,
    embeddedAddress,
    calls,
    chainId,
    label,
    contactTransfer,
    tradeContext,
    note,
  } = args;
  try {
    const { token } = await PendingPayAdapter.create({
      senderId,
      fromAddress: embeddedAddress,
      chainId,
      calls,
      label,
      recipientDisplay: contactTransfer?.recipientPhone ?? null,
      amount: contactTransfer?.amount ?? null,
      tokenSymbol: contactTransfer?.asset ?? null,
      transferMemo: contactTransfer?.memo ?? null,
      walletKind: "embedded",
      conversationId: tradeContext?.conversationId ?? null,
      isGroup: tradeContext?.isGroup ?? false,
      deliveryPhone: tradeContext?.deliveryPhone ?? null,
      copyTradeContext: tradeContext?.copyTradeCtx ?? null,
    });
    if (contactTransfer?.autoSaveContact) {
      const { stashPendingAutoSaveContact } = await import(
        "@/messaging/utils/autoSaveContact.utils.js"
      );
      await stashPendingAutoSaveContact(senderId, token, contactTransfer.autoSaveContact);
    }
    const url = `${config.payPage.origin}/pay/sign/${token}`;
    return [
      transactionApprovalOutbound(ctx, {
        label,
        url,
        signerAddress: embeddedAddress,
        summary: note,
      }),
    ];
  } catch (err) {
    console.error("⚠️ [iMessage] failed to create embedded confirm link:", err);
    return ["i couldn't prepare that transaction — try again in a moment."];
  }
}

/**
 * Decide how an embedded-wallet user's transaction runs, based on their
 * `embedded_pay_mode` + `auto_send_limit_usd`:
 *  - manual (default): always show the /pay confirm link.
 *  - quick: auto-execute when the USD value is known and <= the limit; otherwise
 *    fall back to the confirm link (fail-safe on unknown/over-limit amounts).
 */
async function decideEmbeddedExecution(
  ctx: HandlerCtx,
  args: {
    senderId: string;
    embedded: { cdpUserId: string; address: string; delegationExpiresAt: Date | null };
    calls: WalletCall[];
    chainId: `0x${string}`;
    label: string;
    amountUsd?: number | null;
    contactTransfer?: ContactTransferNotification;
    tradeContext?: TradeDeliveryContext;
    useCdpPaymaster?: boolean;
  },
): Promise<ImessageOutbound[]> {
  const {
    senderId,
    embedded,
    calls,
    chainId,
    label,
    amountUsd,
    contactTransfer,
    tradeContext,
  } = args;
  // No delegation at all, or expired — user must reconnect via the app.
  if (!embedded.delegationExpiresAt || embedded.delegationExpiresAt.getTime() <= Date.now()) {
    return connectBasemateAccountMessages(ctx, senderId, { reauth: true });
  }

  const mode = await WalletAdapter.getEmbeddedPayMode(senderId);
  const limit = (await WalletAdapter.getAutoSendLimit(senderId)) ?? DEFAULT_AUTO_SEND_LIMIT_USD;
  const knownUsd = typeof amountUsd === "number" && Number.isFinite(amountUsd);
  const overLimit = knownUsd && (amountUsd as number) > limit;

  // The /pay confirm lane replays calls from `pending_pay_transactions`, which
  // has no paymaster column — it always sponsors gas. Self-funded callers
  // (iStonks launches / fee claims) must therefore execute directly.
  const selfFunded = args.useCdpPaymaster === false;

  // Automatic: just do it — only fall back to a confirm when a KNOWN amount
  // exceeds the auto-approve limit. Manual: always confirm (unless self-funded).
  if (selfFunded || (mode === "quick" && !overLimit)) {
    return runEmbeddedTransaction(ctx, {
      senderId,
      embedded: { cdpUserId: embedded.cdpUserId, address: embedded.address },
      calls,
      chainId,
      label,
      contactTransfer,
      tradeContext,
      useCdpPaymaster: args.useCdpPaymaster,
    });
  }

  const note = overLimit
    ? `that's above your $${limit} auto-approve limit — tap to confirm and send 👆`
    : undefined;
  return buildEmbeddedConfirmLink(ctx, {
    senderId,
    embeddedAddress: embedded.address,
    calls,
    chainId,
    label,
    contactTransfer,
    tradeContext,
    note,
  });
}

/**
 * The single entry point for every user-signed transaction on iMessage/WhatsApp.
 * Basemate signs via the CDP embedded wallet (manual/quick + limit gating). There
 * is no alternate wallet fallback — a user without a connected Basemate account is
 * prompted to connect one.
 */
export async function executeUserTransaction(
  ctx: HandlerCtx,
  args: {
    senderId: string;
    calls: WalletCall[];
    chainId: `0x${string}`;
    label: string;
    amountUsd?: number | null;
    contactTransfer?: ContactTransferNotification;
    tradeContext?: TradeDeliveryContext;
    /** Defaults to true. False = the smart account pays its own gas. */
    useCdpPaymaster?: boolean;
  },
): Promise<ImessageOutbound[]> {
  const { senderId, calls, chainId, label, amountUsd, contactTransfer, tradeContext } = args;

  const embedded = await WalletAdapter.getEmbeddedWallet(senderId);
  if (!embedded) {
    return connectBasemateAccountMessages(ctx, senderId);
  }
  return decideEmbeddedExecution(ctx, {
    senderId,
    embedded,
    calls,
    chainId,
    label,
    amountUsd,
    contactTransfer,
    tradeContext,
    useCdpPaymaster: args.useCdpPaymaster,
  });
}

export async function routeTransactionResponse(
  ctx: HandlerCtx,
  args: {
    senderId: string;
    conversationId: string;
    originalText: string;
    resp: Extract<AIResponse, { type: "transaction" }>;
    custodialAccountName?: string;
    contactTransfer?: ContactTransferNotification;
    tradeContext?: TradeDeliveryContext;
    isGroup?: boolean;
    deliveryPhone?: string;
  },
): Promise<ImessageOutbound[]> {
  const { senderId, resp } = args;
  const label = stripMarkdown(resp.text);
  // The LLM send path attaches contactTransfer to resp when it resolves the
  // recipient from a saved contact; the deterministic path passes it as an arg.
  // Honour whichever is present so the recipient is always notified.
  const contactTransfer = args.contactTransfer ?? resp.contactTransfer;

  // Basemate account (CDP embedded wallet) is the only signing path — sign
  // server-side via delegation with the manual/quick + auto-send-limit gating.
  const embedded = await WalletAdapter.getEmbeddedWallet(senderId);
  if (!embedded) {
    return connectBasemateAccountMessages(ctx, senderId);
  }
  // USD value for the auto-approve limit: a contact send's amount, else a DeFi
  // action's USD notional. Unknown (e.g. a swap) auto-executes in quick mode.
  const amountUsd = contactTransfer
    ? await estimateAmountUsd(contactTransfer.amount, contactTransfer.asset)
    : typeof resp.protocolVolume?.amountUsdc === "number"
      ? resp.protocolVolume.amountUsdc
      : null;
  return decideEmbeddedExecution(ctx, {
    senderId,
    embedded,
    calls: resp.calls,
    chainId: resp.chainId,
    label,
    amountUsd,
    contactTransfer,
    tradeContext: args.tradeContext
      ? {
          ...args.tradeContext,
          copyTradeCtx: args.tradeContext.copyTradeCtx ?? resp.copyTradeCtx,
        }
      : resp.copyTradeCtx
        ? {
            conversationId: args.conversationId,
            isGroup: args.isGroup ?? false,
            deliveryPhone: args.deliveryPhone,
            originSenderId: senderId,
            copyTradeCtx: resp.copyTradeCtx,
          }
        : undefined,
  });
}

/**
 * Execute a previously confirmed custodial withdrawal.
 * Called after the user replies "confirm" to a withdraw_preview.
 */
export async function executePendingWithdraw(
  _ctx: HandlerCtx,
  pending: PendingWithdraw,
): Promise<ImessageOutbound[]> {
  try {
    await cdpWithdraw({
      accountName: pending.accountName,
      to: pending.to,
      amount: pending.amount,
      asset: (pending.asset?.toLowerCase() === "eth" ? "eth" : "usdc") as "usdc" | "eth",
    });
    const text = [`sent ${pending.label} ✅`, APP_ACTIVITY_HINT].join("\n");
    return [text];
  } catch (err: any) {
    console.error("⚠️ [iMessage] executePendingWithdraw failed:", err?.message || err);
    return ["the withdrawal didn't go through — check balances and try again."];
  }
}
