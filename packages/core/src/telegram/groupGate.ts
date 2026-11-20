import type { TelegramBotIdentity } from "./botIdentity.js";

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  user?: { id: number; is_bot?: boolean };
}

export interface TelegramInboundMessage {
  text?: string;
  entities?: TelegramMessageEntity[];
  reply_to_message?: {
    from?: { id: number; is_bot?: boolean };
  };
}

const VIBE_COMMANDS = new Set(["/start", "/vibe", "/basemate", "/strategies"]);

export function isPrivateTelegramChat(chatType: string): boolean {
  return chatType === "private";
}

/** Slash commands that open the VibeTrading menu in a group. */
export function isVibeTradingCommand(text: string): boolean {
  const first = text.trim().split(/\s/)[0]?.toLowerCase() ?? "";
  if (!first.startsWith("/")) return false;
  const base = first.split("@")[0]!;
  return VIBE_COMMANDS.has(base);
}

function isReplyToBot(message: TelegramInboundMessage, bot: TelegramBotIdentity): boolean {
  const from = message.reply_to_message?.from;
  if (!from?.is_bot) return false;
  return bot.id ? from.id === bot.id : true;
}

function hasBotMention(message: TelegramInboundMessage, bot: TelegramBotIdentity): boolean {
  const text = message.text ?? "";
  if (!text || !message.entities?.length) return false;

  for (const entity of message.entities) {
    if (entity.type === "mention") {
      const mention = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
      if (mention === `@${bot.username.toLowerCase()}`) return true;
    }
    if (entity.type === "text_mention" && entity.user?.id === bot.id) return true;
  }
  return false;
}

/**
 * In groups, respond only when the user explicitly invokes the bot:
 *  - /start, /vibe, /basemate, /strategies (with or without @botusername)
 *  - @mention of the bot
 *  - reply to one of the bot's messages
 *
 * With BotFather "Group Privacy" enabled (recommended), Telegram only delivers
 * these messages anyway — this gate is defense-in-depth if privacy is off.
 */
export function shouldRespondInGroup(
  message: TelegramInboundMessage,
  bot: TelegramBotIdentity | null,
): boolean {
  if (!bot) return false;
  const text = message.text ?? "";
  if (isVibeTradingCommand(text)) return true;
  if (hasBotMention(message, bot)) return true;
  if (isReplyToBot(message, bot)) return true;
  return false;
}

/** Remove @bot mentions and slash-command prefixes so prompts read cleanly. */
export function normalizeGroupMessageText(
  text: string,
  entities: TelegramMessageEntity[] | undefined,
  bot: TelegramBotIdentity | null,
): string {
  let out = text.trim();
  if (!out) return out;

  if (bot && entities?.length) {
    const parts: string[] = [];
    let cursor = 0;
    const sorted = [...entities].sort((a, b) => a.offset - b.offset);
    for (const entity of sorted) {
      const slice = out.slice(entity.offset, entity.offset + entity.length);
      const isMention =
        (entity.type === "mention" && slice.toLowerCase() === `@${bot.username.toLowerCase()}`) ||
        (entity.type === "text_mention" && entity.user?.id === bot.id);
      if (isMention) {
        parts.push(out.slice(cursor, entity.offset));
        cursor = entity.offset + entity.length;
      }
    }
    parts.push(out.slice(cursor));
    out = parts.join("").replace(/\s+/g, " ").trim();
  }

  out = out.replace(/^\/(?:start|vibe|basemate|strategies)(@\w+)?\s*/i, "").trim();
  return out;
}
