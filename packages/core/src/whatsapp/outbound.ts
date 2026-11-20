import type { ImessageOutbound } from "@/imessage/outbound.js";

export type WhatsappOutbound = {
  text: string;
  previewUrl?: boolean;
};

function transactionFallbackText(chunk: Extract<ImessageOutbound, { kind: "transaction_miniapp" }>): string {
  return [
    chunk.label,
    "",
    chunk.cta ?? "tap to review & confirm:",
    "",
    chunk.url,
  ].join("\n");
}

export function renderWhatsappOutbound(chunk: ImessageOutbound): WhatsappOutbound[] {
  if (typeof chunk === "string") {
    const text = chunk.trim();
    return text ? [{ text, previewUrl: text.includes("https://") }] : [];
  }
  if (chunk.kind === "text_effect") {
    const text = chunk.text.trim();
    return text ? [{ text }] : [];
  }
  if (chunk.kind === "transaction_miniapp") {
    return [{ text: transactionFallbackText(chunk), previewUrl: true }];
  }
  if (chunk.kind === "dm") {
    // WhatsApp has no separate group/DM routing here — drop side-channel DMs.
    return [];
  }
  return [{ text: `${chunk.label}\n${chunk.url}`, previewUrl: true }];
}
