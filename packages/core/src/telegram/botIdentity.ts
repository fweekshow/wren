import { config } from "@/config/index.js";
import { logger } from "@/utils/logger.js";

import { getMe } from "./api.js";

export interface TelegramBotIdentity {
  id: number;
  username: string;
}

let cached: TelegramBotIdentity | null = null;

/** Resolve @username via getMe (cached). Falls back to TELEGRAM_BOT_USERNAME. */
export async function getTelegramBotIdentity(): Promise<TelegramBotIdentity | null> {
  if (cached) return cached;

  const envUser = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  const me = await getMe();
  if (me?.username) {
    cached = { id: me.id, username: me.username };
    return cached;
  }

  if (envUser) {
    cached = { id: 0, username: envUser };
    logger.warn("[Telegram] getMe failed — using TELEGRAM_BOT_USERNAME fallback");
    return cached;
  }

  return null;
}

/** Warm the cache on startup so group mention matching works immediately. */
export async function warmTelegramBotIdentity(): Promise<void> {
  if (!config.telegram.botToken) return;
  await getTelegramBotIdentity();
}
