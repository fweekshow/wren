import { config } from "@/config/index.js";
import { logger } from "@/utils/logger.js";

/**
 * Minimal Telegram Bot API client for VibeTrading. Direct HTTPS to the Bot API
 * (spectrum-ts 1.18 has no Telegram provider); we reuse the existing
 * `TELEGRAM_BOT_TOKEN` so the bot identity/username is preserved on cutover.
 */

export interface TgInlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export type TgInlineKeyboard = TgInlineButton[][];

function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${config.telegram.botToken}/${method}`;
}

async function call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T | null> {
  if (!config.telegram.botToken) {
    logger.warn(`[Telegram] ${method} skipped — TELEGRAM_BOT_TOKEN not set`);
    return null;
  }
  try {
    const res = await fetch(apiUrl(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) {
      logger.warn(`[Telegram] ${method} failed: ${json.description ?? res.status}`);
      return null;
    }
    return json.result ?? null;
  } catch (err) {
    logger.warn(`[Telegram] ${method} error: ${(err as Error).message}`);
    return null;
  }
}

export interface SendMessageResult {
  message_id: number;
  chat: { id: number };
}

export function sendMessage(args: {
  chatId: string | number;
  text: string;
  keyboard?: TgInlineKeyboard;
  /** Defaults to HTML so views can use <b>/<code> hierarchy. */
  parseMode?: "HTML" | "MarkdownV2" | null;
}): Promise<SendMessageResult | null> {
  const parse_mode = args.parseMode === null ? undefined : (args.parseMode ?? "HTML");
  return call<SendMessageResult>("sendMessage", {
    chat_id: args.chatId,
    text: args.text,
    parse_mode,
    reply_markup: args.keyboard ? { inline_keyboard: args.keyboard } : undefined,
  });
}

export function editMessageText(args: {
  chatId: string | number;
  messageId: number;
  text: string;
  keyboard?: TgInlineKeyboard;
  parseMode?: "HTML" | "MarkdownV2" | null;
}): Promise<unknown> {
  const parse_mode = args.parseMode === null ? undefined : (args.parseMode ?? "HTML");
  return call("editMessageText", {
    chat_id: args.chatId,
    message_id: args.messageId,
    text: args.text,
    parse_mode,
    reply_markup: args.keyboard ? { inline_keyboard: args.keyboard } : undefined,
  });
}

/** Every callback_query MUST be answered (removes the client spinner). */
export function answerCallbackQuery(args: {
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
}): Promise<unknown> {
  return call("answerCallbackQuery", {
    callback_query_id: args.callbackQueryId,
    text: args.text,
    show_alert: args.showAlert ?? false,
  });
}

export function sendChatAction(chatId: string | number, action = "typing"): Promise<unknown> {
  return call("sendChatAction", { chat_id: chatId, action });
}

export interface TelegramUserProfile {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name?: string;
}

export function getMe(): Promise<TelegramUserProfile | null> {
  return call<TelegramUserProfile>("getMe", {});
}

/**
 * Register the webhook with Telegram, binding the secret token. Telegram will
 * echo the secret in the X-Telegram-Bot-Api-Secret-Token header on every update.
 * Only one webhook can be active per bot, so this is the atomic cutover point
 * from the deprecated Grammy `/telegram/webhook` mount.
 */
export function setWebhook(args: {
  url: string;
  secretToken: string;
}): Promise<unknown> {
  return call("setWebhook", {
    url: args.url,
    secret_token: args.secretToken,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
}

/** Drop the bot webhook so Telegram stops delivering VibeTrading updates. */
export function deleteWebhook(): Promise<unknown> {
  return call("deleteWebhook", { drop_pending_updates: true });
}
