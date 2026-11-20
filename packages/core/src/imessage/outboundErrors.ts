function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return String(err);
}

function grpcCode(err: unknown): unknown {
  if (typeof err !== "object" || err === null) return undefined;
  const rec = err as Record<string, unknown>;
  return rec.grpcCode ?? rec.code;
}

/** Photon gRPC dropped / not ready — retry after a reconnect. */
export function isTransientOutboundError(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase();
  const code = grpcCode(err);

  return (
    code === 14 ||
    code === "14" ||
    code === "UNAVAILABLE" ||
    message.includes("unavailable") ||
    message.includes("no connection established") ||
    message.includes("protocol error") ||
    message.includes("h2 is not supported") ||
    message.includes("upstream connect error") ||
    message.includes("connection refused") ||
    message.includes("econnrefused") ||
    message.includes("disconnect/reset before headers")
  );
}

/**
 * Photon marks ConnectionError `retryable: false` even for UNAVAILABLE.
 * Only treat validation / empty-content failures as terminal.
 */
export function isNonRetryableSendError(err: unknown): boolean {
  if (isTransientOutboundError(err)) return false;

  const message = errorMessage(err).toLowerCase();
  const rec = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : undefined;
  const code = rec?.grpcCode ?? rec?.code;

  return (
    message.includes("content must be set") ||
    rec?.retryable === false ||
    code === 3 ||
    code === "3"
  );
}
