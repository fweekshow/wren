import type { LinkPlatform } from "./adapter.js";
import {
  extractConnectionToken,
  initiateLink,
  LINK_TOKEN_TTL_MS,
  redeemLink,
} from "./service.js";

const CONNECT_VERB_RE = /\b(connect|link|pair|sync)\b/i;
const CONNECT_TARGET_RE =
  /\b(account|base\s?app|tba|i-?message|other\s+(?:app|account|platform|wallet))\b/i;
const GENERATE_RE = /\bgenerate\b/i;
const CANCEL_RE = /^(cancel|nvm|never\s?mind|stop|abort|no)\b/i;

const PROMPT =
  "If you have a connection string, paste it after this. If not, say \"Generate\".";

export interface AccountLinkCommandInput {
  platform: LinkPlatform;
  userKey: string;
  walletAddress?: string | null;
  text: string;
  /** True when the user was previously asked to paste a string or say Generate. */
  awaitingConnection: boolean;
}

export type AccountLinkCommandResult =
  | { handled: false; clearPending?: boolean }
  | {
      handled: true;
      reply: string;
      /** Caller should remember the user is now awaiting a string / "Generate". */
      setPending?: boolean;
      /** Caller should forget any awaiting-connection state. */
      clearPending?: boolean;
      /** A successful link just completed (caller may prompt for follow-ups). */
      linked?: boolean;
    };

export function isAccountLinkConnectIntent(text: string): boolean {
  return CONNECT_VERB_RE.test(text) && CONNECT_TARGET_RE.test(text);
}

function otherPlatformLabel(platform: LinkPlatform): string {
  if (platform === "imessage") return "Base App";
  if (platform === "whatsapp") return "iMessage or Base App";
  if (platform === "telegram") return "Base App";
  return "iMessage";
}

function generatedReply(token: string): string {
  const minutes = Math.round(LINK_TOKEN_TTL_MS / 60000);
  return [
    "Here's your connection string — open your other app, start the connect flow there, and paste this in:",
    "",
    token,
    "",
    `It's valid for ${minutes} minutes and can only be used once.`,
  ].join("\n");
}

function redeemReply(
  result: Awaited<ReturnType<typeof redeemLink>>,
  platform: LinkPlatform,
): string {
  if (result.ok) {
    return [
      "Done — your accounts are now linked.",
      "Portfolio reviews and Avantis positions will combine both wallets from here on.",
    ].join(" ");
  }
  switch (result.reason) {
    case "expired":
      return "That connection string has expired. Generate a fresh one and paste it within 5 minutes.";
    case "consumed":
      return "That connection string was already used. Generate a new one to link again.";
    case "self":
      return `That string was generated on this same account. Generate it on your ${otherPlatformLabel(
        platform,
      )} and paste it here instead.`;
    default:
      return "I couldn't recognize that connection string. Double-check it, or say \"Generate\" to make a new one.";
  }
}

/**
 * Shared connection-string handshake handler used by both the iMessage handler
 * and the XMTP plugin. The caller owns the short-lived "awaiting connection"
 * state (an in-memory pending map) and applies setPending/clearPending.
 */
export async function handleAccountLinkCommand(
  input: AccountLinkCommandInput,
): Promise<AccountLinkCommandResult> {
  const text = input.text.trim();

  // A pasted token is always actionable, even outside the prompted flow.
  const token = extractConnectionToken(text);
  if (token) {
    const result = await redeemLink({
      token,
      redeemer: {
        platform: input.platform,
        userKey: input.userKey,
        wallet: input.walletAddress ?? null,
      },
    });
    return {
      handled: true,
      reply: redeemReply(result, input.platform),
      clearPending: true,
      linked: result.ok,
    };
  }

  if (input.awaitingConnection) {
    if (GENERATE_RE.test(text)) {
      const generated = await initiateLink({
        platform: input.platform,
        userKey: input.userKey,
        wallet: input.walletAddress ?? null,
      });
      return { handled: true, reply: generatedReply(generated), clearPending: true };
    }
    if (CANCEL_RE.test(text)) {
      return { handled: true, reply: "Okay, cancelled the connection.", clearPending: true };
    }
    // Unrecognized reply mid-flow — release the user back to the normal pipeline.
    return { handled: false, clearPending: true };
  }

  if (isAccountLinkConnectIntent(text)) {
    return { handled: true, reply: PROMPT, setPending: true };
  }

  return { handled: false };
}
