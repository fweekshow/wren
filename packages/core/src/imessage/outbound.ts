import { richlink } from "spectrum-ts";
import { customizedMiniApp, effect, imessage } from "spectrum-ts/providers/imessage";

import { type AIResponse } from "@/discovery/ai.js";
import { buildSignedPortfolioUrl } from "@/portfolio/access.js";

export const PORTFOLIO_VIEW_LINK_LABEL = "View more details";

export type ImessagePortfolioLink = {
  kind: "portfolio_link";
  label: string;
  url: string;
};

/** Plain text + URL in one iMessage bubble (no split rich-link sends). */
export type ImessageSingleBubbleText = {
  kind: "single_bubble_text";
  text: string;
};

export type ImessageTextEffect = {
  kind: "text_effect";
  text: string;
  effect: "confetti";
};

export type ImessageMiniAppMetadata = {
  appName: string;
  teamId: string;
  extensionBundleId: string;
  appStoreId?: number;
};

export type ImessageTransactionMiniApp = {
  kind: "transaction_miniapp";
  label: string;
  url: string;
  signerAddress?: string;
  summary?: string;
  cta?: string;
  metadata?: ImessageMiniAppMetadata;
};

/** Side-channel DM — not sent to the current reply space (e.g. group). */
export type ImessageDmText = {
  kind: "dm";
  phone: string;
  text: string;
};

export type ImessageOutbound =
  | string
  | ImessagePortfolioLink
  | ImessageSingleBubbleText
  | ImessageTextEffect
  | ImessageTransactionMiniApp
  | ImessageDmText;

export function singleBubbleTextOutbound(text: string): ImessageSingleBubbleText {
  return { kind: "single_bubble_text", text };
}

export function portfolioLinkOutbound(
  senderId: string,
  label = PORTFOLIO_VIEW_LINK_LABEL,
): ImessagePortfolioLink {
  return {
    kind: "portfolio_link",
    label,
    url: buildSignedPortfolioUrl(senderId),
  };
}

export function portfolioLinkFromUrl(
  url: string,
  label = PORTFOLIO_VIEW_LINK_LABEL,
): ImessagePortfolioLink {
  return { kind: "portfolio_link", label, url };
}

export function confettiTextOutbound(text: string): ImessageTextEffect {
  return { kind: "text_effect", text, effect: "confetti" };
}

export function dmTextOutbound(phone: string, text: string): ImessageDmText {
  return { kind: "dm", phone, text };
}

function hasMiniAppMetadata(
  metadata: ImessageMiniAppMetadata | undefined,
): metadata is ImessageMiniAppMetadata {
  return Boolean(
    metadata?.appName.trim() &&
      metadata.teamId.trim() &&
      metadata.extensionBundleId.trim(),
  );
}

function transactionFallbackText(chunk: ImessageTransactionMiniApp): string {
  return [
    chunk.label,
    chunk.cta ?? "tap to review & confirm:",
    chunk.url,
  ].join("\n");
}

const HTTP_URL_PATTERN = /https?:\/\/[^\s<]+/gi;
const TRAILING_URL_PUNCTUATION = /[),.!?;:\]}]+$/;

function splitTextAndRichLinks(text: string): Array<string | ReturnType<typeof richlink>> {
  const parts: Array<string | ReturnType<typeof richlink>> = [];
  let cursor = 0;

  for (const match of text.matchAll(HTTP_URL_PATTERN)) {
    const start = match.index;
    const matchedUrl = match[0];
    if (start == null || !matchedUrl) continue;

    const url = matchedUrl.replace(TRAILING_URL_PUNCTUATION, "");
    if (!url) continue;

    const leadingText = text.slice(cursor, start).trim();
    if (leadingText) parts.push(leadingText);
    parts.push(richlink(url));

    const trailingPunctuation = matchedUrl.slice(url.length);
    cursor = start + matchedUrl.length - trailingPunctuation.length;
  }

  const trailingText = text.slice(cursor).trim();
  if (trailingText) parts.push(trailingText);
  return parts;
}

async function sendTextWithRichLinks(
  send: (content: unknown) => Promise<unknown>,
  text: string,
): Promise<void> {
  if (!text.trim()) return;

  const parts = splitTextAndRichLinks(text);
  for (const part of parts) {
    await send(part);
  }
}

export function transactionMiniAppOutbound(args: {
  label: string;
  url: string;
  signerAddress?: string;
  summary?: string;
  cta?: string;
  metadata?: ImessageMiniAppMetadata;
}): ImessageTransactionMiniApp {
  return {
    kind: "transaction_miniapp",
    label: args.label,
    url: args.url,
    signerAddress: args.signerAddress,
    summary: args.summary,
    cta: args.cta,
    metadata: args.metadata,
  };
}

export function formatOutboundForRepl(chunk: ImessageOutbound): string {
  if (typeof chunk === "string") return chunk;
  if (chunk.kind === "single_bubble_text") return chunk.text;
  if (chunk.kind === "text_effect") return chunk.text;
  if (chunk.kind === "transaction_miniapp") return transactionFallbackText(chunk);
  if (chunk.kind === "dm") return chunk.text;
  return chunk.label;
}

function isUnsupportedTextEffectError(error: unknown): boolean {
  const details = error as { code?: unknown; grpcCode?: unknown };
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    details?.code === "operationNotSupported" ||
    details?.grpcCode === 9 ||
    details?.grpcCode === "9" ||
    message.includes("operation not supported") ||
    message.includes("imessage or rcs") ||
    message.includes("text effect") && message.includes("unsupported")
  );
}

// ── AI response rendering ─────────────────────────────────────────────────────

const MENU_BLURB =
  'think of me as your money mate right here in imessage 💙 send a friend cash ("send $20 to Alex", or share their contact card), add cash ("deposit $20"), earn on your USDC ("earn on USDC"), or check your balance ("balance"). what\'s the move?';

function appendPortfolioViewLink(
  chunks: ImessageOutbound[],
  portfolioViewUrl?: string,
): ImessageOutbound[] {
  if (!portfolioViewUrl) return chunks;
  return [...chunks, portfolioLinkFromUrl(portfolioViewUrl)];
}

/** iMessage renders no markdown — flatten bold/italic/headers/links to plain text. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}

/**
 * Map an AIResponse to one or more plain-text iMessage messages. Rich variants
 * are degraded to text (their inline buttons / wallet calls are dropped for the
 * text-only MVP, but free-form typing still drives the same wizards).
 */
export function renderAIResponseText(resp: AIResponse): ImessageOutbound[] {
  switch (resp.type) {
    case "menu":
      // When the model wrote its own answer (describe_capabilities, greetings),
      // show that alone — appending the generic blurb would duplicate it now that
      // both are short one-liners. Fall back to the blurb only when there's no
      // model-provided description (e.g. show_capabilities_menu).
      return [resp.description ? stripMarkdown(resp.description) : MENU_BLURB];

    case "communities": {
      const out  = [stripMarkdown(resp.text)];
      const list = resp.groups.map((g, i) => `${i + 1}. ${g.name}`).filter(Boolean);
      if (list.length) out.push(list.join("\n"));
      return out;
    }

    case "approve":
      return [`${stripMarkdown(resp.text)}\n\n${resp.approveUrl}`];

    case "transaction":
      return [
        `${stripMarkdown(resp.text)}\n\n(onchain signing isn't available over iMessage yet — i can't link a wallet here)`,
      ];

    case "wallet_info": {
      const out = [stripMarkdown(resp.text)];
      if (resp.address) out.push(resp.address);
      return appendPortfolioViewLink(out, resp.portfolioViewUrl);
    }

    case "withdraw_result":
      return [
        confettiTextOutbound(stripMarkdown(resp.text).split("\n")[0] ?? stripMarkdown(resp.text)),
      ];

    case "onramp_link": {
      const out = [stripMarkdown(resp.text), resp.url];
      if (resp.address) out.splice(1, 0, resp.address);
      return out;
    }

    case "offramp_link":
      return [`${stripMarkdown(resp.text)}\n\n${resp.url}`];

    case "disambiguate": {
      const options = resp.options.map((opt, i) => `${i + 1}. ${stripMarkdown(opt.label)}`);
      const suffix  = options.length
        ? `\n\n${options.join("\n")}\n\nReply with the number to select.`
        : "";
      return [`${stripMarkdown(resp.text)}${suffix}`];
    }

    case "amount_select": {
      const options = resp.presetsUsd.map((usd, i) => `#${i + 1}. $${usd}`);
      const suffix  = options.length
        ? `\n\n${options.join("\n")}\n\nReply with #1, #2, or #3 for a preset — or type your own amount (e.g. $3 or 3 USDC).`
        : "";
      return [`${stripMarkdown(resp.text)}${suffix}`];
    }

    // iMessage launches live on the standalone iStonks line. This arm only
    // fires if a launch_guide slipped past the handler redirect.
    case "launch_guide":
      return ["token launches moved to iStonks — open basemate.app/istonks/launch"];

    case "launches":
    case "markdown":
    case "perp_guide":
    case "tpsl_update_guide":
      return [stripMarkdown(resp.text)];

    case "text":
      return appendPortfolioViewLink([stripMarkdown(resp.text)], resp.portfolioViewUrl);

    default:
      return [MENU_BLURB];
  }
}

export async function sendImessageOutbound(
  send: (content: unknown) => Promise<unknown>,
  chunk: ImessageOutbound,
): Promise<void> {
  if (typeof chunk === "string") {
    await sendTextWithRichLinks(send, chunk);
    return;
  }
  if (chunk.kind === "single_bubble_text") {
    if (!chunk.text.trim()) return;
    await send(chunk.text);
    return;
  }
  if (chunk.kind === "dm") {
    // DMs must be routed by the caller (bot openDm) — not the reply-space send.
    throw new Error("imessage dm outbound must be delivered via openDm, not reply space");
  }
  if (chunk.kind === "text_effect") {
    if (!chunk.text.trim()) return;
    try {
      await send(effect(chunk.text, imessage.effect.message.confetti));
    } catch (error) {
      if (!isUnsupportedTextEffectError(error)) throw error;
      console.warn("⚠️ [iMessage] text effect unsupported, falling back to plain text:", error);
      await sendTextWithRichLinks(send, chunk.text);
    }
    return;
  }
  if (chunk.kind === "transaction_miniapp") {
    const fallback = transactionFallbackText(chunk);
    if (!hasMiniAppMetadata(chunk.metadata)) {
      await sendTextWithRichLinks(send, fallback);
      return;
    }
    try {
      await send(
        customizedMiniApp({
          appName: chunk.metadata.appName,
          extensionBundleId: chunk.metadata.extensionBundleId,
          teamId: chunk.metadata.teamId,
          ...(chunk.metadata.appStoreId ? { appStoreId: chunk.metadata.appStoreId } : {}),
          url: chunk.url,
          layout: {
            caption: chunk.label,
            subcaption: "Confirm with Basemate",
            summary: chunk.summary ?? chunk.label,
          },
        }),
      );
    } catch (err) {
      console.warn("⚠️ [iMessage] mini-app card send failed, falling back to direct link:", err);
      await sendTextWithRichLinks(send, fallback);
    }
    return;
  }
  await send(richlink(chunk.url));
}
