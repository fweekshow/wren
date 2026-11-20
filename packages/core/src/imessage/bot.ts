import type { AdvancedIMessage } from "@photon-ai/advanced-imessage";
import { reaction, resolveContents, Spectrum, typing } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

import { config } from "@/config/config.js";
import { DiscoveryAI } from "@/discovery/ai.js";
import { db } from "@/discovery/db.js";
import { deliverDeferredRecipientClaim } from "@/messaging/deferredRecipientClaim.js";
import { createImessageHandler } from "@/messaging/handler.js";
import type { CreateMessagingHandlerOptions } from "@/messaging/handler.types.js";
import { isSpectrumSmsDm } from "@/messaging/smsConsent.js";
import {
  applySmsConsentInbound,
  spectrumOutboundDecision,
  type SpectrumOutboundPurpose,
} from "@/messaging/smsConsentGate.js";
import { canonicalizeSenderId } from "@/messaging/utils/senderId.utils.js";
import {
  portfolioReviewDelivery,
  PortfolioReviewPoller,
  PortfolioReviewWorker,
} from "@/portfolio-reviews/index.js";
import { priceAlertDelivery, PriceAlertPoller } from "@/price-alerts/index.js";
import { TxConfirmationPoller } from "@/tx-confirmations/poller.js";
import { logger } from "@/utils/logger.js";
import { EscrowReleasePoller } from "@/wallet/escrowReleasePoller.js";
import { EscrowRefundPoller } from "@/wallet/escrowRefundPoller.js";
import { WalletWelcomePoller } from "@/wallet/walletWelcomePoller.js";
import { registerFundingConfirmSender } from "@/wallet/fundingNotify.js";
import { registerWalletConnectNotifySender } from "@/wallet/walletConnectNotify.js";
import { offrampDelivery, OfframpStatusPoller } from "@/wallet/offrampPoller.js";
import type { PendingPayRow } from "@/wallet/pendingPay.js";
import { PendingPayConfirmationPoller } from "@/wallet/pendingPayConfirmationPoller.js";
import { FlashFillPoller } from "@/discovery/flash/fillPoller.js";

import { waitForImessageGrpc } from "./grpcReady.js";
import { isNonRetryableSendError, isTransientOutboundError } from "./outboundErrors.js";
import { acknowledgeInboundMessage } from "./acknowledgement.js";
import { applyImessageChatBackground } from "./chatBackgrounds.js";
import {
  isImessageMentioned,
  isReplyToOwnImessage,
  removeImessageMention,
} from "./groupEngagement.js";
import { resolveLiveGroupParticipants } from "./groupParticipants.js";
import { imessageLiveness } from "./liveness.js";
import {
  confettiTextOutbound,
  sendImessageOutbound,
  singleBubbleTextOutbound,
  stripMarkdown,
  type ImessageOutbound,
} from "./outbound.js";
import { WebhookDeliveryAdapter } from "./webhook.adapter.js";
import type { SpectrumWebhookContent, SpectrumWebhookPayload } from "./webhook.js";
import { maybeHandleSwearJar, SWEAR_JAR_ENABLED, type SwearJarSpace } from "@/swear-jar/index.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Max time to wait for a Spectrum connection before treating it as failed. */
const CONNECT_TIMEOUT_MS = 30_000;
/** Max time a single inbound message may take before we unblock that conversation. */
const MESSAGE_TIMEOUT_MS = 90_000;
/** Reconnect backoff bounds — exponential, reset on a successful connect. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/**
 * If the outbound transport can't be re-established within this window,
 * exit non-zero so Railway's ON_FAILURE policy hands us a clean container.
 */
const WATCHDOG_DISCONNECT_MS = 120_000;
/** Max time to let an outbound SDK call hang on a half-open gRPC connection. */
const OUTBOUND_CALL_TIMEOUT_MS = 20_000;
/** Attempt 1–2 stay on the live channel; the last attempt remints Spectrum. */
const OUTBOUND_SEND_ATTEMPTS = 3;
const OUTBOUND_RETRY_DELAY_MS = 750;
const REMINT_DELAY_MS = 1_000;
/** Spectrum() resolves before Photon's unary SendTextMessage channel is READY. */
const GRPC_READY_TIMEOUT_MS = 15_000;
/** How often the webhook processor polls for pending deliveries. */
const PROCESSOR_POLL_MS = 500;
/** How often stuck `processing` rows are recovered after a crash. */
const STUCK_RECOVERY_INTERVAL_MS = 60_000;
/** Rows in `processing` longer than this are reset to `pending` (see MESSAGE_TIMEOUT_MS). */
const STALE_PROCESSING_MS = MESSAGE_TIMEOUT_MS + 30_000;
// ── Type helpers ──────────────────────────────────────────────────────────────

// `imessage` is an overloaded callable — derive types from a concrete helper
// rather than generic instantiation, which resolves to the wrong overload.
const _connect = () =>
  Spectrum({
    projectId: config.spectrum.projectId,
    projectSecret: config.spectrum.projectSecret,
    providers: [imessage.config()],
  });

type SpectrumApp = Awaited<ReturnType<typeof _connect>>;
const _bindIm = (app: SpectrumApp) => imessage(app);
type ImessageApi = ReturnType<typeof _bindIm>;
type ImessageSpace = {
  send: (content: unknown) => Promise<unknown>;
  startTyping: () => Promise<void>;
  stopTyping: () => Promise<void>;
  responding: <T>(fn: () => Promise<T>) => Promise<T>;
  getMessage: (
    id: string,
  ) => Promise<{ react: (reaction: string) => Promise<unknown> } | undefined>;
};
type RemoteImessageClient = {
  phone: string;
  client: Pick<AdvancedIMessage, "messages"> &
    Partial<Pick<AdvancedIMessage, "chats">>;
};

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Is this a plausible iMessage user handle (E.164 phone or email)?
 * On a SHARED Photon number the sender handle is the only reliable per-user
 * identity — never use a chatGuid as a fallback.
 */
function isLikelyHandle(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!v || v.includes(";")) return false;
  return /^\+?[0-9]{6,15}$/.test(v) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
}

/** Resolve user handle when Spectrum omits message.sender.id on inbound DMs. */
function resolveInboundSenderId(payload: SpectrumWebhookPayload): string {
  const fromSender = canonicalizeSenderId(payload.message.sender?.id?.trim() ?? "");
  if (isLikelyHandle(fromSender)) return fromSender;

  const fromSpacePhone = canonicalizeSenderId(
    payload.space.phone?.trim() || payload.message.space.phone?.trim() || "",
  );
  if (isLikelyHandle(fromSpacePhone)) return fromSpacePhone;

  const spaceId = (payload.space.id || payload.message.space.id || "").trim();
  const dmMatch = /^any;-;(.+)$/i.exec(spaceId);
  if (dmMatch?.[1]) {
    const fromGuid = canonicalizeSenderId(dmMatch[1]);
    if (isLikelyHandle(fromGuid)) return fromGuid;
  }

  return fromSender;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeSpaceType(value: unknown): "dm" | "group" | undefined {
  if (value === "dm" || value === "group") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  if (normalized.includes("group")) return "group";
  if (normalized.includes("dm") || normalized.includes("direct")) return "dm";
  return undefined;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * iMessage transport — webhook-based inbound, spectrum-ts outbound.
 *
 * Inbound messages arrive via the Spectrum webhook HTTP route
 * (`/spectrum-webhook`), are stored in `imessage_webhook_deliveries`, and
 * dispatched through the shared DiscoveryAI handler.
 *
 * Outbound replies, proactive DMs, and typing indicators are sent through a
 * lazily-reconnecting `spectrum-ts` SDK connection. The connection is needed
 * only for outbound — Spectrum Cloud handles the inbound stream and pushes
 * events to the HTTP webhook endpoint.
 */
export async function startImessageBot(
  handlerOptions: CreateMessagingHandlerOptions = {},
): Promise<void> {
  if (!config.spectrum.projectId || !config.spectrum.projectSecret) {
    throw new Error(
      "PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET are required in .env to run the iMessage bot",
    );
  }

  // ── Outbound transport state (local to this invocation) ───────────────────
  //
  // All outbound helpers close over these locals so state is fully contained
  // within a single startImessageBot() call and cleaned up on shutdown.

  let currentApp: SpectrumApp | undefined;
  let im: ImessageApi | undefined;
  /** Pending connection attempt — prevents concurrent reconnects. */
  let connectionPromise: Promise<ImessageApi> | undefined;
  let remintPromise: Promise<void> | undefined;
  let connectBackoff = RECONNECT_BASE_MS;
  let shuttingDown = false;

  function connect(): Promise<SpectrumApp> {
    return withTimeout(_connect(), CONNECT_TIMEOUT_MS, "Spectrum connect");
  }

  /**
   * Consume `app.messages` so Photon's gRPC upstream stays alive for outbound
   * sends. Webhooks remain the primary inbound path, but stream deliveries are
   * enqueued as a fallback and deduped by message id.
   */
  function startMessageStreamPump(app: SpectrumApp): void {
    void (async () => {
      try {
        for await (const [space, message] of app.messages) {
          if (message.platform !== "iMessage" || message.direction !== "inbound") continue;

          const spaceId = message.space?.id ?? space.id;
          const spaceType = normalizeSpaceType(
            (message.space as any)?.type ?? (space as any)?.type,
          );
          const spacePhone =
            typeof (message.space as { phone?: string })?.phone === "string"
              ? (message.space as { phone: string }).phone
              : typeof (space as { phone?: string }).phone === "string"
                ? (space as { phone: string }).phone
                : undefined;
          const draftForSender: SpectrumWebhookPayload = {
            event: "messages",
            space: {
              id: spaceId,
              platform: message.platform,
              type: spaceType,
              phone: spacePhone,
              participants: (message.space as any)?.participants ?? (space as any)?.participants,
            },
            message: {
              id: message.id,
              platform: message.platform,
              direction: message.direction,
              timestamp: message.timestamp.toISOString(),
              sender: { id: message.sender?.id ?? "", platform: message.platform },
              space: {
                id: spaceId,
                platform: message.platform,
                type: spaceType,
                phone: spacePhone,
              },
              content: message.content as SpectrumWebhookContent,
            },
          };
          const senderId = resolveInboundSenderId(draftForSender);
          if (!isLikelyHandle(senderId)) continue;

          const payload: SpectrumWebhookPayload = {
            ...draftForSender,
            message: {
              ...draftForSender.message,
              sender: { id: senderId, platform: message.platform },
            },
          };

          try {
            const inserted = await WebhookDeliveryAdapter.insertIfNew({
              dedupeKey: `message:${message.id}`,
              webhookId: "stream",
              messageId: message.id,
              spaceId,
              senderId,
              payload,
            });
            if (inserted) {
              imessageLiveness.markActivity();
              logger.info(
                `[iMessage] stream queued inbound messageId=${message.id} sender=${senderId}`,
              );
            }
          } catch (err) {
            console.error("⚠️ [iMessage] failed to enqueue stream delivery:", err);
          }
        }
        if (!shuttingDown && currentApp === app) {
          console.warn("⚠️ [iMessage] Spectrum message stream ended");
          await dropConnection().catch(() => {});
        }
      } catch (err) {
        if (!shuttingDown && currentApp === app) {
          console.error("⚠️ [iMessage] Spectrum message stream ended:", err);
          await dropConnection().catch(() => {});
        }
      }
    })();
  }

  /** Ensure the outbound SDK is connected, reconnecting with backoff if needed. */
  async function ensureConnected(): Promise<ImessageApi> {
    if (im) return im;
    // Deduplicate concurrent callers: if a connect is already in flight,
    // share that promise rather than opening a second connection.
    if (connectionPromise) return connectionPromise;

    connectionPromise = connect()
      .then(async (app) => {
        currentApp = app;
        im = _bindIm(app);
        startMessageStreamPump(app);
        await waitForImessageGrpc(app, GRPC_READY_TIMEOUT_MS);
        connectBackoff = RECONNECT_BASE_MS;
        imessageLiveness.markConnected();
        const { reconnects } = imessageLiveness.snapshot();
        logger.info(
          reconnects > 0
            ? `📱 iMessage (Spectrum) outbound transport reconnected (#${reconnects})`
            : "📱 iMessage (Spectrum) outbound transport ready",
        );
        return im;
      })
      .finally(() => {
        connectionPromise = undefined;
      });

    return connectionPromise;
  }

  /** Tear down the current SDK connection so the next ensureConnected() reconnects. */
  async function dropConnection(): Promise<void> {
    im = undefined;
    imessageLiveness.markDisconnected();
    const app = currentApp;
    currentApp = undefined;
    try {
      await withTimeout(Promise.resolve(app?.stop()), 5_000, "Spectrum stop");
    } catch {
      // ignore cleanup errors
    }
  }

  /** Tear down a half-open unary gRPC channel once, then let ensureConnected remint. */
  async function remintConnection(): Promise<void> {
    if (remintPromise) return remintPromise;
    remintPromise = (async () => {
      await dropConnection();
      await new Promise<void>((resolve) => setTimeout(resolve, REMINT_DELAY_MS));
    })().finally(() => {
      remintPromise = undefined;
    });
    return remintPromise;
  }

  /**
   * Photon/gRPC connections can go half-open after sitting idle behind Railway's
   * networking layer. Bound each outbound SDK call so the queue can retry on a
   * fresh connection instead of waiting indefinitely on a stale channel.
   */
  async function outboundCall<T>(promise: Promise<T>, label: string): Promise<T> {
    return withTimeout(promise, OUTBOUND_CALL_TIMEOUT_MS, label);
  }

  /**
   * Open a DM with `senderId` via the live outbound transport.
   *
   * The spectrum-ts iMessage provider supports `im.space(user)` as a
   * shorthand for opening or looking up a 1:1 conversation by user object
   * (per the Photon webhook quickstart docs). The TypeScript types may only
   * expose `.create` / `.get` on `im.space`, so a targeted cast is used here
   * rather than propagating `as any` into every caller.
   */
  async function openDm(senderId: string) {
    const transport = await ensureConnected();
    const user = await outboundCall(
      transport.user(senderId.trim()),
      `Spectrum user lookup (${senderId})`,
    );

    const space = await outboundCall(
      (transport as any).space(user),
      `Spectrum DM open (${senderId})`,
    );
    return space as ImessageSpace;
  }

  /**
   * Bind a sendable Spectrum space to an existing chat GUID.
   *
   * spectrum-ts 1.x `space(string)` treats the argument as a phone/user id and
   * mangles chat GUIDs (`any;+;…` / `any;-;…`), which breaks group sends.
   * Newer builds expose `space.get(chatGuid)`; when that's missing we bind
   * directly through the iMessage platform runtime so replies stay in-group.
   */
  async function bindExistingChatSpace(
    spaceId: string,
    opts: { type: "dm" | "group"; phone?: string },
  ): Promise<ImessageSpace> {
    const transport = await ensureConnected();

    const spaceApi = transport as any;
    if (typeof spaceApi.space?.get === "function") {
      return (await outboundCall(
        spaceApi.space.get(spaceId),
        `Spectrum space.get (${spaceId})`,
      )) as ImessageSpace;
    }

    const runtime = (currentApp as any)?.__internal?.platforms?.get("iMessage") as
      | {
          client: unknown;
          config: unknown;
          store: unknown;
          definition: {
            send: (args: Record<string, unknown>) => Promise<unknown>;
            actions?: {
              getMessage?: (
                ctx: Record<string, unknown>,
                space: Record<string, unknown>,
                messageId: string,
              ) => Promise<unknown>;
            };
          };
        }
      | undefined;

    if (!runtime?.definition?.send) {
      throw new Error(
        `Cannot bind iMessage chat space "${spaceId}": Spectrum iMessage runtime unavailable`,
      );
    }

    const availablePhones = Array.isArray(runtime.client)
      ? runtime.client
          .map((entry) =>
            typeof entry === "object" &&
            entry !== null &&
            "phone" in entry &&
            typeof entry.phone === "string"
              ? entry.phone.trim()
              : "",
          )
          .filter(Boolean)
      : [];
    const requestedPhone = opts.phone?.trim();
    const routedPhone =
      requestedPhone && (requestedPhone !== "shared" || availablePhones.includes("shared"))
        ? requestedPhone
        : availablePhones.length === 1
          ? availablePhones[0]
          : undefined;

    if (!routedPhone) {
      throw new Error(
        `Cannot route iMessage chat "${spaceId}": webhook omitted its phone and ` +
          `connected lines are ${availablePhones.join(", ") || "<unknown>"}`,
      );
    }

    const spaceRef = {
      id: spaceId,
      type: opts.type,
      phone: routedPhone,
      __platform: "iMessage",
    };
    const baseCtx = {
      client: runtime.client,
      config: runtime.config,
      store: runtime.store,
    };
    const actionCtx = { ...baseCtx, space: spaceRef };

    const sendRaw = async (content: unknown): Promise<unknown> => {
      const items = await resolveContents([content as never]);
      let last: unknown;
      for (const item of items) {
        last = await runtime.definition.send({ ...actionCtx, content: item });
      }
      return last;
    };

    const space: ImessageSpace = {
      send: sendRaw,
      startTyping: async () => {
        await sendRaw(typing("start"));
      },
      stopTyping: async () => {
        await sendRaw(typing("stop"));
      },
      responding: async (fn) => {
        await space.startTyping().catch(() => {});
        try {
          return await fn();
        } finally {
          await space.stopTyping().catch(() => {});
        }
      },
      getMessage: async (id) => {
        const getMessage = runtime.definition.actions?.getMessage;
        if (!getMessage) return undefined;
        const raw = await getMessage(baseCtx, spaceRef, id);
        if (!raw) return undefined;
        return {
          react: async (emoji: string) => {
            await sendRaw(reaction(emoji, raw as never));
          },
        };
      },
    };
    return space;
  }

  async function openSpaceById(
    spaceId: string,
    opts?: { type?: "dm" | "group"; phone?: string },
  ): Promise<ImessageSpace> {
    const trimmed = spaceId.trim();
    const type =
      opts?.type ?? (trimmed.includes(";+;") ? "group" : trimmed.includes(";-;") ? "dm" : "group");

    // DM chat GUIDs are deterministic (`any;-;<handle>`). Prefer openDm so we
    // go through Spectrum's normal user→space path.
    const dmMatch = /^any;-;(.+)$/i.exec(trimmed);
    if (type === "dm" && dmMatch?.[1] && isLikelyHandle(dmMatch[1])) {
      return openDm(dmMatch[1]);
    }

    return bindExistingChatSpace(trimmed, { type, phone: opts?.phone });
  }

  function isGroupDelivery(payload: SpectrumWebhookPayload): boolean {
    const spaceType = (payload.space.type || payload.message.space.type || "").toLowerCase();
    const isGroup = spaceType.includes("group") || (payload.space.participants?.length ?? 0) > 2;
    if (isGroup) {
      logger.info(
        `👥 [iMessage] group delivery detected — space.type="${payload.space.type}" participants=${payload.space.participants?.length ?? "?"}`,
      );
    }
    return isGroup;
  }

  function deliverySpaceId(payload: SpectrumWebhookPayload): string {
    return payload.space.id || payload.message.space.id;
  }

  function deliveryPhone(payload: SpectrumWebhookPayload): string | undefined {
    return payload.space.phone || payload.message.space.phone;
  }

  function lowLevelClientForDelivery(
    payload: SpectrumWebhookPayload,
  ): RemoteImessageClient["client"] | undefined {
    const runtimeClient = currentApp?.__internal.platforms.get("iMessage")?.client;
    if (!Array.isArray(runtimeClient)) return undefined;

    const entries = runtimeClient.filter((entry): entry is RemoteImessageClient => {
      if (typeof entry !== "object" || entry === null) return false;
      const candidate = entry as Partial<RemoteImessageClient>;
      return (
        typeof candidate.phone === "string" && typeof candidate.client?.messages?.get === "function"
      );
    });
    if (entries.length === 1) return entries[0]?.client;

    const phone = payload.space.phone ?? payload.message.space.phone;
    return entries.find((entry) => entry.phone === phone)?.client;
  }

  async function isGroupReplyToBot(payload: SpectrumWebhookPayload): Promise<boolean> {
    const client = lowLevelClientForDelivery(payload);
    if (!client) return false;

    try {
      return await withTimeout(
        isReplyToOwnImessage(payload.message.id, (messageId) => client.messages.get(messageId)),
        OUTBOUND_CALL_TIMEOUT_MS,
        `iMessage reply lookup (${payload.message.id})`,
      );
    } catch (err) {
      console.warn(`⚠️ [iMessage] failed to inspect reply target for ${payload.message.id}:`, err);
      return false;
    }
  }

  async function openOriginatingSpace(
    payload: SpectrumWebhookPayload,
    fallbackDm: ImessageSpace,
  ): Promise<ImessageSpace> {
    const spaceId = deliverySpaceId(payload);
    if (!spaceId) return fallbackDm;
    try {
      return await openSpaceById(spaceId, {
        type: isGroupDelivery(payload) ? "group" : "dm",
        phone: deliveryPhone(payload),
      });
    } catch (err) {
      console.warn("⚠️ [iMessage] failed to open originating space for acknowledgement:", err);
      return fallbackDm;
    }
  }

  async function sendToSpace(
    initialSpace: ImessageSpace,
    content: unknown,
    reopenSpace?: () => Promise<ImessageSpace>,
  ): Promise<unknown> {
    if (typeof content === "string" && !content.trim()) return undefined;

    let space = initialSpace;
    for (let attempt = 1; attempt <= OUTBOUND_SEND_ATTEMPTS; attempt += 1) {
      try {
        if (currentApp) await waitForImessageGrpc(currentApp, GRPC_READY_TIMEOUT_MS);
        return await outboundCall(space.send(content), "Spectrum message send");
      } catch (err) {
        if (!reopenSpace || attempt >= OUTBOUND_SEND_ATTEMPTS || !isTransientOutboundError(err)) {
          throw err;
        }
        const remint = attempt >= OUTBOUND_SEND_ATTEMPTS - 1;
        console.warn(
          remint
            ? "⚠️ [iMessage] transient send failure — reminting Spectrum:"
            : "⚠️ [iMessage] transient send failure — retrying on the same transport:",
          err,
        );
        if (remint) await remintConnection();
        else await new Promise<void>((resolve) => setTimeout(resolve, OUTBOUND_RETRY_DELAY_MS));
        space = await reopenSpace();
      }
    }

    return undefined;
  }

  /**
   * Run `work` while showing a best-effort typing indicator.
   *
   * The typing calls go through Photon's gRPC ChatService, whose upstream link
   * to the iMessage agent can drop transiently ("[upstream] Connection
   * dropped"). Those failures are cosmetic and must NEVER abort the reply or
   * tear down the transport — otherwise a single failed SetTyping fails the
   * whole delivery, drops the connection, and the message is reprocessed in a
   * reconnect loop. Only the actual reply send inside `work` may surface a real
   * connection error.
   */
  async function runWithTyping<T>(space: ImessageSpace, work: () => Promise<T>): Promise<T> {
    void space.startTyping().catch(() => {});
    try {
      return await work();
    } finally {
      void space.stopTyping().catch(() => {});
    }
  }

  // ── Proactive sends ────────────────────────────────────────────────────────

  /**
   * Open (or reuse) a DM and send a post-trade notification.
   * Fire-and-forget — the caller must `.catch()`.
   */
  async function notifyRecipient(phone: string, message: string): Promise<void> {
    if (!isLikelyHandle(phone)) throw new Error(`refusing to notify invalid recipient: ${phone}`);
    const space = await openDm(phone);
    await sendImessageOutbound(
      (content) => sendToSpace(space, content, () => openDm(phone)),
      confettiTextOutbound(message),
    );
    logger.info(`📨 [iMessage] proactive recipient message handed to Spectrum for ${phone}`);
  }

  /**
   * Deliver a proactive (poller-driven) message to a user by their phone.
   * Re-opens the DM via the live transport — never a cached chatGuid lookup,
   * which can collide across users on a shared line.
   */
  async function deliverToUserPhone(
    phone: string | null | undefined,
    content: string,
    purpose: SpectrumOutboundPurpose = "other",
  ): Promise<boolean> {
    if (!isLikelyHandle(phone)) {
      console.warn("⚠️ [iMessage] skipping proactive delivery — no valid recipient handle");
      return false;
    }
    const decision = await spectrumOutboundDecision(phone, purpose);
    if (decision === "suppress") {
      logger.info(
        `📨 [iMessage] not sending ${purpose} to ${phone} — SMS consent is not opted in`,
      );
      return false;
    }
    try {
      const space = await openDm(phone);
      await sendImessageOutbound(
        (outboundContent) => sendToSpace(space, outboundContent, () => openDm(phone)),
        content,
      );
      return true;
    } catch (err) {
      console.error("⚠️ [iMessage] proactive delivery failed:", err);
      // Reset so the next attempt reconnects from scratch.
      await dropConnection().catch(() => {});
      return false;
    }
  }

  async function deliverPendingPay(row: PendingPayRow, content: string): Promise<boolean> {
    if (!row.isGroup || !row.conversationId) {
      return deliverToUserPhone(row.senderId, content, "payment_or_stock");
    }
    try {
      let space = await openSpaceById(row.conversationId, {
        type: "group",
        phone: row.deliveryPhone ?? undefined,
      });
      await sendImessageOutbound(
        (outboundContent) => sendToSpace(space, outboundContent, async () => {
          space = await openSpaceById(row.conversationId!, {
            type: "group",
            phone: row.deliveryPhone ?? undefined,
          });
          return space;
        }),
        content,
      );
      return true;
    } catch (err) {
      console.error("⚠️ [iMessage] pending-pay group delivery failed:", err);
      await dropConnection().catch(() => {});
      return false;
    }
  }

  // ── Webhook processor ──────────────────────────────────────────────────────
  //
  // Polls imessage_webhook_deliveries for pending rows, dispatches each through
  // createImessageHandler, and sends replies via the outbound SDK.
  //
  // Per-conversation serialisation is preserved via a spaceChains Map keyed on
  // space.id — exactly as in the previous stream-based architecture.

  const ai = new DiscoveryAI();
  const handler = createImessageHandler(ai, undefined, {
    ...handlerOptions,
    onProductModeDetected: (args) => {
      void Promise.resolve(handlerOptions.onProductModeDetected?.(args)).catch((err) =>
        console.warn("⚠️ [iMessage] product mode hook failed:", err),
      );
      if (args.conversationId !== args.senderId) return;
      void applyImessageChatBackground({
        senderId: args.senderId,
        mode: args.mode,
      });
    },
  });
  async function processDelivery(
    row: Awaited<ReturnType<typeof WebhookDeliveryAdapter.claimPending>>[number],
  ): Promise<void> {
    const payload = row.payload as SpectrumWebhookPayload;
    const message = payload.message;

    // Outbound echoes are filtered at the webhook route before being stored,
    // so this branch should never be reached.  It is kept as a belt-and-
    // suspenders guard in case a delivery was enqueued by an older code path.
    if (message.direction !== "inbound") {
      await WebhookDeliveryAdapter.markDone(row.id);
      return;
    }

    const senderId = resolveInboundSenderId(payload);
    if (!isLikelyHandle(senderId)) {
      console.warn(
        `⚠️ [iMessage] dropping delivery ${row.id} — invalid sender ` +
          `(raw sender=${JSON.stringify(message.sender?.id ?? null)} ` +
          `space.phone=${JSON.stringify(deliveryPhone(payload) ?? null)} space=${row.space_id})`,
      );
      await WebhookDeliveryAdapter.markDone(row.id);
      return;
    }

    const content: SpectrumWebhookContent = message.content;
    const isGroup = isGroupDelivery(payload);
    const originConversationId = deliverySpaceId(payload);
    if (isGroup && !originConversationId) {
      console.warn(`⚠️ [iMessage] dropping group delivery ${row.id} — missing group space id`);
      await WebhookDeliveryAdapter.markDone(row.id);
      return;
    }
    const conversationId = isGroup ? originConversationId : senderId;
    const dmSpace = await openDm(senderId);
    const groupPhone = deliveryPhone(payload);
    const originSpace = isGroup
      ? await openSpaceById(conversationId, { type: "group", phone: groupPhone })
      : await openOriginatingSpace(payload, dmSpace);
    // DMs reply via openDm(sender). Groups must use the inbound chat GUID so
    // acknowledgements AND text replies land in the same group thread.
    let replySpace = isGroup ? originSpace : dmSpace;
    const reopenReplySpace = async (): Promise<ImessageSpace> => {
      replySpace = isGroup
        ? await openSpaceById(conversationId, { type: "group", phone: groupPhone })
        : await openDm(senderId);
      return replySpace;
    };
    const sendToReplySpace = (outboundContent: unknown): Promise<unknown> =>
      sendToSpace(replySpace, outboundContent, reopenReplySpace);

    if (content.type === "contact") {
      if (isGroup) {
        await WebhookDeliveryAdapter.markDone(row.id);
        return;
      }
      if (isSpectrumSmsDm(false, message.platform)) {
        await WebhookDeliveryAdapter.markDone(row.id);
        return;
      }
      if (message.platform === "iMessage") {
        void acknowledgeInboundMessage(originSpace, message.id, outboundCall);
      }
      // Narrow to the contact arm — Extract<> is needed because the fallback
      // `{ type: string }` arm is broader than the literal discriminant.
      const c = content as Extract<SpectrumWebhookContent, { type: "contact" }>;
      const displayName =
        c.name?.formatted ?? ([c.name?.first, c.name?.last].filter(Boolean).join(" ") || undefined);
      const phone = c.phones?.[0]?.value ?? undefined;
      logger.info(`📇 [iMessage] ${senderId}: contact card — ${displayName ?? phone ?? "unknown"}`);
      await runWithTyping(replySpace, async () => {
        const reply = await handler.handleInboundContact({ senderId, name: displayName, phone });
        await sendImessageOutbound(sendToReplySpace, reply);
      });
      await WebhookDeliveryAdapter.markDone(row.id);
      return;
    }

    if (content.type !== "text") {
      if (isSpectrumSmsDm(isGroup, message.platform)) {
        await WebhookDeliveryAdapter.markDone(row.id);
        return;
      }
      // Attachments, voice memos, reactions, etc. — acknowledge and drop.
      // The handler only processes text and contacts.
      if (!isGroup && message.platform === "iMessage") {
        void acknowledgeInboundMessage(originSpace, message.id, outboundCall);
      }
      await WebhookDeliveryAdapter.markDone(row.id);
      return;
    }

    let text = (content as Extract<SpectrumWebhookContent, { type: "text" }>).text?.trim();
    if (!text) {
      await WebhookDeliveryAdapter.markDone(row.id);
      return;
    }

    // Alexander swear jar — opt-in early return before the group mention gate.
    if (SWEAR_JAR_ENABLED && isGroup) {
      const lowLevel = lowLevelClientForDelivery(payload);
      const rosterClient = lowLevel?.chats
        ? { chats: lowLevel.chats, messages: lowLevel.messages }
        : undefined;
      const groupParticipants = await resolveLiveGroupParticipants({
        client: rosterClient,
        spaceId: conversationId,
        senderId,
        messageId: message.id,
        seed: payload.space.participants,
      });
      try {
        const handled = await maybeHandleSwearJar({
          isGroup: true,
          conversationId,
          senderId,
          messageId: message.id,
          text,
          space: originSpace as SwearJarSpace,
          send: sendToReplySpace,
          participants: groupParticipants,
        });
        if (handled) {
          await WebhookDeliveryAdapter.markDone(row.id);
          return;
        }
      } catch (err) {
        logger.warn(
          { err, conversationId, senderId },
          "[iMessage] swear-jar handler failed; falling through",
        );
      }
    }

    if (isGroup) {
      const mentioned = isImessageMentioned(text);
      const repliesToBot = mentioned ? false : await isGroupReplyToBot(payload);
      if (!mentioned && !repliesToBot) {
        logger.info(`↩️ [iMessage] ignoring unmentioned group message from ${senderId}`);
        await WebhookDeliveryAdapter.markDone(row.id);
        return;
      }
      if (mentioned) {
        text = removeImessageMention(text);
      }
      if (!text) {
        await WebhookDeliveryAdapter.markDone(row.id);
        return;
      }
    }

    if (message.platform === "iMessage") {
      void acknowledgeInboundMessage(originSpace, message.id, outboundCall);
    }
    logger.info(`📥 [iMessage] ${senderId}: ${text}`);

    // SMS DMs never enter the agent. The only replies are the opt-in script.
    if (isSpectrumSmsDm(isGroup, message.platform)) {
      const outcome = await applySmsConsentInbound(senderId, text);
      if (outcome.reply) {
        await sendImessageOutbound(sendToReplySpace, singleBubbleTextOutbound(outcome.reply));
      }
      await WebhookDeliveryAdapter.markDone(row.id);
      return;
    }

    // A proactive transfer notice intentionally has no URL because iMessage
    // disables links from unknown senders. Once the recipient has spoken to
    // Basemate, send one fresh claim link privately before handling their text.
    let deferredClaimSent = false;
    try {
      deferredClaimSent =
        (await deliverDeferredRecipientClaim(senderId, (phone, message) =>
          deliverToUserPhone(phone, message, "payment_or_stock"),
        )) === "sent";
    } catch (err) {
      logger.warn(
        `⚠️ [iMessage] deferred claim delivery failed for ${senderId}: ` +
          `${(err as Error)?.message || err}`,
      );
    }

    await runWithTyping(replySpace, async () => {
      // Spectrum webhooks omit space.participants — fetch the live roster so
      // group sends can resolve members by name / @mention / saved contact.
      const lowLevel = lowLevelClientForDelivery(payload);
      const rosterClient = lowLevel?.chats
        ? { chats: lowLevel.chats, messages: lowLevel.messages }
        : undefined;
      const groupParticipants = isGroup
        ? await resolveLiveGroupParticipants({
            client: rosterClient,
            spaceId: conversationId,
            senderId,
            messageId: message.id,
            seed: payload.space.participants,
          })
        : undefined;
      if (isGroup) {
        logger.info(
          `👥 [iMessage] group roster for send resolution: ${groupParticipants?.length ?? 0} member(s)`,
        );
      }
      // In a DM, a freshly delivered claim is the onboarding response for this
      // inbound message. Running the no-wallet gate as well would send the same
      // connect link twice. Group messages still continue through the handler.
      const chunks =
        deferredClaimSent && !isGroup
          ? []
          : await handler.handleInboundText({
              senderId,
              // DMs are keyed by sender handle because shared-line chatGuids can
              // collide; groups use the originating space so group flows stay scoped.
              conversationId,
              dmConversationId: senderId,
              isGroup,
              deliveryPhone: groupPhone,
              groupParticipants,
              text,
            });
      for (const chunk of chunks) {
        if (typeof chunk === "string" && !chunk.trim()) continue;
        try {
          if (typeof chunk !== "string" && chunk.kind === "dm") {
            const ok = await deliverToUserPhone(chunk.phone, chunk.text);
            if (!ok) {
              console.warn(`⚠️ [iMessage] failed to DM ${chunk.phone} after group reply`);
            }
            continue;
          }
          await sendImessageOutbound(sendToReplySpace, chunk);
        } catch (err) {
          if (typeof chunk !== "string" && chunk.kind === "portfolio_link") {
            console.warn("⚠️ [iMessage] skipping optional portfolio link send:", err);
            continue;
          }
          throw err;
        }
      }
    });

    await WebhookDeliveryAdapter.markDone(row.id);
  }

  // ── Setup ──────────────────────────────────────────────────────────────────

  // Pollers are intentionally disabled when DISABLE_POLLERS=true so that
  // horizontally-scaled bot replicas don't each run their own copy — the
  // imessagePollerWorker service (single instance) owns them instead.
  const DISABLE_POLLERS =
    process.env.DISABLE_POLLERS === "true" || process.env.DISABLE_POLLERS === "1";

  if (!DISABLE_POLLERS) {
    // Proactive deliveries use the live outbound transport.
    priceAlertDelivery.register("imessage", async (alert, message) =>
      deliverToUserPhone(alert.user_key, message),
    );
    new PriceAlertPoller({}, "imessage").start();

    new TxConfirmationPoller({
      deliver: (row, message) => deliverToUserPhone(row.sender_id, message, "payment_or_stock"),
      deliverRecipient: async (phone, message) => {
        await notifyRecipient(phone, message);
        return true;
      },
    }).start();

    // Confirm transactions signed on the self-hosted Basemate Pay page.
    new PendingPayConfirmationPoller({
      deliver: deliverPendingPay,
      deliverDm: (phone, message) => deliverToUserPhone(phone, message, "payment_or_stock"),
    }).start();

    // Write Flash fills into the app Activity feed (tx_confirmations).
    new FlashFillPoller().start();

    // Release phone-escrow deposits once the recipient has a connected Base
    // Account — covers deposits made after they connected, which the one-shot
    // release at connect time misses.
    new EscrowReleasePoller({
      deliver: (phone, message) => deliverToUserPhone(phone, message, "payment_or_stock"),
    }).start();
    // Return unclaimed phone-escrow deposits to the sender after 72h.
    new EscrowRefundPoller({
      deliver: (senderId, message) => deliverToUserPhone(senderId, message, "payment_or_stock"),
    }).start();
    // Proactive first-run welcome DM once a user finishes web signup.
    new WalletWelcomePoller({
      deliver: (phone, message) => deliverToUserPhone(phone, message),
    }).start();
    offrampDelivery.register("imessage", (session, message) =>
      deliverToUserPhone(session.userKey, message),
    );
    new OfframpStatusPoller("imessage").start();

    // Confirm onramp deposits in chat: the dashboard's Apple Pay success calls
    // /api/app/record-funding, which hands the confirmation DM back to here.
    registerFundingConfirmSender((phone, message) =>
      deliverToUserPhone(phone, message, "payment_or_stock"),
    );
    registerWalletConnectNotifySender((phone, message) => deliverToUserPhone(phone, message));

    portfolioReviewDelivery.register("imessage", async (subscription, message) =>
      deliverToUserPhone(subscription.user_key, stripMarkdown(message)),
    );
    new PortfolioReviewPoller("imessage").start();
    new PortfolioReviewWorker("imessage").start();
  } else {
    logger.info("📴 [iMessage] pollers disabled (DISABLE_POLLERS=true) — handled by poller worker");
  }

  // Establish the initial outbound connection before the HTTP server starts
  // accepting webhooks. If this fails, let the process exit so the platform
  // does not expose a bot that can receive messages but cannot reply yet.
  await ensureConnected();

  try {
    const recovered = await WebhookDeliveryAdapter.recoverStuck(STALE_PROCESSING_MS);
    if (recovered > 0) {
      logger.info(`🔄 [iMessage] startup recovered ${recovered} stuck webhook delivery(ies)`);
    }
  } catch (err) {
    console.error("⚠️ [iMessage] startup stuck recovery error:", err);
  }

  const stop = () => {
    shuttingDown = true;
    dropConnection()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Watchdog: if the outbound transport can't be recovered within the window,
  // exit non-zero so Railway restarts the container with a clean state.
  const watchdog = setInterval(() => {
    if (!shuttingDown && imessageLiveness.disconnectedFor() > WATCHDOG_DISCONNECT_MS) {
      console.error(
        `❌ [iMessage] outbound transport down for >${Math.round(WATCHDOG_DISCONNECT_MS / 1000)}s — exiting for a clean restart`,
      );
      process.exit(1);
    }
  }, 15_000);
  watchdog.unref?.();

  // Periodic crash recovery: reset `processing` rows that were claimed but
  // never completed (e.g. the process was killed mid-handler).
  const stuckRecovery = setInterval(async () => {
    try {
      const n = await WebhookDeliveryAdapter.recoverStuck(STALE_PROCESSING_MS);
      if (n > 0) logger.info(`🔄 [iMessage] recovered ${n} stuck deliveries`);
    } catch (err) {
      console.error("⚠️ [iMessage] stuck recovery error:", err);
    }
  }, STUCK_RECOVERY_INTERVAL_MS);
  stuckRecovery.unref?.();

  // ── LISTEN/NOTIFY wakeup ──────────────────────────────────────────────────
  // When the webhook HTTP handler inserts a new row it fires
  // `NOTIFY imessage_webhook`. The listenLoop below receives that notification
  // and resolves any pending `waitForWakeupOrTimeout` call immediately, so the
  // processor picks up the row with ~0 ms latency instead of waiting up to
  // PROCESSOR_POLL_MS. The 500 ms timeout is kept as a safety-net fallback.

  let pendingWakeup: (() => void) | null = null;

  function wakeupProcessor(): void {
    const resolve = pendingWakeup;
    pendingWakeup = null;
    resolve?.();
  }

  function waitForWakeupOrTimeout(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        pendingWakeup = null;
        resolve();
      }, ms);
      pendingWakeup = () => {
        clearTimeout(timer);
        pendingWakeup = null;
        resolve();
      };
    });
  }

  // ── Background loops ───────────────────────────────────────────────────────

  // Holds a dedicated pg connection for LISTEN. Reconnects on error with
  // exponential back-off. Non-fatal: the processor falls back to polling.
  const listenLoop = async (): Promise<void> => {
    let backoff = 1_000;
    while (!shuttingDown) {
      let client: import("pg").PoolClient | null = null;
      try {
        client = await db.connect();
        await client.query("LISTEN imessage_webhook");
        backoff = 1_000; // reset on successful connect
        client.on("notification", () => {
          if (!shuttingDown) wakeupProcessor();
        });
        // Keep the connection alive until it errors or we shut down.
        await new Promise<void>((_resolve, reject) => {
          if (!client) return reject(new Error("no client"));
          client.once("error", reject);
          // Poll for shuttingDown so we can exit the loop cleanly.
          const shutdownPoll = setInterval(() => {
            if (shuttingDown) {
              clearInterval(shutdownPoll);
              _resolve();
            }
          }, 2_000);
          shutdownPoll.unref?.();
        });
      } catch (err) {
        if (!shuttingDown) {
          console.warn(
            `⚠️ [iMessage] LISTEN connection lost (${errorMessage(err)}); retrying in ${backoff}ms`,
          );
        }
      } finally {
        try {
          client?.release();
        } catch {
          /* ignore */
        }
        client = null;
      }
      if (!shuttingDown) {
        await new Promise<void>((resolve) => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  };

  // Polls imessage_webhook_deliveries and dispatches pending rows.
  //
  // Per-space ordering is enforced at the DB level by `claimPending`:
  //  - It returns at most one row per space_id (DISTINCT ON).
  //  - It skips spaces that already have a row in `processing`.
  // This means rows for different spaces are dispatched concurrently (good),
  // and rows within the same space are never dispatched out of order (correct).
  // The in-memory spaceChains Map is no longer needed.
  //
  // Wakes immediately on LISTEN notification; falls back to PROCESSOR_POLL_MS.
  const processorLoop = async (): Promise<void> => {
    while (!shuttingDown) {
      try {
        const rows = await WebhookDeliveryAdapter.claimPending(10);

        if (rows.length > 0) {
          logger.info(
            `[iMessage] processing ${rows.length} webhook delivery(ies): ${rows.map((r) => `#${r.id}:${r.space_id}`).join(", ")}`,
          );
        }

        for (const row of rows) {
          const spaceId = row.space_id;
          // Fire-and-forget: each row dispatches independently. Per-space
          // ordering is guaranteed by claimPending's NOT EXISTS guard.
          void withTimeout(
            processDelivery(row).catch(async (err) => {
              console.error("⚠️ [iMessage] delivery processing failed:", err);
              try {
                if (isNonRetryableSendError(err)) {
                  await WebhookDeliveryAdapter.markDone(row.id);
                  return;
                }
                await WebhookDeliveryAdapter.markFailed(row.id, errorMessage(err));
                if (isTransientOutboundError(err)) {
                  console.warn("⚠️ [iMessage] reminting Spectrum after failed delivery");
                  await remintConnection().catch(() => {});
                }
              } catch {
                // ignore secondary failures
              }
            }),
            MESSAGE_TIMEOUT_MS,
            `iMessage delivery (${spaceId})`,
          ).catch(async (err) => {
            console.error("⚠️ [iMessage] delivery dispatch errored:", err);
            // The delivery exceeded MESSAGE_TIMEOUT_MS — the handler is hung
            // (usually a stalled outbound send on a flaky upstream). withTimeout
            // cannot cancel the underlying promise, but we MUST release the
            // `processing` lock now: otherwise this row blocks every later
            // message for the same space until recoverStuck runs minutes later.
            // Mark it failed so the queue drains on the next poll; the bounded
            // attempts counter still caps retries.
            try {
              await WebhookDeliveryAdapter.markFailed(row.id, errorMessage(err));
              await dropConnection().catch(() => {});
            } catch {
              // ignore secondary failures
            }
          });
        }

        // Idle: wake immediately via LISTEN notification or after the fallback
        // poll interval — whichever comes first.
        if (rows.length === 0) {
          await waitForWakeupOrTimeout(PROCESSOR_POLL_MS);
        }
      } catch (err) {
        if (!shuttingDown) console.error("⚠️ [iMessage] processor poll error:", err);
        await new Promise<void>((resolve) => setTimeout(resolve, PROCESSOR_POLL_MS * 10));
      }
    }
  };

  // Keeps the SDK connection alive; reconnects independently of the processor
  // so a slow delivery doesn't delay reconnects.
  const reconnectLoop = async (): Promise<void> => {
    while (!shuttingDown) {
      if (!im) {
        try {
          await ensureConnected();
        } catch (err) {
          if (!shuttingDown) console.error("⚠️ [iMessage] outbound reconnect failed:", err);
          await new Promise<void>((resolve) => setTimeout(resolve, connectBackoff));
          connectBackoff = Math.min(connectBackoff * 2, RECONNECT_MAX_MS);
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    }
  };

  void Promise.all([processorLoop(), reconnectLoop(), listenLoop()])
    .catch((err) => {
      if (!shuttingDown) {
        console.error("❌ [iMessage] background loop failed:", err);
        process.exit(1);
      }
    })
    .finally(() => {
      clearInterval(watchdog);
      clearInterval(stuckRecovery);
    });
}

/**
 * Standalone poller worker — establishes its own Spectrum outbound connection
 * and runs the proactive-delivery pollers (PriceAlert, TxConfirmation,
 * EscrowRelease, OfframpStatus, PortfolioReview).
 *
 * Deploy as a single-instance Railway service.  Set `DISABLE_POLLERS=true` on
 * the main bot so horizontally-scaled replicas do not each run their own copy.
 *
 * The worker only needs the outbound (send) direction of the Spectrum
 * connection — it receives no inbound messages and runs no webhook processor.
 */
export async function startImessagePollerWorker(): Promise<void> {
  if (!config.spectrum.projectId || !config.spectrum.projectSecret) {
    throw new Error(
      "PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET are required to run the iMessage poller worker",
    );
  }

  let currentApp: SpectrumApp | undefined;
  let im: ImessageApi | undefined;
  let connectionPromise: Promise<ImessageApi> | undefined;
  let connectBackoff = RECONNECT_BASE_MS;
  let shuttingDown = false;

  function connectWorker(): Promise<SpectrumApp> {
    return withTimeout(_connect(), CONNECT_TIMEOUT_MS, "Spectrum connect (poller worker)");
  }

  async function ensureWorkerConnected(): Promise<ImessageApi> {
    if (im) return im;
    if (connectionPromise) return connectionPromise;
    connectionPromise = connectWorker()
      .then(async (app) => {
        currentApp = app;
        im = _bindIm(app);
        await waitForImessageGrpc(app, GRPC_READY_TIMEOUT_MS);
        connectBackoff = RECONNECT_BASE_MS;
        logger.info("📱 [iMessage poller worker] Spectrum outbound transport ready");
        return im;
      })
      .finally(() => {
        connectionPromise = undefined;
      });
    return connectionPromise;
  }

  async function dropWorkerConnection(): Promise<void> {
    im = undefined;
    const app = currentApp;
    currentApp = undefined;
    try {
      await withTimeout(Promise.resolve(app?.stop()), 5_000, "Spectrum stop (poller worker)");
    } catch {
      // ignore cleanup errors
    }
  }

  async function openDmWorker(phone: string): Promise<ImessageSpace> {
    const imApi = await ensureWorkerConnected();
    const user = await outboundCallWorker(
      imApi.user(phone.trim()),
      `Spectrum user lookup (poller worker, ${phone})`,
    );

    const space = await outboundCallWorker(
      (imApi as any).space(user),
      `Spectrum DM open (poller worker, ${phone})`,
    );
    return space as ImessageSpace;
  }

  async function deliverToPhone(
    phone: string | null | undefined,
    content: string,
    purpose: SpectrumOutboundPurpose = "other",
  ): Promise<boolean> {
    if (!isLikelyHandle(phone)) {
      console.warn("⚠️ [iMessage poller worker] skipping delivery — no valid handle");
      return false;
    }
    const decision = await spectrumOutboundDecision(phone, purpose);
    if (decision === "suppress") {
      logger.info(
        `📨 [iMessage poller worker] not sending ${purpose} to ${phone} — SMS consent is not opted in`,
      );
      return false;
    }
    try {
      const space = await openDmWorker(phone);
      await sendImessageOutbound(
        (outboundContent) =>
          outboundCallWorker(space.send(outboundContent), `send (poller worker, ${phone})`),
        content,
      );
      return true;
    } catch (err) {
      console.error("⚠️ [iMessage poller worker] delivery failed:", err);
      await dropWorkerConnection().catch(() => {});
      return false;
    }
  }

  async function deliverPendingPayWorker(row: PendingPayRow, content: string): Promise<boolean> {
    if (!row.isGroup || !row.conversationId) {
      return deliverToPhone(row.senderId, content, "payment_or_stock");
    }
    try {
      const imApi = await ensureWorkerConnected();

      const spaceApi = (imApi as any).space;
      if (typeof spaceApi?.get !== "function") {
        throw new Error("Spectrum space.get is unavailable for group delivery");
      }
      const space = (await outboundCallWorker(
        spaceApi.get(row.conversationId),
        `Spectrum group open (poller worker, ${row.conversationId})`,
      )) as ImessageSpace;
      await sendImessageOutbound(
        (outboundContent) =>
          outboundCallWorker(
            space.send(outboundContent),
            `send group (poller worker, ${row.conversationId})`,
          ),
        content,
      );
      return true;
    } catch (err) {
      console.error("⚠️ [iMessage poller worker] pending-pay group delivery failed:", err);
      await dropWorkerConnection().catch(() => {});
      return false;
    }
  }

  async function outboundCallWorker<T>(promise: Promise<T>, label: string): Promise<T> {
    try {
      return await withTimeout(promise, OUTBOUND_CALL_TIMEOUT_MS, label);
    } catch (err) {
      await dropWorkerConnection().catch(() => {});
      throw err;
    }
  }

  // Establish initial connection.
  await ensureWorkerConnected();

  // ── Register deliveries and start pollers ───────────────────────────────

  priceAlertDelivery.register("imessage", async (alert, message) =>
    deliverToPhone(alert.user_key, message),
  );
  offrampDelivery.register("imessage", (session, message) =>
    deliverToPhone(session.userKey, message),
  );

  const useBullMq = Boolean(config.redisUrl);

  if (useBullMq) {
    // BullMQ mode — distributed locks prevent duplicate delivery across replicas.
    await new PriceAlertPoller({}, "imessage").startBullMq();

    await new TxConfirmationPoller({
      deliver: (row, message) => deliverToPhone(row.sender_id, message, "payment_or_stock"),
      deliverRecipient: (phone, message) => deliverToPhone(phone, message, "payment_or_stock"),
    }).startBullMq();

    await new PendingPayConfirmationPoller({
      deliver: deliverPendingPayWorker,
      deliverDm: (phone, message) => deliverToPhone(phone, message, "payment_or_stock"),
    }).startBullMq();

    await new FlashFillPoller().startBullMq();

    await new EscrowReleasePoller({
      deliver: (phone, message) => deliverToPhone(phone, message, "payment_or_stock"),
    }).startBullMq();
    await new EscrowRefundPoller({
      deliver: (senderId, message) => deliverToPhone(senderId, message, "payment_or_stock"),
    }).startBullMq();
    await new WalletWelcomePoller({
      deliver: (phone, message) => deliverToPhone(phone, message),
    }).startBullMq();
    await new OfframpStatusPoller("imessage").startBullMq();

    portfolioReviewDelivery.register("imessage", async (subscription, message) =>
      deliverToPhone(subscription.user_key, stripMarkdown(message)),
    );
    await new PortfolioReviewPoller("imessage").startBullMq();
    new PortfolioReviewWorker("imessage").start();
  } else {
    // Fallback: bare setInterval (dev / environments without Redis).
    logger.warn("⚠️ REDIS_URL not set — pollers running with setInterval (not distributed-safe)");

    new PriceAlertPoller({}, "imessage").start();

    new TxConfirmationPoller({
      deliver: (row, message) => deliverToPhone(row.sender_id, message, "payment_or_stock"),
      deliverRecipient: (phone, message) => deliverToPhone(phone, message, "payment_or_stock"),
    }).start();

    new PendingPayConfirmationPoller({
      deliver: deliverPendingPayWorker,
      deliverDm: (phone, message) => deliverToPhone(phone, message, "payment_or_stock"),
    }).start();

    new FlashFillPoller().start();

    new EscrowReleasePoller({
      deliver: (phone, message) => deliverToPhone(phone, message, "payment_or_stock"),
    }).start();
    new EscrowRefundPoller({
      deliver: (senderId, message) => deliverToPhone(senderId, message, "payment_or_stock"),
    }).start();
    new WalletWelcomePoller({
      deliver: (phone, message) => deliverToPhone(phone, message),
    }).start();
    new OfframpStatusPoller("imessage").start();

    portfolioReviewDelivery.register("imessage", async (subscription, message) =>
      deliverToPhone(subscription.user_key, stripMarkdown(message)),
    );
    new PortfolioReviewPoller("imessage").start();
    new PortfolioReviewWorker("imessage").start();
  }

  logger.info("✅ [iMessage poller worker] all pollers started");

  const stop = () => {
    shuttingDown = true;
    dropWorkerConnection()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Keep the Spectrum connection alive.
  while (!shuttingDown) {
    if (!im) {
      try {
        await ensureWorkerConnected();
      } catch (err) {
        if (!shuttingDown) {
          console.error("⚠️ [iMessage poller worker] reconnect failed:", err);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, connectBackoff));
        connectBackoff = Math.min(connectBackoff * 2, RECONNECT_MAX_MS);
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
  }
}
