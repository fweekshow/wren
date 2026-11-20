import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/**
 * Maximum age (in seconds) of a Spectrum webhook delivery timestamp before
 * it is rejected for replay protection. Matches Photon's recommended 5-minute window.
 */
export const REPLAY_WINDOW_SEC = 5 * 60;

/**
 * Photon's Fusor fanout also POSTs to the registered Spectrum webhook URL.
 * Those deliveries use a CloudEvents + protobuf envelope and omit the native
 * `X-Spectrum-*` headers our JSON path requires.
 *
 * Detect them so the HTTP route can ACK (200) instead of returning 400.
 * Inbound messages still arrive via the native JSON webhook and/or the SDK
 * stream pump; spectrum-ts 1.x cannot decode Fusor envelopes without a
 * Fusor-backed iMessage provider.
 */
export function isFusorWebhookDelivery(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
): boolean {
  const header = (name: string): string => {
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0] ?? "";
    return typeof value === "string" ? value : "";
  };

  const ceType = header("ce-type").toLowerCase();
  if (ceType.includes("spctrm.fusor") || ceType.includes("spectrum.fusor")) {
    return true;
  }

  if (header("x-fusor-platform")) return true;

  const contentType = header("content-type").toLowerCase();
  return (
    contentType.includes("application/x-protobuf") ||
    contentType.includes("application/protobuf")
  );
}

/**
 * Verify a Spectrum webhook delivery.
 *
 * Signature scheme: `v0=HMAC-SHA256(signingSecret, "v0:{timestamp}:{rawBody}")`
 *
 * Returns true only when:
 *  - signature and timestamp headers are present
 *  - the timestamp is within REPLAY_WINDOW_SEC of the current clock
 *  - the recomputed HMAC matches the header value (constant-time compare)
 *
 * The raw body MUST be the exact bytes that arrived on the wire — do not
 * parse and re-stringify before calling this function.
 */
export function verifyPhotonWebhook(
  rawBody: string,
  signingSecret: string,
  signature: string | undefined,
  timestamp: string | undefined,
): boolean {
  if (!signature || !timestamp || !signingSecret) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (age > REPLAY_WINDOW_SEC) return false;

  const expected =
    "v0=" +
    createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex");

  // timingSafeEqual requires equal-length buffers; length difference itself
  // reveals no secret information (the expected length is fixed), so comparing
  // lengths first is safe.
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Payload shape ─────────────────────────────────────────────────────────────

/**
 * The wire shape of a Spectrum `messages` webhook payload.
 * Function-typed SDK fields (send, react, reply …) are stripped by the
 * Spectrum worker before serialisation.
 */
export interface SpectrumWebhookPayload {
  event: "messages";
  space: {
    id: string;
    platform: string;
    type?: "dm" | "group";
    phone?: string;
    participants?: unknown[];
  };
  message: {
    id: string;
    platform: string;
    direction: "inbound" | "outbound";
    timestamp: string;
    sender?: { id: string; platform: string };
    space: {
      id: string;
      platform: string;
      type?: "dm" | "group";
      phone?: string;
    };
    content: SpectrumWebhookContent;
  };
}

export type SpectrumWebhookContent =
  | { type: "text"; text: string }
  | {
      type: "attachment";
      id: string;
      name: string;
      mimeType: string;
      size?: number;
    }
  | {
      type: "contact";
      name?: { formatted?: string; first?: string; last?: string };
      phones?: { value: string }[];
      emails?: { value: string }[];
    }
  | { type: "voice"; name?: string; mimeType: string; duration?: number; size?: number }
  | { type: "richlink"; url: string }
  | { type: "reaction"; emoji: string; target: { id: string } }
  | { type: "poll"; title: string; options: { title: string }[] }
  | { type: "poll_option"; title: string; selected: boolean }
  | { type: "group"; items: unknown[] }
  | { type: "custom"; raw: unknown }
  | { type: string };
