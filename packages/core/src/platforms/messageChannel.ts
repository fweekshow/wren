/**
 * MessageChannel — platform-agnostic interface for inbound message handling.
 *
 * Both the iMessage/WhatsApp handler (`createImessageHandler`) and the XMTP
 * `DiscoveryPlugin` implement this shape. Callers depend on this interface
 * rather than on concrete transport types, making it straightforward to add
 * new channels (Telegram, Farcaster, etc.) without touching shared logic.
 *
 * Design decisions:
 *  - Outbound is `string[]` — each string is a message segment to be sent in
 *    sequence. Multi-part replies (text + image URL) are expressed as separate
 *    strings rather than a composite type so every channel can decide how to
 *    transmit them (single message vs. multiple messages).
 *  - `hasPendingInteraction` is async because the state is now Redis-backed.
 *  - Contact handling is iMessage-specific; XMTP channels may return early.
 */

export type ChannelPlatform = "imessage" | "whatsapp" | "xmtp" | "telegram";

/**
 * Inbound message params shared by all channels.
 * Channel-specific metadata (e.g. `isGroup`, `dmConversationId`) extends this.
 */
export interface InboundMessageParams {
  /** Stable sender identifier (phone number, XMTP inboxId, etc.). */
  senderId: string;
  /** Channel-scoped conversation/space identifier. */
  conversationId: string;
  /** Raw text content of the message. */
  text: string;
  /** Whether the message arrived in a group/multi-party conversation. */
  isGroup?: boolean;
}

/**
 * Core channel contract implemented by every messaging transport.
 *
 * iMessage/WhatsApp: fulfilled by `ImessageHandler` (`createImessageHandler`).
 * XMTP:             fulfilled by `DiscoveryPlugin.onText` entry point.
 */
export interface MessageChannel {
  /** Handle an inbound text message; returns ordered reply segments. */
  handleInboundText(params: InboundMessageParams): Promise<string[]>;

  /**
   * Returns `true` when an active multi-step flow (confirm, OTP, wizard, etc.)
   * is waiting on a reply from this sender in this conversation. Used to
   * suppress mention-gate checks in group channels.
   */
  hasPendingInteraction(params: {
    senderId: string;
    conversationId: string;
  }): Promise<boolean>;
}

/**
 * Optional extension for channels that handle contact/phone-number sharing
 * (iMessage only today; XMTP does not surface contact cards).
 */
export interface ContactAwareChannel extends MessageChannel {
  handleInboundContact(params: {
    senderId: string;
    name?: string;
    phone?: string;
  }): Promise<string>;
}
