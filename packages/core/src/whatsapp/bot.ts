import {
  createClient,
  WhatsAppError,
} from "@photon-ai/whatsapp-business";

import { config } from "@/config/config.js";
import { createImessageHandler } from "@/messaging/handler.js";
import {
  portfolioReviewDelivery,
  PortfolioReviewPoller,
  PortfolioReviewWorker,
  parseReviewDmTarget,
} from "@/portfolio-reviews/index.js";
import {
  parseDmTarget,
  priceAlertDelivery,
  PriceAlertPoller,
} from "@/price-alerts/index.js";
import { TxConfirmationPoller } from "@/tx-confirmations/poller.js";
import { EscrowReleasePoller } from "@/wallet/escrowReleasePoller.js";
import { EscrowRefundPoller } from "@/wallet/escrowRefundPoller.js";
import { OfframpStatusPoller, offrampDelivery } from "@/wallet/offrampPoller.js";

import { WhatsappCursorAdapter } from "./cursor.adapter.js";
import { normalizeWhatsappInbound, type WhatsappInboundContent } from "./inbound.js";
import { whatsappLiveness } from "./liveness.js";
import { renderWhatsappOutbound } from "./outbound.js";
import { canonicalizeSenderId } from "@/messaging/utils/senderId.utils.js";

const MESSAGE_TIMEOUT_MS = 90_000;
const RECONNECT_DELAY_MS = 5_000;
const FETCH_MISSED_LIMIT = 100;

type WhatsappInboundEvent = {
  type: "message";
  cursor: string;
  message: {
    id: string;
    from: string;
    content: WhatsappInboundContent;
  };
};

type WhatsappStatusEvent = {
  type: "status";
  cursor: string;
  status: {
    id: string;
    status: string;
    errors?: Array<{ code?: string; title?: string; message?: string }>;
  };
};

type WhatsappEvent = WhatsappInboundEvent | WhatsappStatusEvent;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNonRetryableWhatsappError(error: unknown): boolean {
  if (!(error instanceof WhatsAppError)) return false;
  return !error.retryable && (
    error.code === "invalidArgument" ||
    error.code === "preconditionFailed" ||
    error.code === "unauthenticated" ||
    error.code === "unauthorized"
  );
}

function targetFromDmTarget(target: Record<string, unknown> | null, fallback: string): string {
  const to = target?.to;
  return typeof to === "string" && to.trim() ? to : fallback;
}

export async function startWhatsappBot(): Promise<void> {
  if (!config.whatsapp.accessToken || !config.whatsapp.phoneNumberId || !config.whatsapp.appSecret) {
    throw new Error(
      "WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and WHATSAPP_APP_SECRET are required in .env to run the WhatsApp bot",
    );
  }

  const client = createClient({
    accessToken: config.whatsapp.accessToken,
    phoneNumberId: config.whatsapp.phoneNumberId,
    appSecret: config.whatsapp.appSecret,
    retry: true,
    timeout: config.whatsapp.requestTimeoutMs,
  });
  await WhatsappCursorAdapter.createTable();
  const handler = createImessageHandler(
    undefined,
    undefined,
    { platform: "whatsapp", logPrefix: "[WhatsApp]" },
  );
  let cursor = await WhatsappCursorAdapter.get(config.whatsapp.cursorKey);
  let shuttingDown = false;
  const senderChains = new Map<string, Promise<void>>();

  const sendText = async (to: string, text: string, replyTo?: string): Promise<void> => {
    if (!text.trim()) return;
    await client.messages.send({
      to,
      ...(replyTo ? { replyTo } : {}),
      text: { body: text, previewUrl: text.includes("https://") },
    });
  };

  const deliverToUser = async (to: string, message: string): Promise<boolean> => {
    try {
      await sendText(to, message);
      return true;
    } catch (error) {
      console.warn("⚠️ [WhatsApp] proactive delivery failed:", error);
      return false;
    }
  };

  priceAlertDelivery.register("whatsapp", async (alert, message) => {
    const target = parseDmTarget<{ to?: string }>(alert);
    return deliverToUser(targetFromDmTarget(target, alert.user_key), message);
  });
  new PriceAlertPoller({}, "whatsapp").start();

  portfolioReviewDelivery.register("whatsapp", async (subscription, message) => {
    const target = parseReviewDmTarget<{ to?: string }>(subscription);
    return deliverToUser(targetFromDmTarget(target, subscription.user_key), message);
  });
  new PortfolioReviewPoller("whatsapp").start();
  new PortfolioReviewWorker("whatsapp").start();

  new TxConfirmationPoller({
    // Recipient escrow invites are owned by Photon/Spectrum so channel pollers
    // cannot race and deliver the same phone notification over WhatsApp.
    recipientNotificationsEnabled: true,
    deliver: (row, message) => deliverToUser(row.sender_id, message),
    deliverRecipient: (phone, message) => deliverToUser(phone, message),
  }).start();
  new EscrowReleasePoller({
    deliver: (phone, message) => deliverToUser(phone, message),
  }).start();
  new EscrowRefundPoller({
    deliver: (senderId, message) => deliverToUser(senderId, message),
  }).start();
  offrampDelivery.register("whatsapp", (session, message) =>
    deliverToUser(session.userKey, message),
  );
  new OfframpStatusPoller("whatsapp").start();

  const persistCursor = async (nextCursor: string): Promise<void> => {
    cursor = nextCursor;
    await WhatsappCursorAdapter.set(config.whatsapp.cursorKey, nextCursor);
  };

  const handleMessage = async (event: WhatsappInboundEvent): Promise<void> => {
    const { message } = event;
    const senderId = canonicalizeSenderId(message.from.trim());
    if (!senderId) return;

    whatsappLiveness.markActivity();
    const inbound = normalizeWhatsappInbound(message.content);

    if (inbound.kind === "unsupported") {
      await sendText(senderId, inbound.reply, message.id);
      return;
    }

    if (inbound.kind === "contact") {
      const reply = await handler.handleInboundContact({
        senderId,
        name: inbound.name,
        phone: inbound.phone,
      });
      await sendText(senderId, reply, message.id);
      return;
    }

    console.log(`📥 [WhatsApp] ${senderId}: ${inbound.text}`);
    const chunks = await handler.handleInboundText({
      senderId,
      conversationId: senderId,
      dmConversationId: senderId,
      isGroup: false,
      text: inbound.text,
    });
    for (const chunk of chunks) {
      for (const outbound of renderWhatsappOutbound(chunk)) {
        await sendText(senderId, outbound.text, message.id);
      }
    }
  };

  const handleEvent = async (event: WhatsappEvent): Promise<void> => {
    if (event.type === "status") {
      if (event.status.status === "failed") {
        console.warn("⚠️ [WhatsApp] message status failed:", event.status);
      }
      await persistCursor(event.cursor);
      return;
    }

    const senderId = canonicalizeSenderId(event.message.from.trim());
    const previous = senderChains.get(senderId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        try {
          await Promise.race([
            handleMessage(event),
            sleep(MESSAGE_TIMEOUT_MS).then(() => {
              throw new Error(`WhatsApp message (${event.message.id}) timed out`);
            }),
          ]);
          await client.messages.markRead(event.message.id).catch(() => {});
          await persistCursor(event.cursor);
        } catch (error) {
          console.error("⚠️ [WhatsApp] message handling failed:", error);
          if (isNonRetryableWhatsappError(error)) {
            await persistCursor(event.cursor);
          }
        }
      });
    senderChains.set(senderId, next);
    void next.finally(() => {
      if (senderChains.get(senderId) === next) senderChains.delete(senderId);
    });
    await next;
  };

  const replayMissed = async (): Promise<void> => {
    if (!cursor) return;
    const { events } = await client.events.fetchMissed({
      cursor,
      limit: FETCH_MISSED_LIMIT,
    });
    for (const event of events as unknown as readonly WhatsappEvent[]) {
      await handleEvent(event);
    }
  };

  const runStream = async (): Promise<void> => {
    while (!shuttingDown) {
      try {
        await replayMissed();
        whatsappLiveness.markConnected();
        for await (const event of client.events.subscribe({ cursor: cursor ?? undefined }) as AsyncIterable<WhatsappEvent>) {
          await handleEvent(event);
        }
      } catch (error) {
        whatsappLiveness.markDisconnected();
        if (shuttingDown) return;
        console.error(`⚠️ [WhatsApp] event stream error: ${errorMessage(error)}`);
        await sleep(RECONNECT_DELAY_MS);
      }
    }
  };

  const stop = () => {
    shuttingDown = true;
    whatsappLiveness.markDisconnected();
    Promise.resolve(client.close())
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  void runStream().catch((error) => {
    console.error("❌ [WhatsApp] background stream failed:", error);
    process.exit(1);
  });
}
