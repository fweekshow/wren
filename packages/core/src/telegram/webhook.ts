import { timingSafeEqual } from "node:crypto";

import express from "express";

import { config } from "@/config/index.js";
import { logger } from "@/utils/logger.js";

import { handleTelegramUpdate, type TelegramUpdate } from "./controller.js";

/** Best-effort in-memory dedupe of Telegram update_id (retries return non-200). */
const seenUpdates = new Set<number>();
const SEEN_LIMIT = 5000;

function markSeen(updateId: number): boolean {
  if (seenUpdates.has(updateId)) return false;
  seenUpdates.add(updateId);
  if (seenUpdates.size > SEEN_LIMIT) {
    // Drop the oldest ~10% by rebuilding from the tail.
    const keep = [...seenUpdates].slice(-Math.floor(SEEN_LIMIT * 0.9));
    seenUpdates.clear();
    for (const id of keep) seenUpdates.add(id);
  }
  return true;
}

function secretMatches(header: string | undefined): boolean {
  const expected = config.telegram.webhookSecret;
  if (!expected) return false; // fail closed — never accept unverified in prod
  const got = header ?? "";
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Authenticated Telegram webhook receiver, mounted on basemate-channels. Telegram
 * echoes the configured secret in X-Telegram-Bot-Api-Secret-Token on every
 * update; we verify it in constant time and FAIL CLOSED when the secret is unset.
 * This replaces the deprecated unauthenticated Grammy `/telegram/webhook`.
 */
export function buildTelegramWebhookRoute(): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  router.post("/", (req: express.Request, res: express.Response): void => {
    if (!secretMatches(req.header("X-Telegram-Bot-Api-Secret-Token"))) {
      res.status(401).send("bad secret");
      return;
    }

    const update = req.body as (TelegramUpdate & { update_id?: number }) | undefined;
    if (!update || typeof update.update_id !== "number") {
      res.status(400).send("bad update");
      return;
    }

    // Ack immediately so Telegram doesn't retry; process async.
    res.status(200).send("ok");

    if (!markSeen(update.update_id)) return; // duplicate retry
    void handleTelegramUpdate(update).catch((err) =>
      logger.warn(`[Telegram] update ${update.update_id} failed: ${(err as Error).message}`),
    );
  });

  return router;
}

/** Whether the VibeTrading Telegram channel is safe to enable in this process. */
export function telegramChannelReady(): { ok: boolean; reason?: string } {
  if (!config.telegram.enabled) return { ok: false, reason: "TELEGRAM_VIBETRADING_ENABLED not set" };
  if (!config.telegram.botToken) return { ok: false, reason: "TELEGRAM_BOT_TOKEN not set" };
  const isProd = process.env.NODE_ENV === "production";
  if (isProd && !config.telegram.webhookSecret) {
    return { ok: false, reason: "TELEGRAM_WEBHOOK_SECRET required in production (fail-closed)" };
  }
  return { ok: true };
}
