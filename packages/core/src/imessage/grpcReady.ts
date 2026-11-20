/** grpc-js `connectivityState.READY` / `SHUTDOWN`. */
const GRPC_READY = 2;
const GRPC_SHUTDOWN = 4;

/** grpc-js Channel surface used by Photon's nice-grpc transport. */
export type GrpcChannel = {
  getConnectivityState: (tryToConnect?: boolean) => number;
  watchConnectivityState: (
    current: number,
    deadline: Date,
    callback: (err?: Error) => void,
  ) => void;
};

function isGrpcChannel(value: unknown): value is GrpcChannel {
  if (!value || typeof value !== "object") return false;
  const rec = value as Partial<GrpcChannel>;
  return (
    typeof rec.getConnectivityState === "function" &&
    typeof rec.watchConnectivityState === "function"
  );
}

function collectFrom(value: unknown, into: Set<GrpcChannel>, seen = new Set<unknown>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (isGrpcChannel(value)) {
    into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectFrom(entry, into, seen);
    return;
  }
  if (value instanceof Map) {
    for (const entry of value.values()) collectFrom(entry, into, seen);
    return;
  }
  const rec = value as {
    channel?: unknown;
    streamChannel?: unknown;
    client?: unknown;
    clients?: unknown;
    __internal?: unknown;
    platforms?: unknown;
  };
  if (isGrpcChannel(rec.channel)) into.add(rec.channel);
  if (isGrpcChannel(rec.streamChannel)) into.add(rec.streamChannel);
  if (rec.client && rec.client !== value) collectFrom(rec.client, into, seen);
  if (rec.clients && rec.clients !== value) collectFrom(rec.clients, into, seen);
  if (rec.__internal && rec.__internal !== value) collectFrom(rec.__internal, into, seen);
  if (rec.platforms && rec.platforms !== value) collectFrom(rec.platforms, into, seen);
}

/** Photon's AdvancedIMessage channels hanging off Spectrum's platform client list. */
export function imessageGrpcChannels(app: unknown): GrpcChannel[] {
  const found = new Set<GrpcChannel>();
  collectFrom(app, found);
  return [...found];
}

export async function waitForGrpcChannel(channel: GrpcChannel, timeoutMs: number): Promise<void> {
  const deadlineMs = Date.now() + Math.max(1, timeoutMs);
  const notReady = () => new Error("iMessage gRPC channel not ready");

  while (true) {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) throw notReady();
    const state = channel.getConnectivityState(true);
    if (state === GRPC_READY) return;
    if (state === GRPC_SHUTDOWN) {
      throw new Error("iMessage gRPC channel is shutdown");
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => finish(notReady()), remaining);
      channel.watchConnectivityState(state, new Date(deadlineMs), (err) => {
        finish(err ? notReady() : undefined);
      });
    });
  }
}

/**
 * Spectrum() resolves as soon as tokens are minted. `im.user` / DM `space`
 * are local object construction — the first real RPC is SendTextMessage,
 * which fail-fasts with UNAVAILABLE if the unary channel is not READY.
 */
export async function waitForImessageGrpc(app: unknown, timeoutMs = 15_000): Promise<void> {
  const channels = imessageGrpcChannels(app);
  if (channels.length === 0) return;
  await Promise.all(channels.map((channel) => waitForGrpcChannel(channel, timeoutMs)));
}
