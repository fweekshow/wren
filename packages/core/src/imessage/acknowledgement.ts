export type ImessageAcknowledgementMessage = {
  react: (reaction: string) => Promise<unknown>;
};

export type ImessageAcknowledgementSpace = {
  getMessage: (id: string) => Promise<ImessageAcknowledgementMessage | undefined>;
};

export type ImessageOutboundCall = <T>(promise: Promise<T>, label: string) => Promise<T>;

export type AcknowledgeInboundMessageOptions = {
  attempts?: number;
  retryDelayMs?: number;
  tapbackTimeoutMs?: number;
  logger?: Pick<Console, "warn">;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_LOOKUP_ATTEMPTS = 4;
const DEFAULT_LOOKUP_RETRY_DELAY_MS = 250;
const DEFAULT_TAPBACK_TIMEOUT_MS = 2_500;
const IMESSAGE_ACK_TAPBACK = "like";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

async function lookupInboundMessage(
  space: ImessageAcknowledgementSpace,
  messageId: string,
  outboundCall: ImessageOutboundCall,
  options: Required<Pick<AcknowledgeInboundMessageOptions, "attempts" | "retryDelayMs" | "sleep">>,
): Promise<ImessageAcknowledgementMessage | undefined> {
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const inbound = await outboundCall(
      space.getMessage(messageId),
      `Spectrum message lookup (${messageId})`,
    );
    if (inbound) return inbound;
    if (attempt < options.attempts) await options.sleep(options.retryDelayMs);
  }
  return undefined;
}

export async function acknowledgeInboundMessage(
  space: ImessageAcknowledgementSpace,
  messageId: string,
  outboundCall: ImessageOutboundCall,
  options: AcknowledgeInboundMessageOptions = {},
): Promise<boolean> {
  const logger = options.logger ?? console;
  const attempts = options.attempts ?? DEFAULT_LOOKUP_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_LOOKUP_RETRY_DELAY_MS;
  const tapbackTimeoutMs = options.tapbackTimeoutMs ?? DEFAULT_TAPBACK_TIMEOUT_MS;
  const delay = options.sleep ?? sleep;

  try {
    const inbound = await lookupInboundMessage(space, messageId, outboundCall, {
      attempts,
      retryDelayMs,
      sleep: delay,
    });
    if (!inbound) {
      logger.warn(`⚠️ [iMessage] could not find inbound message ${messageId} for tapback`);
      return false;
    }
    await withTimeout(
      inbound.react(IMESSAGE_ACK_TAPBACK),
      tapbackTimeoutMs,
      `Spectrum tapback (${messageId})`,
    );
    return true;
  } catch (err) {
    const e = err as Record<string, unknown>;
    const msg = err instanceof Error ? err.message : String(err);
    const isSilent =
      e?.code === "operationNotSupported" ||
      e?.grpcCode === 9 || e?.grpcCode === "9" ||    // SMS user — no iMessage reactions
      e?.grpcCode === 14 || e?.grpcCode === "14" ||  // transient Spectrum outage
      msg.includes("iMessage or RCS") ||
      msg.toLowerCase().includes("unavailable");
    if (!isSilent) {
      logger.warn("⚠️ [iMessage] failed to send acknowledgement tapback:", err);
    }
    return false;
  }
}
