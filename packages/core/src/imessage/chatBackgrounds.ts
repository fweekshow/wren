import { readFile } from "node:fs/promises";

import { createClient } from "@photon-ai/advanced-imessage";

import { config } from "@/config/config.js";
import { logger } from "@/utils/logger.js";
import type { ImessageProductMode } from "@/messaging/productMode.js";

type AdvancedImessageClient = ReturnType<typeof createClient>;

const lastAppliedModeBySender = new Map<string, ImessageProductMode>();

let client: AdvancedImessageClient | undefined;
let warnedDisabled = false;

function configuredPathForMode(mode: ImessageProductMode): string {
  return mode === "trading"
    ? config.imessageBackgrounds.tradingPath
    : config.imessageBackgrounds.moneyPath;
}

function getClient(): AdvancedImessageClient | undefined {
  const { address, token } = config.imessageBackgrounds;
  if (!address || !token) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      logger.warn(
        "[iMessage] chat backgrounds disabled; set IMESSAGE_ADVANCED_ADDRESS and IMESSAGE_ADVANCED_TOKEN",
      );
    }
    return undefined;
  }

  client ??= createClient({ address, token });
  return client;
}

export async function applyImessageChatBackground(args: {
  senderId: string;
  mode: ImessageProductMode;
}): Promise<boolean> {
  const senderId = args.senderId.trim();
  if (!senderId) return false;
  if (lastAppliedModeBySender.get(senderId) === args.mode) return false;

  const path = configuredPathForMode(args.mode);
  if (!path) {
    logger.warn(
      { mode: args.mode },
      "[iMessage] chat background path missing; set IMESSAGE_TRADING_BACKGROUND_PATH or IMESSAGE_MONEY_BACKGROUND_PATH",
    );
    return false;
  }

  const im = getClient();
  if (!im) return false;

  try {
    const data = await readFile(path);
    const { chat } = await im.chats.create([senderId]);
    await im.chats.setBackground(chat.guid, data);
    lastAppliedModeBySender.set(senderId, args.mode);
    logger.info(
      { senderId, mode: args.mode, chatGuid: chat.guid },
      "[iMessage] applied chat background",
    );
    return true;
  } catch (err) {
    logger.warn(
      { err, senderId, mode: args.mode, path },
      "[iMessage] failed to apply chat background",
    );
    return false;
  }
}

export async function closeImessageChatBackgroundClient(): Promise<void> {
  const existing = client;
  client = undefined;
  if (existing) await existing.close();
}

export function resetImessageChatBackgroundStateForTests(): void {
  lastAppliedModeBySender.clear();
  client = undefined;
  warnedDisabled = false;
}
