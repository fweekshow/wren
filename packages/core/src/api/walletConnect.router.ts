import express, { Router, type Request, type Response } from "express";
import { getAddress } from "viem";

import { db } from "@/discovery/db.js";
import { EmbeddedWalletAdapter, EmbeddedWalletError } from "@/wallet/embeddedWallet.js";
import { logger } from "@/utils/logger.js";
import {
  buildWalletReconnectedMessage,
  sendWalletConnectNotifyDm,
} from "@/wallet/walletConnectNotify.js";

const router = Router();
const TOKEN_RE = /^[a-f0-9]{32}$/i;

type SetupSessionRow = {
  expires_at: Date | string;
  completed_at: Date | string | null;
};

router.post(
  "/api/wallet/delegation",
  express.json({ limit: "32kb" }),
  async (req: Request, res: Response) => {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
    const rawAddress = typeof req.body?.address === "string" ? req.body.address.trim() : "";
    if (!TOKEN_RE.test(token) || !userId || !rawAddress) {
      res.status(400).json({ error: "Missing or invalid delegation lookup details." });
      return;
    }

    let address: string;
    try {
      address = getAddress(rawAddress);
    } catch {
      res.status(400).json({ error: "Invalid wallet address." });
      return;
    }

    try {
      const result = await db.query<SetupSessionRow>(
        `SELECT expires_at, completed_at
           FROM base_account_setup_sessions
          WHERE token = $1
          LIMIT 1`,
        [token],
      );
      const session = result.rows[0];
      if (!session || new Date(session.expires_at) <= new Date()) {
        res.status(404).json({ error: "This setup link is invalid or has expired." });
        return;
      }
      if (session.completed_at) {
        res.status(409).json({ error: "This setup link was already used." });
        return;
      }

      const delegation = await EmbeddedWalletAdapter.getReusableDelegation(userId, address);
      res.setHeader("Cache-Control", "no-store");
      res.json({ active: Boolean(delegation), expiresAt: delegation?.expiresAt ?? null });
    } catch (err) {
      if (err instanceof EmbeddedWalletError) {
        res.status(400).json({ error: err.message });
        return;
      }
      logger.error({ err }, "POST /api/wallet/delegation");
      res.status(502).json({ error: "Could not check the existing wallet authorization." });
    }
  },
);

type SetupSessionNotifyRow = {
  sender_id: string;
  completed_at: Date | string | null;
};

/**
 * POST /api/agent/wallet/connected-notify
 * Called by basemate-metrics after the wallet-connect DB write succeeds.
 * Looks up the sender_id from the session token and sends a proactive DM.
 * Body: { token, isReauth?: boolean }
 */
router.post(
  "/api/agent/wallet/connected-notify",
  express.json({ limit: "32kb" }),
  async (req: Request, res: Response) => {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!TOKEN_RE.test(token)) {
      res.status(400).json({ error: "Missing or invalid session token." });
      return;
    }
    try {
      const result = await db.query<SetupSessionNotifyRow>(
        `SELECT sender_id, completed_at
           FROM base_account_setup_sessions
          WHERE token = $1
          LIMIT 1`,
        [token],
      );
      const session = result.rows[0];
      if (!session?.completed_at) {
        res.status(404).json({ error: "Session not completed." });
        return;
      }
      // Use reconnected copy for both fresh setups and re-auths — it's always true.
      const message = buildWalletReconnectedMessage();
      const sent = await sendWalletConnectNotifyDm(session.sender_id, message);
      res.json({ ok: true, sent });
    } catch (err) {
      logger.error({ err }, "POST /api/agent/wallet/connected-notify");
      res.status(503).json({ error: "Could not deliver notification." });
    }
  },
);

export function mountWalletConnectApi(app: import("express").Express): void {
  app.use(router);
}
