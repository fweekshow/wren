import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  isFusorWebhookDelivery,
  verifyPhotonWebhook,
  REPLAY_WINDOW_SEC,
  type SpectrumWebhookPayload,
} from "./webhook.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SECRET = "test-signing-secret-64-chars-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makeSignature(rawBody: string, secret: string, timestamp: string): string {
  return (
    "v0=" +
    createHmac("sha256", secret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex")
  );
}

function nowSec(): string {
  return String(Math.floor(Date.now() / 1000));
}

// ── verifyPhotonWebhook ───────────────────────────────────────────────────────

describe("verifyPhotonWebhook", () => {
  it("returns true for a valid signature with a fresh timestamp", () => {
    const body      = '{"event":"messages"}';
    const timestamp = nowSec();
    const sig       = makeSignature(body, SECRET, timestamp);

    expect(verifyPhotonWebhook(body, SECRET, sig, timestamp)).toBe(true);
  });

  it("returns false when signature is wrong", () => {
    const body      = '{"event":"messages"}';
    const timestamp = nowSec();
    // compute signature against a *different* body
    const sig = makeSignature("other body", SECRET, timestamp);

    expect(verifyPhotonWebhook(body, SECRET, sig, timestamp)).toBe(false);
  });

  it("returns false when the signing secret is wrong", () => {
    const body      = '{"event":"messages"}';
    const timestamp = nowSec();
    const sig       = makeSignature(body, "wrong-secret", timestamp);

    expect(verifyPhotonWebhook(body, SECRET, sig, timestamp)).toBe(false);
  });

  it("returns false when the timestamp is stale (older than REPLAY_WINDOW_SEC)", () => {
    const body      = '{"event":"messages"}';
    const staleTs   = String(Math.floor(Date.now() / 1000) - REPLAY_WINDOW_SEC - 1);
    const sig       = makeSignature(body, SECRET, staleTs);

    expect(verifyPhotonWebhook(body, SECRET, sig, staleTs)).toBe(false);
  });

  it("returns false when the timestamp is in the future beyond the window", () => {
    const body     = '{"event":"messages"}';
    const futureTs = String(Math.floor(Date.now() / 1000) + REPLAY_WINDOW_SEC + 1);
    const sig      = makeSignature(body, SECRET, futureTs);

    expect(verifyPhotonWebhook(body, SECRET, sig, futureTs)).toBe(false);
  });

  it("accepts a timestamp at the exact boundary (REPLAY_WINDOW_SEC ago)", () => {
    const body      = '{"event":"messages"}';
    const boundaryTs = String(Math.floor(Date.now() / 1000) - REPLAY_WINDOW_SEC);
    const sig        = makeSignature(body, SECRET, boundaryTs);

    expect(verifyPhotonWebhook(body, SECRET, sig, boundaryTs)).toBe(true);
  });

  it("returns false when signature header is missing", () => {
    const body      = '{"event":"messages"}';
    const timestamp = nowSec();

    expect(verifyPhotonWebhook(body, SECRET, undefined, timestamp)).toBe(false);
  });

  it("returns false when timestamp header is missing", () => {
    const body = '{"event":"messages"}';
    const sig  = makeSignature(body, SECRET, nowSec());

    expect(verifyPhotonWebhook(body, SECRET, sig, undefined)).toBe(false);
  });

  it("returns false when signingSecret is empty", () => {
    const body      = '{"event":"messages"}';
    const timestamp = nowSec();
    const sig       = makeSignature(body, SECRET, timestamp);

    expect(verifyPhotonWebhook(body, "", sig, timestamp)).toBe(false);
  });

  it("returns false for a non-numeric timestamp", () => {
    const body = '{"event":"messages"}';
    const sig  = makeSignature(body, SECRET, "not-a-number");

    expect(verifyPhotonWebhook(body, SECRET, sig, "not-a-number")).toBe(false);
  });

  it("detects body tampering — modifying even one byte fails verification", () => {
    const body      = '{"event":"messages","extra":"data"}';
    const timestamp = nowSec();
    const sig       = makeSignature(body, SECRET, timestamp);

    // Flip a character in the body
    const tampered = body.replace("messages", "MESSAGES");
    expect(verifyPhotonWebhook(tampered, SECRET, sig, timestamp)).toBe(false);
  });

  it("signature comparison is length-safe (no throw on different lengths)", () => {
    const body      = '{"event":"messages"}';
    const timestamp = nowSec();

    // A signature that is shorter than the expected 'v0=<64 hex chars>'
    expect(() =>
      verifyPhotonWebhook(body, SECRET, "v0=short", timestamp),
    ).not.toThrow();
    expect(verifyPhotonWebhook(body, SECRET, "v0=short", timestamp)).toBe(false);
  });
});

// ── Fusor fanout detection ────────────────────────────────────────────────────

describe("isFusorWebhookDelivery", () => {
  it("detects CloudEvents Fusor delivery headers", () => {
    expect(
      isFusorWebhookDelivery({
        "ce-type": "dev.spctrm.fusor.delivery",
        "ce-source": "//dev.spctrm.fusor/fanout-webhook/delivery",
        "content-type": "application/x-protobuf",
        "x-fusor-platform": "imessage",
      }),
    ).toBe(true);
  });

  it("detects protobuf content-type alone", () => {
    expect(
      isFusorWebhookDelivery({
        "content-type": "application/x-protobuf",
      }),
    ).toBe(true);
  });

  it("returns false for native Spectrum JSON webhook headers", () => {
    expect(
      isFusorWebhookDelivery({
        "content-type": "application/json",
        "user-agent": "spectrum-webhook/0.1.0",
        "x-spectrum-event": "messages",
        "x-spectrum-signature": "v0=abc",
        "x-spectrum-timestamp": "1710000000",
        "x-spectrum-webhook-id": "78aabfb1-221b-4d91-83ea-a0686f1924a1",
      }),
    ).toBe(false);
  });
});

// ── Payload shape narrowing (type-level smoke test) ───────────────────────────

describe("SpectrumWebhookPayload shape", () => {
  it("parses a canonical text delivery", () => {
    const raw = JSON.stringify({
      event: "messages",
      space: { id: "any;-;+15550100", platform: "iMessage", type: "dm", phone: "+15551234567" },
      message: {
        id: "spc-msg-00000000-0000-4000-8000-000000000001",
        platform: "iMessage",
        direction: "inbound",
        timestamp: "2026-05-14T19:06:32.000Z",
        sender: { id: "+15550100", platform: "iMessage" },
        space: { id: "any;-;+15550100", platform: "iMessage", type: "dm", phone: "+15551234567" },
        content: { type: "text", text: "hey, what time is dinner?" },
      },
    });

    const payload = JSON.parse(raw) as SpectrumWebhookPayload;

    expect(payload.event).toBe("messages");
    expect(payload.space.id).toBe("any;-;+15550100");
    expect(payload.message.direction).toBe("inbound");
    expect(payload.message.sender?.id).toBe("+15550100");

    if (payload.message.content.type === "text") {
      expect(payload.message.content.text).toBe("hey, what time is dinner?");
    } else {
      throw new Error("expected text content");
    }
  });

  it("parses a contact delivery", () => {
    const raw = JSON.stringify({
      event: "messages",
      space: { id: "any;-;+15550100", platform: "iMessage" },
      message: {
        id: "spc-msg-contact-001",
        platform: "iMessage",
        direction: "inbound",
        timestamp: "2026-05-14T20:00:00.000Z",
        sender: { id: "+15550100", platform: "iMessage" },
        space: { id: "any;-;+15550100", platform: "iMessage" },
        content: {
          type: "contact",
          name: { formatted: "Alice Smith", first: "Alice", last: "Smith" },
          phones: [{ value: "+15559876543" }],
        },
      },
    });

    const payload = JSON.parse(raw) as SpectrumWebhookPayload;

    if (payload.message.content.type === "contact") {
      const contact = payload.message.content;
      expect(contact.name?.formatted).toBe("Alice Smith");
      expect(contact.phones?.[0]?.value).toBe("+15559876543");
    } else {
      throw new Error("expected contact content");
    }
  });

  it("treats unknown content types gracefully via the fallback arm", () => {
    const raw = JSON.stringify({
      event: "messages",
      space: { id: "any;-;+15550100", platform: "iMessage" },
      message: {
        id: "spc-msg-unknown-001",
        platform: "iMessage",
        direction: "inbound",
        timestamp: "2026-05-14T20:00:00.000Z",
        sender: { id: "+15550100", platform: "iMessage" },
        space: { id: "any;-;+15550100", platform: "iMessage" },
        content: { type: "future_unknown_type", someField: 42 },
      },
    });

    const payload = JSON.parse(raw) as SpectrumWebhookPayload;
    // Should not throw — the fallback `{ type: string }` arm covers it
    expect(payload.message.content.type).toBe("future_unknown_type");
  });

  it("marks outbound messages as direction=inbound false (not processed by handler)", () => {
    const raw = JSON.stringify({
      event: "messages",
      space: { id: "any;-;+15550100", platform: "iMessage" },
      message: {
        id: "spc-msg-outbound-001",
        platform: "iMessage",
        direction: "outbound",
        timestamp: "2026-05-14T20:00:00.000Z",
        sender: undefined,
        space: { id: "any;-;+15550100", platform: "iMessage" },
        content: { type: "text", text: "bot reply" },
      },
    });

    const payload = JSON.parse(raw) as SpectrumWebhookPayload;
    expect(payload.message.direction).toBe("outbound");
  });
});
