import { MessageContext } from "@xmtp/agent-sdk";
import { ContentTypeMarkdown } from "@xmtp/content-type-markdown";
import { ContentTypeReaction, Reaction } from "@xmtp/content-type-reaction";

import { config } from "@/config/config.js";
import { rememberAgentMessage } from "./agentOutboundMessages.js";
import { sanitizeXmptMarkdown } from "./markdownSanitize.js";

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ETHEREUM_KIND = 0; // IdentifierKind.Ethereum from @xmtp/node-bindings

// In-memory cache: inboxId → resolved Ethereum address.
// Avoids a network round-trip on every message for returning users.
const walletAddressCache = new Map<string, string>();

/**
 * Resolve the Ethereum wallet address of the message sender.
 *
 * Strategy (each step falls through on failure):
 *  1. ctx.getSenderAddress() — SDK convenience method (cached, fast)
 *  2. client.preferences.inboxStateFromInboxIds with refreshFromNetwork=true
 *     — forces a network lookup, filters explicitly for Ethereum identifiers
 *  3. conversation.members() — group member list fallback (works without network)
 */
export async function resolveSenderWalletAddress(ctx: MessageContext<any>): Promise<string | null> {
  const senderInboxId: string | undefined = ctx.message?.senderInboxId;

  // Fast path: return cached address for returning users (no network call)
  if (senderInboxId && walletAddressCache.has(senderInboxId)) {
    return walletAddressCache.get(senderInboxId)!;
  }

  const cache = (addr: string): string => {
    if (senderInboxId) walletAddressCache.set(senderInboxId, addr);
    return addr;
  };

  // 1 — Use the typed SDK method (internally calls inboxStateFromInboxIds, cached locally)
  try {
    const addr = await ctx.getSenderAddress();
    if (addr && ETH_ADDRESS_RE.test(addr)) return cache(addr);
  } catch {
    // fall through
  }

  // 2 — Re-query with refreshFromNetwork=true and filter for Ethereum kind explicitly.
  //     Only reached for first-time senders whose identity isn't in the local SQLite cache.
  if (senderInboxId) {
    try {
      const states = await ctx.client.preferences.inboxStateFromInboxIds(
        [senderInboxId],
        true, // refreshFromNetwork
      );
      const ethId = states[0]?.identifiers?.find(
        (id: { identifierKind: number; identifier: string }) =>
          id.identifierKind === ETHEREUM_KIND && ETH_ADDRESS_RE.test(id.identifier),
      );
      if (ethId?.identifier) return cache(ethId.identifier);
    } catch {
      // fall through
    }
  }

  // 3 — Fallback: scan conversation members list (no extra network call, works for groups & DMs)
  if (senderInboxId) {
    try {
      const members = await (ctx.conversation as any).members?.();
      if (Array.isArray(members)) {
        const member = members.find(
          (m: any) =>
            typeof m?.inboxId === "string" &&
            m.inboxId.toLowerCase() === senderInboxId.toLowerCase(),
        );
        const eth = member?.accountIdentifiers?.find(
          (id: any) =>
            id?.identifierKind === ETHEREUM_KIND &&
            typeof id?.identifier === "string" &&
            ETH_ADDRESS_RE.test(id.identifier),
        );
        if (eth?.identifier) return cache(eth.identifier);
      }
    } catch {
      // fall through
    }
  }

  return null;
}

export const sendReaction = async (
  ctx: MessageContext<string>,
  reaction: string = "👀",
): Promise<void> => {
  await ctx.conversation.send(
    {
      reference: ctx.message.id,
      referenceInboxId: ctx.message.senderInboxId,
      action: "added",
      content: reaction,
      schema: "unicode",
    } as Reaction,
    ContentTypeReaction,
  );
};

// Expand each configured handle into all the surface forms a user might type
// (bare, .base.eth, .eth). Critical: JS regex alternation is left-to-right,
// so we MUST sort longest-first — otherwise `askbasemate|askbasemate.base.eth`
// matches `askbasemate` and leaves an orphan `.base.eth` in the message, which
// the AI then mistakes for a Basename lookup.
const expandHandles = (raw: string): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (h: string) => {
    const key = h.toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(h);
  };
  for (const h of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const bare = h.replace(/\.(base\.)?eth$/i, "");
    push(`${bare}.base.eth`);
    push(`${bare}.eth`);
    push(bare);
  }
  return out.sort((a, b) => b.length - a.length);
};

const createMentionRegex = (): RegExp => {
  const alternatives = expandHandles(config.mentionHandle)
    .map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (!alternatives) return /(?!)/; // matches nothing if misconfigured
  return new RegExp(`(^|\\s)@\\s*(?:${alternatives})\\b`, "i");
};

const mentionRegex = createMentionRegex();

export const isMentioned = (text: string): boolean => mentionRegex.test(text);

export const removeMention = (text: string): string =>
  text.replace(new RegExp(mentionRegex.source, "gi"), " ").replace(/\s+/g, " ").trim();

async function rememberSend(
  ctx: MessageContext<any>,
  send: () => Promise<string>,
): Promise<void> {
  const messageId = await send();
  rememberAgentMessage(ctx.conversation.id, messageId);
}

export const PORTFOLIO_VIEW_LINK_LABEL = "View more details";

/** Markdown hyperlink for portfolio web view — avoids pasting raw signed URLs in chat. */
export function formatPortfolioViewMarkdown(
  url: string,
  label = PORTFOLIO_VIEW_LINK_LABEL,
): string {
  return `[${label}](${url})`;
}

/** Send plain text and remember the message id for reply-to-agent detection. */
export async function sendAgentText(ctx: MessageContext<any>, text: string): Promise<void> {
  await rememberSend(ctx, () => ctx.conversation.send(text));
}

/** Send as XMTP markdown when the client supports it (renders **bold**, rules, etc.). */
export async function sendMarkdownOrText(
  ctx: MessageContext<string>,
  text: string,
): Promise<void> {
  const safe = sanitizeXmptMarkdown(text);
  const sendMarkdown = (ctx as MessageContext<string> & { sendMarkdown?: (t: string) => Promise<void> })
    .sendMarkdown;
  if (typeof sendMarkdown === "function") {
    await rememberSend(ctx, () => ctx.conversation.send(safe, ContentTypeMarkdown));
    return;
  }
  await sendAgentText(ctx, safe);
}
