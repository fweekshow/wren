import { createClient } from "@photon-ai/advanced-imessage";

import { config } from "@/config/config.js";
import { logger } from "@/utils/logger.js";

import { ALEXANDER_IMAGE_URL } from "./constants.js";

type SpaceWithAvatar = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  avatar?: (...args: any[]) => Promise<void>;
};

let cachedBytes: Buffer | null = null;

async function fetchPortraitBytes(): Promise<Buffer> {
  if (cachedBytes) return cachedBytes;
  const res = await fetch(ALEXANDER_IMAGE_URL);
  if (!res.ok) throw new Error(`alexander image fetch ${res.status}`);
  cachedBytes = Buffer.from(await res.arrayBuffer());
  return cachedBytes;
}

/**
 * Set Alexander's portrait as the iMessage group PFP (not a chat background).
 * Prefer Spectrum space.avatar; fall back to advanced-imessage groups.setIcon.
 */
export async function setAlexanderGroupAvatar(args: {
  space: SpaceWithAvatar;
  conversationId: string;
}): Promise<boolean> {
  try {
    if (typeof args.space.avatar === "function") {
      await args.space.avatar(ALEXANDER_IMAGE_URL);
      logger.info(
        { conversationId: args.conversationId },
        "[swear-jar] set group avatar via space.avatar",
      );
      return true;
    }
  } catch (err) {
    logger.warn({ err }, "[swear-jar] space.avatar failed; trying setIcon");
  }

  const { address, token } = config.imessageBackgrounds;
  if (!address || !token) {
    logger.warn("[swear-jar] no Advanced creds for group setIcon; skipping avatar");
    return false;
  }

  try {
    const bytes = await fetchPortraitBytes();
    const im = createClient({ address, token });
    try {
      await im.groups.setIcon(args.conversationId, bytes);
      logger.info(
        { conversationId: args.conversationId },
        "[swear-jar] set group avatar via groups.setIcon",
      );
      return true;
    } finally {
      await im.close().catch(() => {});
    }
  } catch (err) {
    logger.warn({ err, conversationId: args.conversationId }, "[swear-jar] setIcon failed");
    return false;
  }
}
