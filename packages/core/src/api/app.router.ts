import express, { Router, type Request, type Response } from "express";
import { CdpClient } from "@coinbase/cdp-sdk";

import { config } from "@/config/config.js";
import {
  createPortfolioAccessToken,
  verifyPortfolioAccessToken,
} from "@/portfolio/access.js";
import {
  WalletAdapter,
  DEFAULT_AUTO_SEND_LIMIT_USD,
} from "@/discovery/adapters/wallet.adapter.js";
import { TxConfirmationAdapter } from "@/discovery/adapters/txConfirmation.adapter.js";
import { ContactsAdapter } from "@/messaging/contacts.adapter.js";
import { UserProfileAdapter } from "@/messaging/adapters/userProfile.adapter.js";
import { buildPortfolioForAppDashboard } from "@/portfolio/service.js";
import { invalidatePortfolioSnapshot } from "@/portfolio/snapshot.js";
import {
  fetchMoonwellRates,
  buildMoonwellSupplyCalls,
} from "@/discovery/ai/tools/yield.handlers.js";
import { MOONWELL_UNDERLYING_TOKENS } from "@/portfolio/moonwell.js";
import { EmbeddedWalletAdapter, EmbeddedWalletError } from "@/wallet/embeddedWallet.js";
import { recordOnrampFunding } from "@/wallet/recordOnrampFunding.js";
import { PhoneEscrowAdapter } from "@/wallet/phoneEscrow.js";
import { fetchTraderHoldings } from "@/copy-trading/portfolio/balances.js";
import { sanitizeAmount } from "@basemate/shared";
import { cleanTxLabel } from "@/tx-confirmations/poller.js";
import { createAppSendPending, resolveAppSendPhone } from "@/api/appSend.service.js";
import {
  createWebStockGiftCheckout,
  isWebGiftChannel,
  listPublicStocks,
  WebGiftError,
} from "@/api/webGift.service.js";
import { claimStateForSend } from "@/portfolio/claimState.js";
import { VERIFIED_STABLES } from "@/portfolio/verifiedStables.js";
import { logger } from "@/utils/logger.js";
import { listPaidFinesForSender } from "@/swear-jar/store.js";
import { SWEAR_FINE_USD } from "@/swear-jar/constants.js";

const router = Router();
const json = express.json({ limit: "256kb" });

/** Dashboard sessions last a month (much longer than the 15-min magic links). */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BASESCAN_TX = "https://basescan.org/tx/";

let cdpClient: CdpClient | null = null;
function cdp(): CdpClient {
  if (!cdpClient) {
    cdpClient = new CdpClient({
      apiKeyId: config.cdp.apiKeyId,
      apiKeySecret: config.cdp.apiKeySecret,
      walletSecret: config.cdp.walletSecret,
    });
  }
  return cdpClient;
}

function sessionCredentials(req: Request): { user: string; token: string } {
  return {
    user:
      (typeof req.query.user === "string" && req.query.user) ||
      (typeof req.body?.user === "string" && req.body.user) ||
      "",
    token:
      (typeof req.query.token === "string" && req.query.token) ||
      (typeof req.body?.token === "string" && req.body.token) ||
      "",
  };
}

/** Verify ?user + ?token (or body) and return the senderId, or null (and 401s). */
function authed(req: Request, res: Response): string | null {
  const { user, token } = sessionCredentials(req);
  if (!user || !token) {
    res.status(400).json({ error: "Missing user or token" });
    return null;
  }
  const verified = verifyPortfolioAccessToken(user, token);
  if (!verified.ok) {
    res.status(401).json({ error: "Invalid session", reason: verified.reason });
    return null;
  }
  return user;
}

/**
 * Same as `authed`, but also accepts an iStonks-scoped token so fee reads and
 * claims can be handed out on a short-lived link without a full app session.
 */
// ── Session: validate the CDP access token, resolve the Basemate identity ────
router.post("/api/agent/app/session", json, async (req: Request, res: Response) => {
  const accessToken = typeof req.body?.accessToken === "string" ? req.body.accessToken.trim() : "";
  if (!accessToken) {
    res.status(400).json({ error: "Missing access token." });
    return;
  }
  try {
    // Server-side verification of the signed-in CDP end user — no wallet signing.
    const account = await cdp().endUser.validateAccessToken({ accessToken });
    const userId = account.userId;
    const smart = account.evmSmartAccounts?.[0] ?? null;

    // Prefer the stored CDP user id; fall back to the smart-account address.
    let senderId = await WalletAdapter.findByCdpUserId(userId);
    if (!senderId && smart) senderId = await WalletAdapter.findByEmbeddedAddress(smart);
    if (!senderId) {
      res.status(404).json({
        error: "No Basemate account is linked to this wallet yet. Connect it from Basemate first.",
      });
      return;
    }
    const token = createPortfolioAccessToken(senderId, { ttlMs: SESSION_TTL_MS });
    res.setHeader("Cache-Control", "no-store");
    res.json({ user: senderId, token, address: (smart ?? "").toLowerCase(), expiresInMs: SESSION_TTL_MS });
  } catch (err) {
    logger.error({ err }, "POST /api/agent/app/session");
    res.status(401).json({ error: "Could not verify your Basemate account." });
  }
});

// ── Portfolio: the signed-in dashboard shows the Basemate embedded wallet only ─
router.get("/api/app/portfolio", async (req: Request, res: Response) => {
  const user = authed(req, res);
  if (!user) return;
  try {
    const portfolio = await buildPortfolioForAppDashboard(user);
    if (!portfolio) {
      res.status(404).json({ error: "No Basemate Account found for this account." });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(portfolio);
  } catch (err) {
    logger.error({ err }, "GET /api/app/portfolio");
    res.status(500).json({ error: "Couldn't load your portfolio." });
  }
});

// ── Add funds: build an embedded Apple Pay onramp for the signed-in wallet ────
// Returns headless payment link options the dashboard embeds in an
// OnrampPaymentFrame (Apple Pay opens in-place on basemate.app). Falls back to
// the hosted Coinbase onramp URL when the headless order can't be created.
const FUND_SESSION_TTL_MS = 10 * 60 * 1000;
router.get("/api/app/fund-session", async (req: Request, res: Response) => {
  const user = authed(req, res);
  if (!user) return;
  try {
    const embedded = await WalletAdapter.getEmbeddedWallet(user);
    const address = embedded?.address;
    if (!address) {
      res.status(404).json({ error: "No Basemate Account found for this account." });
      return;
    }

    const amountRaw = typeof req.query.amount === "string" ? Number(req.query.amount) : NaN;
    const amount = Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : 0;
    if (!amount) {
      res.status(400).json({ error: "Enter an amount greater than $0." });
      return;
    }

    const { ONRAMP_MIN_USD } = await import("@/wallet/onramp.js");
    if (amount < ONRAMP_MIN_USD) {
      res.status(400).json({ error: `Minimum fund amount is $${ONRAMP_MIN_USD}.` });
      return;
    }

    const { buildHeadlessFundLinks, buildHostedFallbackUrl } = await import("@/wallet/onramp.js");
    const { clientIpFromRequest } = await import("@/wallet/fundSessionCheckout.js");
    const expiresAt = new Date(Date.now() + FUND_SESSION_TTL_MS).toISOString();
    const clientIp = clientIpFromRequest(req);

    // Resolve the user's email for the Headless Onramp order: request param first,
    // then the CDP end-user's verified sign-in email, then any stored onramp data.
    let email = typeof req.query.email === "string" ? req.query.email.trim() : "";
    if (!email && embedded.cdpUserId) {
      try {
        const endUser = await cdp().endUser.getEndUser({ userId: embedded.cdpUserId });
        const emailMethod = endUser.authenticationMethods.find((m) => m.type === "email");
        if (emailMethod && "email" in emailMethod && emailMethod.email) {
          email = String(emailMethod.email).trim();
        }
      } catch (err) {
        logger.warn({ err }, "[fund-session] CDP getEndUser email lookup failed");
      }
    }
    if (!email) {
      const { OnrampUserDataAdapter } = await import("@/wallet/onrampUserData.js");
      const stored = await OnrampUserDataAdapter.get(user);
      if (stored?.email) email = stored.email.trim();
    }

    // Preferred: headless Apple Pay + Google Pay links embedded on basemate.app.
    if (email) {
      try {
        const now = new Date();
        const headless = await buildHeadlessFundLinks({
          senderId: user,
          address,
          amount: String(amount),
          email,
          agreementAcceptedAt: now,
          phoneNumberVerifiedAt: now,
          partnerUserRef: address.slice(0, 50),
          clientIp,
        });
        const { paymentLinkOptions } = headless;
        const hostedFallbackUrl = await buildHostedFallbackUrl({
          address,
          partnerUserRef: address.slice(0, 50),
          presetFiatAmount: amount,
          clientIp,
        });
        const { phoneForOnrampLimits, resolveCheckoutLimitState } = await import(
          "@/wallet/onrampLimits.js"
        );
        const limitState = await resolveCheckoutLimitState(phoneForOnrampLimits(user), {
          headlessBlockedReason: headless.headlessBlockedReason,
          headlessOptionCount: paymentLinkOptions.length,
        });
        if (paymentLinkOptions.length > 0 || hostedFallbackUrl) {
          res.setHeader("Cache-Control", "no-store");
          res.json({
            paymentLinkOptions,
            hostedFallbackUrl,
            expiresAt,
            headlessBlockedReason: limitState.headlessBlockedReason,
            limitUpgradeEligible: limitState.limitUpgradeEligible,
            limitUpgradeComplete: limitState.limitUpgradeComplete,
          });
          return;
        }
      } catch (err) {
        logger.warn({ err }, "[fund-session] headless onramp failed; falling back to hosted");
      }
    }

    // Fallback: the hosted Coinbase onramp uses a single-use session token that
    // can't be embedded in an iframe (it errors "already used" on load), so
    // return it as a redirect the client opens via navigation instead.
    const url = await buildHostedFallbackUrl({
      address,
      partnerUserRef: address.slice(0, 50),
      presetFiatAmount: amount,
      clientIp,
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ redirectUrl: url });
  } catch (err) {
    logger.error({ err }, "GET /api/app/fund-session");
    res.status(500).json({ error: "Couldn't start Add funds right now." });
  }
});

router.post("/api/app/limit-upgrade-url", json, async (req: Request, res: Response) => {
  const user = authed(req, res);
  if (!user) return;
  try {
    const { phoneForOnrampLimits, requestEmbeddedLimitUpgrade } = await import(
      "@/wallet/onrampLimits.js"
    );
    const phone = phoneForOnrampLimits(user);
    const { upgradeUrl, expiresAt } = await requestEmbeddedLimitUpgrade(phone);
    res.setHeader("Cache-Control", "no-store");
    res.json({ upgradeUrl, expiresAt });
  } catch (err) {
    logger.error({ err }, "POST /api/app/limit-upgrade-url");
    res.status(502).json({
      error: err instanceof Error ? err.message : "Could not start limit upgrade.",
    });
  }
});

// ── Record funding: log an "Added funds" entry once Coinbase confirms onramp ─
// The dashboard calls this when the embedded Apple Pay frame reports success.
// Onramp deposits happen off our rails (external Coinbase order), so they'd
// otherwise never appear in the activity feed.
router.post("/api/app/record-funding", json, async (req: Request, res: Response) => {
  const user = authed(req, res);
  if (!user) return;
  try {
    const amountRaw = Number(req.body?.amount);
    const amount = Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : 0;
    await recordOnrampFunding({ senderId: user, amountUsd: amount });
    await invalidatePortfolioSnapshot(user);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "POST /api/app/record-funding");
    res.status(500).json({ error: "Could not record funding." });
  }
});

// ── Activity: unified feed with claim state on phone sends ─────────────────
function inferActivityType(label: string | null, recipientPhone: string | null): string {
  if (recipientPhone) return "send";
  const l = (label ?? "").toLowerCase();
  if (/\bswap(ped|ping)?\b/.test(l)) return "swap";
  if (/moonwell|yield|supply|earn|interest|mtoken/.test(l)) return "yield";
  if (/added funds|onramp|top.?up|fund(ed|ing)?/.test(l)) return "fund";
  if (/perp|long|short|avantis|position/.test(l)) return "trade";
  if (/alexander|swear jar/.test(l)) return "transfer";
  if (/\bsend\b|\bsent\b|transfer/.test(l)) return "transfer";
  return "onchain";
}

function claimDetailLine(
  claimState: ReturnType<typeof claimStateForSend>,
  recipientName: string | null,
  recipientPhone: string | null,
): string | null {
  const who = recipientName ?? recipientPhone ?? "them";
  switch (claimState) {
    case "unclaimed":
      return `Claim link sent by text — waiting for ${who} to claim.`;
    case "claimed":
      return `${who} claimed the transfer.`;
    case "returned":
      return "Unclaimed funds were returned to your wallet.";
    case "sent":
      return `Delivered instantly to ${who}'s Basemate wallet.`;
    default:
      return null;
  }
}

async function enrichActivityWithClaims(
  user: string,
  rows: Awaited<ReturnType<typeof TxConfirmationAdapter.listBySenderId>>,
) {
  const txHashes = rows.map((r) => r.tx_hash).filter(Boolean) as string[];
  const phones = [...new Set(rows.map((r) => r.recipient_phone).filter(Boolean) as string[])];
  const [escrows, contacts, giftClaims] = await Promise.all([
    PhoneEscrowAdapter.listByDepositTxHashes(user, txHashes),
    ContactsAdapter.findByPhones(user, phones),
    listGiftClaimUrlsByTx(user, txHashes),
  ]);
  const escrowByTx = new Map(escrows.map((e) => [e.depositTxHash.toLowerCase(), e]));

  return rows
    .map((r) => {
      const txKey = r.tx_hash?.toLowerCase() ?? "";
      const escrow = txKey ? escrowByTx.get(txKey) : undefined;
      const contact = r.recipient_phone ? contacts.get(r.recipient_phone) ?? null : null;
      const claimState =
        r.recipient_phone && escrow?.status === "cancelled"
          ? null
          : claimStateForSend({
              recipientPhone: r.recipient_phone,
              txHash: r.tx_hash,
              escrowStatus: escrow?.status,
            });
      if (r.recipient_phone && escrow?.status === "cancelled") return null;
      const cleanLabel = r.label ? cleanTxLabel(r.label) : r.label;
      const activityType = inferActivityType(cleanLabel, r.recipient_phone);
      return {
        id: r.sid,
        kind: r.recipient_phone ? ("send" as const) : ("activity" as const),
        activityType,
        label: cleanLabel,
        amount: r.transfer_amount,
        asset: r.transfer_asset,
        memo: r.transfer_memo,
        status: r.status,
        txHash: r.tx_hash,
        explorerUrl: r.tx_hash ? `${BASESCAN_TX}${r.tx_hash}` : null,
        recipientPhone: r.recipient_phone,
        recipientName: contact?.name ?? null,
        claimState,
        claimDetail:
          claimState != null
            ? claimDetailLine(
                claimState,
                contact?.name ?? null,
                r.recipient_phone,
              )
            : null,
        claimExpiresAt: escrow?.claimExpiresAt?.toISOString() ?? null,
        claimUrl: txKey ? giftClaims.get(txKey) ?? null : null,
        escrowStatus: escrow?.status ?? null,
        createdAt: r.created_at,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item != null);
}

async function listGiftClaimUrlsByTx(
  senderId: string,
  txHashes: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (txHashes.length === 0) return out;
  try {
    const { db } = await import("@/discovery/db.js");
    const result = await db.query(
      `SELECT lower(gift_tx_hash) AS tx, claim_url
       FROM stock_gifts
       WHERE sender_id = $1
         AND gift_tx_hash IS NOT NULL
         AND claim_url IS NOT NULL
         AND lower(gift_tx_hash) = ANY($2::text[])`,
      [senderId, txHashes.map((h) => h.toLowerCase())],
    );
    for (const row of result.rows) {
      if (row.tx && row.claim_url) out.set(String(row.tx), String(row.claim_url));
    }
  } catch {
    // stock_gifts may not exist yet on older deploys
  }
  return out;
}

router.get("/api/app/activity", async (req: Request, res: Response) => {
  const user = authed(req, res);
  if (!user) return;
  try {
    const rows = await TxConfirmationAdapter.listBySenderId(user, 200);
    const items = await enrichActivityWithClaims(user, rows);

    // Backfill Alexander fines that paid on-chain but never wrote tx_confirmations.
    const knownTx = new Set(
      items.map((i) => i.txHash?.toLowerCase()).filter(Boolean) as string[],
    );
    const fines = await listPaidFinesForSender(user, 50);
    for (const fine of fines) {
      const tx = fine.payTxHash?.toLowerCase();
      if (!tx || knownTx.has(tx)) continue;
      knownTx.add(tx);
      items.push({
        id: `swear-jar-${fine.id}`,
        kind: "activity" as const,
        activityType: "transfer",
        label: "Alexander swear jar — $1 USDC",
        amount: String(SWEAR_FINE_USD),
        asset: "USDC",
        memo: "tribute",
        status: "confirmed",
        txHash: fine.payTxHash,
        explorerUrl: `${BASESCAN_TX}${fine.payTxHash}`,
        recipientPhone: null,
        recipientName: null,
        claimState: null,
        claimDetail: null,
        claimExpiresAt: null,
        claimUrl: null,
        escrowStatus: null,
        createdAt: fine.createdAt,
      });
    }
    items.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    res.setHeader("Cache-Control", "no-store");
    res.json({ items });
  } catch (err) {
    logger.error({ err }, "GET /api/app/activity");
    res.status(500).json({ error: "Could not load activity." });
  }
});

router.get("/api/app/send/resolve", async (req: Request, res: Response) => {
  const user = authed(req, res);
  if (!user) return;
  const phone = typeof req.query.phone === "string" ? req.query.phone : "";
  if (!phone.trim()) {
    res.status(400).json({ error: "Missing phone." });
    return;
  }
  try {
    const result = await resolveAppSendPhone(user, phone);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    logger.error({ err }, "GET /api/app/send/resolve");
    res.status(500).json({ error: "Could not resolve recipient." });
  }
});

router.post("/api/app/send", json, async (req: Request, res: Response) => {
  const user = authed(req, res);
  if (!user) return;
  try {
    const result = await createAppSendPending({
      senderId: user,
      sendId: String(req.body?.sendId ?? ""),
      phone: String(req.body?.phone ?? ""),
      name: String(req.body?.name ?? ""),
      amount: String(req.body?.amount ?? ""),
      asset: typeof req.body?.asset === "string" ? req.body.asset : undefined,
      memo: typeof req.body?.memo === "string" ? req.body.memo : undefined,
    });
    if (!result.ok) {
      res.status(result.status).json({
        error: result.error,
        needsReauth: result.needsReauth,
        depositAmount: result.depositAmount,
      });
      return;
    }
    await invalidatePortfolioSnapshot(user);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      confirmToken: result.confirmToken,
      delivery: result.delivery,
      recipientPhone: result.recipientPhone,
    });
  } catch (err) {
    logger.error({ err }, "POST /api/app/send");
    res.status(500).json({ error: "Could not start send." });
  }
});

router.get("/api/app/stocks", async (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  res.json({ items: listPublicStocks() });
});

router.post("/api/app/stock-gifts", json, async (req: Request, res: Response) => {
  const user = authed(req, res);
  if (!user) return;
  try {
    if (!isWebGiftChannel(req.body?.channel)) {
      res.status(400).json({ error: "Pick iMessage, text, or email." });
      return;
    }
    const symbol = typeof req.body?.symbol === "string" ? req.body.symbol : "";
    const usd = typeof req.body?.usd === "string" ? req.body.usd : String(req.body?.usd ?? "");
    const memo = typeof req.body?.memo === "string" ? req.body.memo : undefined;
    const contactIdRaw = req.body?.recipient?.contactId ?? req.body?.contactId;
    const result = await createWebStockGiftCheckout({
      senderId: user,
      channel: req.body.channel,
      symbol,
      usd,
      memo,
      saveContact: Boolean(req.body?.saveContact),
      recipient: {
        name: typeof req.body?.recipient?.name === "string" ? req.body.recipient.name : undefined,
        phone: typeof req.body?.recipient?.phone === "string" ? req.body.recipient.phone : undefined,
        contactId: Number.isFinite(Number(contactIdRaw)) ? Number(contactIdRaw) : undefined,
      },
    });
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    if (err instanceof WebGiftError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error({ err }, "POST /api/app/stock-gifts");
    res.status(500).json({ error: "Couldn't start that send." });
  }
});

// ── Sends: who the user sent money to (direct + phone escrow) ────────────────
router.get("/api/app/sends", async (req: Request, res: Response) => {
  const user = authed(req, res);
  if (!user) return;
  try {
    const txs = await TxConfirmationAdapter.listBySenderId(user, 200);
    const directSends = txs.filter((t) => t.recipient_phone);
    const txHashes = directSends.map((t) => t.tx_hash).filter(Boolean) as string[];
    const phones = [...new Set(directSends.map((t) => t.recipient_phone).filter(Boolean) as string[])];
    const [escrows, contacts] = await Promise.all([
      PhoneEscrowAdapter.listByDepositTxHashes(user, txHashes),
      ContactsAdapter.findByPhones(user, phones),
    ]);
    const escrowByTx = new Map(escrows.map((e) => [e.depositTxHash.toLowerCase(), e]));

    const items = directSends
      .map((t) => {
        const txKey = t.tx_hash?.toLowerCase() ?? "";
        const escrow = txKey ? escrowByTx.get(txKey) : undefined;
        const contact = t.recipient_phone ? contacts.get(t.recipient_phone) ?? null : null;
        if (escrow?.status === "cancelled") return null;
        const claimState = claimStateForSend({
          recipientPhone: t.recipient_phone,
          txHash: t.tx_hash,
          escrowStatus: escrow?.status,
        });
        return {
          id: t.sid,
          kind: "send" as const,
          recipientName: contact?.name ?? null,
          recipientPhone: t.recipient_phone,
          amount: t.transfer_amount,
          asset: t.transfer_asset,
          memo: t.transfer_memo,
          status: t.status,
          claimState,
          claimExpiresAt: escrow?.claimExpiresAt?.toISOString() ?? null,
          txHash: t.tx_hash,
          explorerUrl: t.tx_hash ? `${BASESCAN_TX}${t.tx_hash}` : null,
          createdAt: t.created_at,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x != null);

    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.setHeader("Cache-Control", "no-store");
    res.json({ items });
  } catch (err) {
    logger.error({ err }, "GET /api/app/sends");
    res.status(500).json({ error: "Could not load your sends." });
  }
});

// ── Contacts ────────────────────────────────────────────────────────────────
router.get("/api/app/contacts", async (req: Request, res: Response) => {
  const user = authed(req, res);
  if (!user) return;
  try {
    const contacts = await ContactsAdapter.listContacts(user);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      items: contacts.map((c) => ({
        id: String(c.id),
        name: c.name,
        phone: c.contact_phone ?? c.contact ?? null,
      })),
    });
  } catch (err) {
    logger.error({ err }, "GET /api/app/contacts");
    res.status(500).json({ error: "Could not load contacts." });
  }
});

router.post("/api/app/contacts", json, async (req: Request, res: Response) => {
  const user = authed(req, res);
  if (!user) return;
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
  if (!name) {
    res.status(400).json({ error: "A contact name is required." });
    return;
  }
  if (!phone) {
    res.status(400).json({ error: "A phone number is required." });
    return;
  }
  try {
    await ContactsAdapter.saveContact(user, name, phone || undefined);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "POST /api/app/contacts");
    res.status(500).json({ error: "Could not save the contact." });
  }
});

/** Bulk contact import (for the native iOS app). Body: { contacts: [{name, phone}] }. */
router.post("/api/app/contacts/import", json, async (req: Request, res: Response) => {
  const user = authed(req, res);
  if (!user) return;
  const list = Array.isArray(req.body?.contacts) ? req.body.contacts : null;
  if (!list) {
    res.status(400).json({ error: "Expected a contacts array." });
    return;
  }
  let saved = 0;
  for (const c of list) {
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    const phone = typeof c?.phone === "string" ? c.phone.trim() : "";
    if (!name) continue;
    try {
      await ContactsAdapter.saveContact(user, name, phone || undefined);
      saved += 1;
    } catch {
      // Skip individual failures so one bad row doesn't abort the import.
    }
  }
  res.json({ ok: true, saved });
});

// ── Profile ─────────────────────────────────────────────────────────────────
router.get("/api/app/profile", async (req: Request, res: Response) => {
  const user = authed(req, res);
  if (!user) return;
  try {
    const [displayName, embedded, profile] = await Promise.all([
      WalletAdapter.getDisplayName(user).catch(() => null),
      WalletAdapter.getEmbeddedWallet(user).catch(() => null),
      UserProfileAdapter.getByPhone(user).catch(() => null),
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      displayName: displayName ?? null,
      basename: profile?.basename ?? null,
      embeddedAddress: embedded?.address ?? null,
      delegation: embedded
        ? { active: !embedded.delegationExpiresAt || embedded.delegationExpiresAt.getTime() > Date.now(), expiresAt: embedded.delegationExpiresAt }
        : null,
    });
  } catch (err) {
    logger.error({ err }, "GET /api/app/profile");
    res.status(500).json({ error: "Could not load your profile." });
  }
});

router.post("/api/app/profile", json, async (req: Request, res: Response) => {
  const user = authed(req, res);
  if (!user) return;
  const displayName = typeof req.body?.displayName === "string" ? req.body.displayName.trim() : "";
  try {
    if (displayName) await WalletAdapter.setDisplayName(user, displayName);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "POST /api/app/profile");
    res.status(500).json({ error: "Could not update your profile." });
  }
});

// ── Preferences: signing mode + auto-send limit ─────────────────────────────
router.get("/api/app/preferences", async (req: Request, res: Response) => {
  const user = authed(req, res);
  if (!user) return;
  try {
    const [mode, limit, swearJarOptIn] = await Promise.all([
      WalletAdapter.getEmbeddedPayMode(user),
      WalletAdapter.getAutoSendLimit(user),
      WalletAdapter.getSwearJarOptIn(user),
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      payMode: mode,
      autoSendLimitUsd: limit ?? DEFAULT_AUTO_SEND_LIMIT_USD,
      swearJarOptIn,
    });
  } catch (err) {
    logger.error({ err }, "GET /api/app/preferences");
    res.status(500).json({ error: "Could not load preferences." });
  }
});

router.post("/api/app/preferences", json, async (req: Request, res: Response) => {
  const user = authed(req, res);
  if (!user) return;
  const mode = req.body?.payMode;
  const limit = req.body?.autoSendLimitUsd;
  const swearJarOptIn = req.body?.swearJarOptIn;
  try {
    if (mode === "manual" || mode === "quick") {
      await WalletAdapter.setEmbeddedPayMode(user, mode);
    }
    if (limit === null) {
      await WalletAdapter.setAutoSendLimit(user, null);
    } else if (typeof limit === "number" && Number.isFinite(limit) && limit >= 0) {
      await WalletAdapter.setAutoSendLimit(user, limit);
    }
    if (typeof swearJarOptIn === "boolean") {
      if (swearJarOptIn) {
        const embedded = await WalletAdapter.getEmbeddedWallet(user);
        const live =
          embedded?.delegationExpiresAt != null &&
          embedded.delegationExpiresAt.getTime() > Date.now() + 60_000;
        if (!live) {
          res.status(400).json({ error: "reconnect first", swearJarOptIn: false });
          return;
        }
      }
      try {
        await WalletAdapter.setSwearJarOptIn(user, swearJarOptIn);
      } catch (err) {
        logger.error({ err }, "POST /api/app/preferences swearJarOptIn");
        res.status(500).json({
          error:
            "Could not save Alexander setting — DB may still need migration 0023 (swear_jar_opt_in).",
        });
        return;
      }
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "POST /api/app/preferences");
    res.status(500).json({ error: "Could not save preferences." });
  }
});

/** Display label for Moonwell underlying symbols in the Interest tab. */
function moonwellInterestLabel(asset: string): string {
  const u = asset.toUpperCase();
  if (u === "WETH") return "ETH";
  if (u === "CBBTC") return "BTC";
  return asset;
}

// ── Yield rates — Moonwell (USDC/ETH/BTC/…) + corridor stable stubs ─────────
router.get("/api/app/yield/rates", async (req: Request, res: Response) => {
  const user = authed(req, res);
  if (!user) return;
  try {
    const rates = await fetchMoonwellRates();
    const moonwellSymbols = new Set(rates.map((r) => r.asset.toUpperCase()));
    const moonwellItems = rates.map((m) => {
      const depositAsset = m.asset.toUpperCase();
      const canDeposit = Boolean(MOONWELL_UNDERLYING_TOKENS[depositAsset]);
      return {
        group: "moonwell" as const,
        symbol: moonwellInterestLabel(m.asset),
        name: m.name,
        peg: depositAsset === "USDC" || depositAsset === "EURC" ? depositAsset : "crypto",
        issuer: "Moonwell",
        status: "verified" as const,
        protocol: "moonwell" as const,
        asset: m.asset,
        apy: m.apy,
        address: m.address,
        depositable: canDeposit && m.apy != null,
      };
    });
    const corridorItems = VERIFIED_STABLES.filter(
      (s) => !moonwellSymbols.has(s.symbol.toUpperCase()),
    ).map((stable) => ({
      group: "corridor" as const,
      symbol: stable.symbol,
      name: stable.name,
      peg: stable.peg,
      issuer: stable.issuer,
      status: stable.status,
      protocol: null,
      asset: stable.symbol,
      apy: null,
      address: stable.address ?? "",
      depositable: false,
    }));
    res.setHeader("Cache-Control", "no-store");
    res.json({ items: [...moonwellItems, ...corridorItems] });
  } catch (err) {
    logger.error({ err }, "GET /api/app/yield/rates");
    res.status(500).json({ error: "Could not load yield rates." });
  }
});

// ── Yield deposit — supply an ERC-20 to Moonwell from the embedded wallet ────
// Executes directly via delegated signing (the in-app amount + Deposit tap is
// the confirmation), mirroring the /api/pay/confirm pattern.
router.post("/api/app/yield/deposit", json, async (req: Request, res: Response) => {
  const user = authed(req, res);
  if (!user) return;
  try {
    const asset = (typeof req.body?.asset === "string" ? req.body.asset.trim() : "").toUpperCase();
    const amount = sanitizeAmount(String(req.body?.amount ?? ""));
    if (!asset || !amount || Number(amount) <= 0) {
      res.status(400).json({ error: "Enter a valid asset and amount." });
      return;
    }
    const token = MOONWELL_UNDERLYING_TOKENS[asset];
    if (!token) {
      res.status(400).json({ error: `${asset} isn't supported for Moonwell deposits.` });
      return;
    }
    const embedded = await WalletAdapter.getEmbeddedWallet(user);
    if (!embedded?.address) {
      res.status(404).json({ error: "No Basemate Account found for this account." });
      return;
    }

    // Balance pre-flight so we fail cleanly instead of reverting on-chain.
    try {
      const holdings = await fetchTraderHoldings(embedded.address, { minValueUsd: 0 });
      const held = holdings.find((h) => h.symbol.toUpperCase() === asset);
      if (!held || Number(held.amount) < Number(amount)) {
        res.status(400).json({
          error: `Not enough ${asset} to deposit — you have ${held ? held.amount : "0"} ${asset}.`,
        });
        return;
      }
    } catch (err) {
      logger.warn({ err }, "[yield/deposit] balance pre-flight failed; proceeding");
    }

    const built = buildMoonwellSupplyCalls({
      assetSymbol: asset,
      assetAddress: token.address,
      decimals: token.decimals,
      amount,
    });
    if (!built) {
      res.status(400).json({ error: `Couldn't build a Moonwell deposit for ${asset}.` });
      return;
    }

    const result = await EmbeddedWalletAdapter.sendCalls({
      userId: embedded.cdpUserId,
      address: embedded.address,
      calls: built.calls,
    });
    await TxConfirmationAdapter.recordConfirmedActivity({
      senderId: user,
      fromAddress: embedded.address,
      chainId: "0x2105", // Base mainnet
      label: built.label,
      txHash: result.txHash ?? null,
      transferAmount: amount,
      transferAsset: asset,
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ txHash: result.txHash });
  } catch (err) {
    if (err instanceof EmbeddedWalletError && err.needsReauth) {
      res
        .status(409)
        .json({ error: "Your Basemate authorization expired — reconnect to deposit.", needsReauth: true });
      return;
    }
    logger.error({ err }, "POST /api/app/yield/deposit");
    res.status(500).json({ error: "Couldn't complete your deposit right now." });
  }
});

export function mountAppApi(app: import("express").Express): void {
  app.use(router);
}
