import { describe, expect, it } from "vitest";

import { isNonRetryableSendError, isTransientOutboundError } from "./outboundErrors.js";

const photonConnectionError = {
  name: "ConnectionError",
  message: "No connection established. Last error: null. Resolution note: ",
  retryable: false,
  grpcCode: 14,
  code: "internalError",
};

describe("isTransientOutboundError", () => {
  it("treats Photon's SendTextMessage UNAVAILABLE as transient", () => {
    expect(isTransientOutboundError(photonConnectionError)).toBe(true);
    expect(
      isTransientOutboundError({
        message: "No connection established. Last error: Protocol error",
        grpcCode: 14,
      }),
    ).toBe(true);
    expect(
      isTransientOutboundError({
        message:
          "No connection established. Last error: Protocol error (2026-09-12T07:48:57.405Z). Resolution note: ",
        retryable: false,
        grpcCode: 14,
        code: "internalError",
      }),
    ).toBe(true);
  });
});

describe("isNonRetryableSendError", () => {
  it("does not mark a dead gRPC channel as done", () => {
    expect(isNonRetryableSendError(photonConnectionError)).toBe(false);
  });

  it("still drops invalid payload errors", () => {
    expect(isNonRetryableSendError({ message: "content must be set", retryable: false })).toBe(
      true,
    );
  });
});
