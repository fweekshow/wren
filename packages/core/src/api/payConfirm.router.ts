import express, { Router, type Request, type Response } from "express";

import { TxConfirmationAdapter } from "@/discovery/adapters/txConfirmation.adapter.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import {
  FlashPlaceError,
  PendingFlashAdapter,
  flashActivityAmountAsset,
  flashFillTxHash,
  formatFlashActivityLabel,
  placeFlashOrder,
  resolveFlashFillOnce,
  waitForFlashFill,
  type FlashPreparedOrder,
} from "@/discovery/flash/index.js";
import { EmbeddedWalletAdapter, EmbeddedWalletError } from "@/wallet/embeddedWallet.js";
import { PendingPayAdapter } from "@/wallet/pendingPay.js";
import type { PendingPayRow } from "@/wallet/pendingPay.js";
import { PhoneEscrowAdapter } from "@/wallet/phoneEscrow.js";
import { verifyPortfolioAccessToken } from "@/portfolio/access.js";
import { cleanTxLabel } from "@/tx-confirmations/poller.js";
import { friendlyFlashPlaceError } from "@/messaging/handlers/flashReceipt.js";
import { logger } from "@/utils/logger.js";

const router = Router();
const TOKEN_RE = /^[a-f0-9]{32}$/i;

type PaySession = {
  user: string;
  sessionToken: string;
};

function readPaySession(req: Request): PaySession {
  return {
    user: typeof req.body?.user === "string" ? req.body.user.trim() : "",
    sessionToken:
      typeof req.body?.sessionToken === "string" ? req.body.sessionToken.trim() : "",
  };
}

export function authorizePendingPayOwner(
  row: Pick<PendingPayRow, "senderId">,
  session: PaySession,
): { ok: true } | { ok: false; status: 401 | 403; error: string } {
  if (!session.user || !session.sessionToken) {
    return { ok: false, status: 401, error: "Sign in to confirm this transaction." };
  }
  const verified = verifyPortfolioAccessToken(session.user, session.sessionToken);
  if (!verified.ok) {
    return { ok: false, status: 401, error: "Your session has expired. Sign in again." };
  }
  if (session.user !== row.senderId) {
    return { ok: false, status: 403, error: "This transaction belongs to another Basemate account." };
  }
  return { ok: true };
}

router.post("/api/pay/authorize", express.json({ limit: "256kb" }), async (req: Request, res: Response) => {
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  if (!TOKEN_RE.test(token)) {
    res.status(400).json({ error: "Missing or invalid confirmation token." });
    return;
  }

  try {
    const row = await PendingPayAdapter.getByToken(token);
    if (!row) {
      res.status(404).json({ error: "This confirmation link is invalid or has expired." });
      return;
    }
    if (row.walletKind !== "embedded") {
      res.status(400).json({ error: "This transaction does not use an embedded wallet." });
      return;
    }
    const auth = authorizePendingPayOwner(row, readPaySession(req));
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "POST /api/pay/authorize");
    res.status(503).json({ error: "Could not authorize this transaction." });
  }
});

/**
 * POST /api/pay/confirm — execute a pending embedded-wallet transaction after the
 * user taps "Confirm" on the /pay page. The pending-pay token locates the exact
 * transaction, while the signed app session proves it belongs to the caller.
 * Signing happens server-side via the user's delegation, so this endpoint must
 * live in the agent (not the Next app, which has no CDP wallet secret).
 */
router.post("/api/pay/confirm", express.json({ limit: "256kb" }), async (req: Request, res: Response) => {
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  if (!TOKEN_RE.test(token)) {
    res.status(400).json({ error: "Missing or invalid confirmation token." });
    return;
  }

  try {
    const row = await PendingPayAdapter.getByToken(token);
    if (!row) {
      res.status(404).json({ error: "This confirmation link is invalid or has expired." });
      return;
    }
    if (row.walletKind !== "embedded") {
      res.status(400).json({ error: "This transaction is signed in your wallet, not confirmed here." });
      return;
    }
    if (row.status !== "pending") {
      res.status(409).json({ error: "This transaction was already completed or expired." });
      return;
    }
    const auth = authorizePendingPayOwner(row, readPaySession(req));
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    const embedded = await WalletAdapter.getEmbeddedWallet(row.senderId);
    if (!embedded) {
      res.status(409).json({ error: "Your Basemate account isn't connected — reconnect and try again.", needsReauth: true });
      return;
    }
    if (embedded.address.toLowerCase() !== row.fromAddress.toLowerCase()) {
      logger.error(
        { senderId: row.senderId, pendingFrom: row.fromAddress, wallet: embedded.address },
        "[pay/confirm] embedded wallet address mismatch",
      );
      res.status(409).json({ error: "This transaction no longer matches your connected wallet." });
      return;
    }

    if (row.executionKind === "flash") {
      const prepared = row.flashPrepared as FlashPreparedOrder | null;
      if (!prepared?.orderTypedData || !prepared.funderAddress) {
        res.status(400).json({ error: "This Flash confirmation is incomplete — ask me to quote again." });
        return;
      }

      const placed = await placeFlashOrder({
        cdpUserId: embedded.cdpUserId,
        prepared,
      });
      const detail = await waitForFlashFill({
        orderId: placed.orderId,
        funderAddress: prepared.funderAddress,
        initial: placed.detail,
        attempts: prepared.orderType === "market" ? 10 : 4,
      });
      const hash = flashFillTxHash(detail) ?? placed.approveTxHash ?? null;
      const { amount, asset } = flashActivityAmountAsset(prepared);
      const activityLabel = formatFlashActivityLabel(prepared);

      const submitted = hash
        ? Boolean(await PendingPayAdapter.markSigned(token, hash))
        : await PendingPayAdapter.markEmbeddedConfirmed(token, hash);
      if (!submitted) {
        res.status(409).json({ error: "This transaction was already completed." });
        return;
      }

      try {
        await PendingFlashAdapter.track({
          orderId: placed.orderId,
          senderId: row.senderId,
          prepared,
        });
        await resolveFlashFillOnce({
          orderId: placed.orderId,
          senderId: row.senderId,
          prepared,
          detail,
        });
        // ensure activity even if fill race already recorded
        if (!detail || detail.status !== "ORDER_STATUS_FILLED") {
          await TxConfirmationAdapter.recordConfirmedActivity({
            senderId: row.senderId,
            fromAddress: embedded.address,
            chainId: row.chainId,
            label: activityLabel,
            txHash: hash,
            transferAmount: amount,
            transferAsset: asset,
            transferMemo: `flash:${placed.orderId}`,
          });
        }
      } catch (err) {
        logger.error({ err }, "[pay/confirm] flash activity failed");
      }

      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, txHash: hash, orderId: placed.orderId });
      return;
    }

    const result = await EmbeddedWalletAdapter.sendCalls({
      userId: embedded.cdpUserId,
      address: embedded.address,
      calls: row.calls as Parameters<typeof EmbeddedWalletAdapter.sendCalls>[0]["calls"],
    });
    const hash = result.txHash;

    // Leave the row in the receipt poller's signed lane. The poller owns the
    // signed->confirmed transition and sends the chat confirmation exactly once.
    const submitted = await PendingPayAdapter.markSigned(token, hash);
    if (!submitted) {
      res.status(409).json({ error: "This transaction was already completed." });
      return;
    }

    // Log the confirmed tx to the activity feed and, for contact sends (phone +
    // amount stashed on the pending row), schedule the recipient text. Best-effort
    // — a logging/notification failure must not fail the already-executed transfer.
    try {
      await TxConfirmationAdapter.recordConfirmedActivity({
        senderId: row.senderId,
        fromAddress: embedded.address,
        chainId: row.chainId,
        label: row.label ? cleanTxLabel(row.label) : row.label,
        txHash: hash,
        recipientPhone: row.recipientDisplay,
        transferAmount: row.amount,
        transferAsset: row.tokenSymbol,
        transferMemo: row.transferMemo,
      });
    } catch (err) {
      logger.error({ err }, "[pay/confirm] activity/notification failed");
    }

    // Start the 72h claim clock for phone-escrow deposits (no-op for direct sends).
    if (row.recipientDisplay && hash) {
      try {
        await PhoneEscrowAdapter.confirmDeposit({
          senderId: row.senderId,
          recipientPhone: row.recipientDisplay,
          depositTxHash: hash,
          senderRefundAddress: embedded.address,
          amountDisplay: row.amount,
          tokenSymbol: row.tokenSymbol,
        });
      } catch (err) {
        logger.error({ err }, "[pay/confirm] phone escrow confirm failed");
      }
    }

    try {
      const { consumePendingAutoSaveContact } = await import(
        "@/messaging/utils/autoSaveContact.utils.js"
      );
      await consumePendingAutoSaveContact(row.senderId, token);
    } catch (err) {
      logger.error({ err }, "[pay/confirm] auto-save contact failed");
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, txHash: hash });
  } catch (err) {
    if (err instanceof EmbeddedWalletError && err.needsReauth) {
      res.status(409).json({ error: err.message, needsReauth: true });
      return;
    }
    if (err instanceof FlashPlaceError) {
      res.status(502).json({ error: friendlyFlashPlaceError(err.message) });
      return;
    }
    logger.error({ err }, "POST /api/pay/confirm");
    res.status(502).json({ error: "Couldn't complete this transaction — try again in a moment." });
  }
});

export function mountPayConfirmApi(app: import("express").Express): void {
  app.use(router);
}
