import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acknowledgeInboundMessage,
  type ImessageAcknowledgementSpace,
} from "./acknowledgement.js";

const passthroughOutboundCall = async <T>(promise: Promise<T>): Promise<T> => promise;

function quietLogger() {
  return { warn: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("acknowledgeInboundMessage", () => {
  it("reacts with a like tapback when the inbound message is immediately available", async () => {
    const react = vi.fn(async () => undefined);
    const space: ImessageAcknowledgementSpace = {
      getMessage: vi.fn(async () => ({ react })),
    };

    const acknowledged = await acknowledgeInboundMessage(
      space,
      "msg-1",
      passthroughOutboundCall,
      { logger: quietLogger() },
    );

    expect(acknowledged).toBe(true);
    expect(space.getMessage).toHaveBeenCalledWith("msg-1");
    expect(react).toHaveBeenCalledWith("like");
  });

  it("retries message lookup before reacting", async () => {
    const react = vi.fn(async () => undefined);
    const sleep = vi.fn(async () => undefined);
    const space: ImessageAcknowledgementSpace = {
      getMessage: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ react }),
    };

    const acknowledged = await acknowledgeInboundMessage(
      space,
      "msg-2",
      passthroughOutboundCall,
      {
        attempts: 3,
        retryDelayMs: 0,
        sleep,
        logger: quietLogger(),
      },
    );

    expect(acknowledged).toBe(true);
    expect(space.getMessage).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(react).toHaveBeenCalledWith("like");
  });

  it("logs and returns false when the inbound message cannot be found", async () => {
    const logger = quietLogger();
    const sleep = vi.fn(async () => undefined);
    const space: ImessageAcknowledgementSpace = {
      getMessage: vi.fn(async () => undefined),
    };

    const acknowledged = await acknowledgeInboundMessage(
      space,
      "msg-3",
      passthroughOutboundCall,
      {
        attempts: 2,
        retryDelayMs: 0,
        sleep,
        logger,
      },
    );

    expect(acknowledged).toBe(false);
    expect(space.getMessage).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "⚠️ [iMessage] could not find inbound message msg-3 for tapback",
    );
  });

  it("logs and returns false when the tapback send fails", async () => {
    const logger = quietLogger();
    const err = new Error("tapback failed");
    const space: ImessageAcknowledgementSpace = {
      getMessage: vi.fn(async () => ({
        react: vi.fn(async () => {
          throw err;
        }),
      })),
    };

    await expect(
      acknowledgeInboundMessage(space, "msg-4", passthroughOutboundCall, { logger }),
    ).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "⚠️ [iMessage] failed to send acknowledgement tapback:",
      err,
    );
  });

  it("times out a hung tapback without using the outbound call wrapper", async () => {
    vi.useFakeTimers();
    const logger = quietLogger();
    const react = vi.fn(() => new Promise<unknown>(() => {}));
    const outboundCall = vi.fn(passthroughOutboundCall);
    const space: ImessageAcknowledgementSpace = {
      getMessage: vi.fn(async () => ({ react })),
    };

    const acknowledged = acknowledgeInboundMessage(space, "msg-5", outboundCall, {
      tapbackTimeoutMs: 100,
      logger,
    });

    await vi.advanceTimersByTimeAsync(100);

    await expect(acknowledged).resolves.toBe(false);
    expect(outboundCall).toHaveBeenCalledTimes(1);
    expect(outboundCall.mock.calls[0]?.[1]).toBe("Spectrum message lookup (msg-5)");
    expect(logger.warn).toHaveBeenCalledWith(
      "⚠️ [iMessage] failed to send acknowledgement tapback:",
      expect.objectContaining({
        message: "Spectrum tapback (msg-5) timed out after 100ms",
      }),
    );
  });
});
